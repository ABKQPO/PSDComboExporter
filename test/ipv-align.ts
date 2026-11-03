/**
 * Joint alignment of ALL ibisPaint blend numbers (coordinate descent).
 * Each pass decodes every file once; for every code present it re-renders the
 * blocks that code's layers touch with each candidate mode, while all other
 * codes use the current table. Per code the candidate with the lowest total
 * error over all files wins. Repeats until the table stops changing.
 *   node test/ipv-align-run.mjs <dir> [passes]   -> test-out/ipv-align.json
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeIpv, IPV_BLEND } from '../src/engine/ipv';
import { renderBlocks, authoredVisibility } from '../src/engine/composite';
import { pixelDiff } from '../src/engine/compare';
import { BLOCK, type EngineDoc, type EngineNode } from '../src/engine/doc';

const dir = process.argv[2];
const passes = Number(process.argv[3] ?? 3);
const MODES = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color dodge', 'color burn', 'linear dodge', 'linear burn',
  'soft light', 'hard light', 'vivid light', 'linear light', 'pin light', 'hard mix', 'difference', 'exclusion', 'subtract',
  'divide', 'hue', 'saturation', 'color', 'luminosity', 'darker color', 'lighter color',
];
const SPECIAL = ['linear dodge', 'color dodge', 'linear burn', 'color burn', 'linear light', 'vivid light', 'hard mix', 'difference'].map((m) => `${m} (special)`);
const CANDIDATES = [...MODES, ...SPECIAL];

/** current table: code -> candidate (special variants included); code 1 = additive add */
const table = new Map<number, string>();
for (const [k, v] of Object.entries(IPV_BLEND)) table.set(Number(k), v);
table.set(1, 'linear dodge (special)');

const apply = (n: EngineNode, cand: string) => {
  n.special = n.kind === 'layer' && cand.endsWith('(special)');
  n.blendMode = cand.replace(' (special)', '');
};

const files = readdirSync(dir).filter((f) => f.endsWith('.ipv'));
// skip files whose merged image is known to be stale (third-party watermark injection)
const stale = (doc: EngineDoc) => [...doc.nodes.values()].some((n) => /HEX加码|仅可QQ|趣绮梦/.test(n.name) && !n.hidden);

for (let pass = 1; pass <= passes; pass++) {
  const totals = new Map<number, Map<string, number>>(); // code -> cand -> error sum
  const weight = new Map<number, number>();
  for (const f of files) {
    let doc: EngineDoc;
    try {
      const buf = readFileSync(join(dir, f));
      doc = await decodeIpv(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), { keepComposite: true });
    } catch {
      continue;
    }
    if (!doc.composite || stale(doc)) continue;
    const level = doc.levels[0];
    const vis = authoredVisibility(doc);
    const parentOf = new Map<string, string>();
    for (const n of doc.nodes.values()) for (const c of n.children) parentOf.set(c.id, n.id);
    const drawn = (id: string) => {
      for (let cur: string | undefined = id; cur; cur = parentOf.get(cur)) if (doc.nodes.get(cur)!.hidden) return false;
      return true;
    };
    const nodes = [...doc.nodes.values()].filter((n) => n.bbox && n.sourceBlendCode !== undefined && drawn(n.id));
    // everyone uses the current table
    for (const n of nodes) {
      const c = n.sourceBlendCode!;
      if (c !== 0) apply(n, table.get(c) ?? 'normal');
    }
    const codes = new Set(nodes.map((n) => n.sourceBlendCode!).filter((c) => c !== 0));
    for (const code of codes) {
      const targets = nodes.filter((n) => n.sourceBlendCode === code);
      const blocks = new Set<number>();
      const mark = (n: EngineNode) => {
        if (n.kind === 'group') n.children.forEach(mark);
        else level.layers.get(n.id)?.blocks.forEach((b, i) => b && blocks.add(i));
      };
      targets.forEach(mark);
      const all = [...blocks];
      const picked = all.length <= 100 ? all : all.filter((_, i) => i % Math.ceil(all.length / 100) === 0);
      const errs = new Map<string, number>();
      const px = new Uint8ClampedArray(4);
      for (const cand of CANDIDATES) {
        if (targets.every((t) => t.kind === 'group') && cand.endsWith('(special)')) continue;
        targets.forEach((t) => apply(t, cand));
        const tiles = renderBlocks(doc, picked, vis, { profile: 'photoshop' });
        let sum = 0;
        let cnt = 0;
        picked.forEach((bi, k) => {
          const bx = bi % level.bw;
          const by = (bi - bx) / level.bw;
          for (let y = 0; y < Math.min(BLOCK, level.height - by * BLOCK); y += 2)
            for (let x = 0; x < Math.min(BLOCK, level.width - bx * BLOCK); x += 2) {
              const r = ((by * BLOCK + y) * level.width + bx * BLOCK + x) * 4;
              px.set(doc.composite!.subarray(r, r + 4));
              sum += pixelDiff(tiles[k].subarray((y * BLOCK + x) * 4, (y * BLOCK + x) * 4 + 4), px, 0);
              cnt++;
            }
        });
        errs.set(cand, cnt ? sum / cnt : 0);
      }
      targets.forEach((t) => apply(t, table.get(code) ?? 'normal'));
      const vals = [...errs.values()];
      if (Math.max(...vals) - Math.min(...vals) < 0.02) continue; // no discriminating power here
      const t = totals.get(code) ?? new Map<string, number>();
      for (const [k, v] of errs) t.set(k, (t.get(k) ?? 0) + v);
      totals.set(code, t);
      weight.set(code, (weight.get(code) ?? 0) + 1);
    }
  }
  let changed = 0;
  const lines: string[] = [];
  for (const [code, t] of [...totals.entries()].sort((a, b) => a[0] - b[0])) {
    const ranked = [...t.entries()].sort((a, b) => a[1] - b[1]);
    const w = weight.get(code)!;
    const best = ranked[0][0];
    const margin = (ranked[1][1] - ranked[0][1]) / w;
    if (table.get(code) !== best) changed++;
    table.set(code, best);
    lines.push(`  ${String(code).padStart(2)} -> ${best.padEnd(24)} files ${String(w).padStart(2)}  err ${(ranked[0][1] / w).toFixed(3)}  runner-up ${ranked[1][0]} (+${margin.toFixed(3)})`);
  }
  console.log(`pass ${pass}: ${changed} code(s) changed`);
  for (const l of lines) console.log(l);
  writeFileSync('test-out/ipv-align.json', JSON.stringify(Object.fromEntries(table), null, 1));
  if (!changed && pass > 1) break;
}
