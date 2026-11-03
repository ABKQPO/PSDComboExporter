/**
 * Fit the blend formula of ONE layer: backdrop = engine render of everything
 * below it, target = merged image where nothing above it is drawn.
 *   node test/fitlayer-run.mjs <file.psd> <layer name>
 */

import { readFileSync } from 'node:fs';
import { decodeDocument, BLOCK, type EngineNode } from '../src/engine/doc';
import { render, authoredVisibility } from '../src/engine/composite';

const buf = readFileSync(process.argv[2]);
const name = process.argv[3];
const doc = await decodeDocument(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), { keepComposite: true });
const ref = doc.composite!;
const vis = authoredVisibility(doc);
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
const li = name.startsWith('#') ? Number(name.slice(1)) : leaves.findIndex((n) => n.name === name);
if (process.argv.includes('--list')) leaves.forEach((n, i) => console.log(`#${i} ${n.name} ${n.blendMode} ${n.opacity.toFixed(2)}${n.clipping ? ' clip' : ''}`));
if (li < 0) throw new Error('layer not found');
const target = leaves[li];
const below = new Set(leaves.slice(0, li).map((n) => n.id));
const above = leaves.slice(li + 1);
// render only the layers below (keep their groups visible)
const keep = (id: string) => {
  const n = doc.nodes.get(id)!;
  return n.kind === 'group' ? vis(id) : below.has(id);
};
const back = render(doc, 0, keep, { profile: (process.argv[4] as any) ?? 'photoshop' });
const px = (n: EngineNode, x: number, y: number) => {
  const b = L.layers.get(n.id)?.blocks[Math.floor(y / BLOCK) * L.bw + Math.floor(x / BLOCK)];
  if (!b) return null;
  const i = ((y % BLOCK) * BLOCK + (x % BLOCK)) * 4;
  return b[i + 3] ? b.subarray(i, i + 4) : null;
};
const S: { d: number[]; s: number[]; a: number; r: number[] }[] = [];
for (let y = 0; y < doc.height; y++)
  for (let x = 0; x < doc.width; x++) {
    const s = px(target, x, y);
    if (!s) continue;
    if (above.some((n) => px(n, x, y))) continue;
    const p = (y * doc.width + x) * 4;
    if (back.data[p + 3] !== 255 || ref[p + 3] !== 255) continue;
    S.push({ d: [back.data[p], back.data[p + 1], back.data[p + 2]], s: [s[0], s[1], s[2]], a: s[3], r: [ref[p], ref[p + 1], ref[p + 2]] });
  }
const o = target.opacity;
console.log(`${target.name}: mode ${target.blendMode}, opacity ${o.toFixed(3)}, ${S.length} samples`);

type F = (d: number, s: number, A: number) => number; // all 0..1, A = alpha × opacity
const hl = (d: number, s: number) => (s <= 0.5 ? 2 * d * s : 1 - 2 * (1 - d) * (1 - s));
const C: Record<string, F> = {
  'ps lerp: add': (d, s, A) => d + (Math.min(1, d + s) - d) * A,
  'additive: d + s·A': (d, s, A) => Math.min(1, d + s * A),
  'ps lerp: overlay': (d, s, A) => d + (hl(s, d) - d) * A,
  'ps lerp: soft light (W3C)': (d, s, A) => {
    const D = d <= 0.25 ? ((16 * d - 12) * d + 4) * d : Math.sqrt(d);
    const B = s <= 0.5 ? d - (1 - 2 * s) * d * (1 - d) : d + (2 * s - 1) * (D - d);
    return d + (B - d) * A;
  },
  'ps lerp: soft light (pegtop)': (d, s, A) => d + ((1 - 2 * s) * d * d + 2 * s * d - d) * A,
  'ps lerp: hard light': (d, s, A) => d + (hl(d, s) - d) * A,
  'overlay on premultiplied src': (d, s, A) => {
    const sp = s * A;
    return hl(sp + (1 - A) * 0.5, d) * A + d * (1 - A);
  },
  'overlay, src blended over 50% grey first': (d, s, A) => hl(s * A + 0.5 * (1 - A), d),
  'ps lerp: screen': (d, s, A) => d + (1 - (1 - d) * (1 - s) - d) * A,
  'ps lerp: normal': (d, s, A) => d + (s - d) * A,
  'ps lerp: multiply': (d, s, A) => d + (d * s - d) * A,
  'multiply, src premultiplied over white': (d, s, A) => d * (s * A + (1 - A)),
};
const res: [string, number, number][] = [];
for (const [k, f] of Object.entries(C)) {
  let bad = 0;
  let err = 0;
  for (const t of S) {
    const A = (t.a / 255) * o;
    let miss = false;
    for (let c = 0; c < 3; c++) {
      const v = Math.round(Math.max(0, Math.min(1, f(t.d[c] / 255, t.s[c] / 255, A))) * 255);
      err += Math.abs(v - t.r[c]);
      if (v !== t.r[c]) miss = true;
    }
    if (miss) bad++;
  }
  res.push([k, bad / S.length, err / (S.length * 3)]);
}
res.sort((a, b) => a[2] - b[2]);
for (const [k, bad, err] of res) console.log(`  mean err ${err.toFixed(3).padStart(7)}  miss ${(bad * 100).toFixed(1).padStart(5)}%  ${k}`);
