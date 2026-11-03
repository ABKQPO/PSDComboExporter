/**
 * Where do the big differences come from? For pixels whose difference to the
 * merged image is ≥ threshold, count the non-trivial layers covering them
 * (blend mode ≠ normal, opacity < 100 %, clipping, special).
 *   node test/where-run.mjs <file.psd> [threshold]
 */

import { readFileSync } from 'node:fs';
import { decodeDocument, BLOCK, type EngineNode } from '../src/engine/doc';
import { decodeIpv } from '../src/engine/ipv';
import { render, authoredVisibility } from '../src/engine/composite';
import { pixelDiff } from '../src/engine/compare';

const buf = readFileSync(process.argv[2]);
const thr = Number(process.argv[3] ?? 4);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const doc = await (/\.ipv$/i.test(process.argv[2]) ? decodeIpv : decodeDocument)(ab, { keepComposite: true });
const ref = doc.composite!;
const vis = authoredVisibility(doc);
const img = render(doc, 0, vis);
const L = doc.levels[0];
const leaves: EngineNode[] = [];
const walk = (list: EngineNode[], on: boolean) => {
  for (const n of list) {
    const v = on && vis(n.id);
    if (n.kind === 'group') walk(n.children, v);
    else if (v && n.bbox) leaves.push(n);
  }
};
walk(doc.roots, true);
const alpha = (n: EngineNode, x: number, y: number) => {
  const b = L.layers.get(n.id)?.blocks[Math.floor(y / BLOCK) * L.bw + Math.floor(x / BLOCK)];
  return b ? b[((y % BLOCK) * BLOCK + (x % BLOCK)) * 4 + 3] : 0;
};
const label = (n: EngineNode) =>
  `${n.name}[${n.sourceBlendCode !== undefined ? '#' + n.sourceBlendCode + ' ' : ''}${n.blendMode}${n.opacity < 0.999 ? ' ' + Math.round(n.opacity * 100) + '%' : ''}${n.clipping ? ' clip' : ''}${n.special ? ' tsly0' : ''}${n.fill < 0.999 ? ' fill' + Math.round(n.fill * 100) : ''}]`;
const counts = new Map<string, number>();
let big = 0;
for (let y = 0; y < doc.height; y += 2)
  for (let x = 0; x < doc.width; x += 2) {
    const p = (y * doc.width + x) * 4;
    if (pixelDiff(img.data, ref, p) < thr) continue;
    big++;
    const cover = leaves.filter((n) => alpha(n, x, y) && (n.blendMode !== 'normal' || n.opacity < 0.999 || n.clipping || n.special));
    const key = cover.length ? cover.slice(-2).map(label).join(' > ') : '(only normal 100% layers)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
console.log(`pixels with diff ≥ ${thr}: ${big * 4} (sampled every 2nd px)`);
for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${String(v * 4).padStart(8)}  ${k}`);
