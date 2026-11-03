/**
 * Fit ibisPaint blend mode numbers against the merged images stored in real
 * .ipv files. For each code, the blocks its layers touch are re-rendered with
 * every candidate mode; the mode with the smallest difference wins. Files are
 * decoded one at a time and results stream as they come.
 *   node test/ipv-blend-run.mjs <dir> [maxFilesPerCode]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeIpv, IPV_BLEND } from '../src/engine/ipv';
import { renderBlocks, authoredVisibility } from '../src/engine/composite';
import { pixelDiff } from '../src/engine/compare';
import { BLOCK } from '../src/engine/doc';

const dir = process.argv[2];
const perCode = Number(process.argv[3] ?? 2);
/** codes already settled, passed as --skip=1,2,5 */
const skip = new Set((process.argv.find((a) => a.startsWith('--skip=')) ?? '--skip=').slice(7).split(',').filter(Boolean));
const CANDIDATES = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color dodge', 'color burn', 'linear dodge', 'linear burn',
  'soft light', 'hard light', 'vivid light', 'linear light', 'pin light', 'hard mix', 'difference', 'exclusion', 'subtract',
  'divide', 'hue', 'saturation', 'color', 'luminosity', 'darker color', 'lighter color',
  'linear dodge (special)', 'color dodge (special)', 'linear burn (special)', 'color burn (special)', 'linear light (special)',
  'vivid light (special)', 'hard mix (special)', 'difference (special)',
];
const seen = new Map<string, number>(); // "layer:code" / "folder:code" -> files used
const totals = new Map<string, Map<string, number>>();
for (const f of readdirSync(dir).filter((x) => x.endsWith('.ipv'))) {
  const buf = readFileSync(join(dir, f));
  let doc;
  try {
    doc = await decodeIpv(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), { keepComposite: true });
  } catch (e) {
    console.log(`skip ${f}: ${(e as Error).message}`);
    continue;
  }
  if (!doc.composite) continue;
  const level = doc.levels[0];
  const vis = authoredVisibility(doc);
  // only nodes that are actually drawn: visible themselves and every ancestor visible
  const parentOf = new Map<string, string>();
  for (const n of doc.nodes.values()) for (const c of n.children) parentOf.set(c.id, n.id);
  const drawn = (id: string): boolean => {
    for (let cur: string | undefined = id; cur; cur = parentOf.get(cur)) if (doc.nodes.get(cur)!.hidden) return false;
    return true;
  };
  const nodes = [...doc.nodes.values()].filter((n) => n.bbox && n.sourceBlendCode !== undefined && n.sourceBlendCode !== 0 && drawn(n.id));
  const keys = new Set(nodes.map((n) => `${n.kind === 'group' ? 'folder' : 'layer'}:${n.sourceBlendCode}`));
  for (const key of keys) {
    if ((seen.get(key) ?? 0) >= perCode || skip.has(key)) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    const [kind, codeS] = key.split(':');
    const targets = nodes.filter((n) => `${n.kind === 'group' ? 'folder' : 'layer'}:${n.sourceBlendCode}` === key);
    const blocks = new Set<number>();
    const mark = (n: typeof targets[0]) => {
      if (n.kind === 'group') n.children.forEach(mark);
      else level.layers.get(n.id)?.blocks.forEach((b, i) => b && blocks.add(i));
    };
    targets.forEach(mark);
    // isolate: drop blocks also touched by layers whose code is still unknown
    const unknownOthers = [...doc.nodes.values()].filter(
      (n) => n.kind === 'layer' && drawn(n.id) && n.sourceBlendCode !== Number(codeS) && n.sourceBlendCode !== 1 && !IPV_BLEND[n.sourceBlendCode ?? 0],
    );
    for (const n of unknownOthers) level.layers.get(n.id)?.blocks.forEach((b, i) => b && blocks.delete(i));
    const all = [...blocks];
    if (!all.length) {
      seen.set(key, seen.get(key)! - 1);
      continue;
    }
    const picked = all.length <= 120 ? all : all.filter((_, i) => i % Math.ceil(all.length / 120) === 0);
    const orig = targets.map((n) => [n.blendMode, n.special] as const);
    const t = totals.get(key) ?? new Map<string, number>();
    const px = new Uint8ClampedArray(4);
    for (const cand of CANDIDATES) {
      if (kind === 'folder' && cand.includes('special')) continue;
      targets.forEach((n) => {
        n.blendMode = cand.replace(' (special)', '');
        n.special = cand.endsWith('(special)');
      });
      const tiles = renderBlocks(doc, picked, vis, { profile: 'photoshop' });
      let sum = 0;
      let cnt = 0;
      picked.forEach((bi, k) => {
        const bx = bi % level.bw;
        const by = (bi - bx) / level.bw;
        for (let y = 0; y < Math.min(BLOCK, level.height - by * BLOCK); y++)
          for (let x = 0; x < Math.min(BLOCK, level.width - bx * BLOCK); x++) {
            const r = ((by * BLOCK + y) * level.width + bx * BLOCK + x) * 4;
            px.set(doc.composite!.subarray(r, r + 4));
            sum += pixelDiff(tiles[k].subarray((y * BLOCK + x) * 4, (y * BLOCK + x) * 4 + 4), px, 0);
            cnt++;
          }
      });
      t.set(cand, (t.get(cand) ?? 0) + sum / Math.max(1, cnt));
    }
    targets.forEach((n, i) => {
      n.blendMode = orig[i][0];
      n.special = orig[i][1];
    });
    totals.set(key, t);
    const ranked = [...t.entries()].sort((a, b) => a[1] - b[1]);
    // no discriminating power (layer fully covered etc.): don't count this file
    if (ranked[ranked.length - 1][1] - ranked[0][1] < 0.02 * seen.get(key)!) {
      seen.set(key, seen.get(key)! - 1);
      if (seen.get(key) === 0) totals.delete(key);
      continue;
    }
    const cur = IPV_BLEND[Number(codeS)];
    console.log(`${key.padEnd(10)} ${f.slice(0, 16).padEnd(16)} best: ${ranked.slice(0, 3).map(([k, v]) => `${k} ${(v / seen.get(key)!).toFixed(3)}`).join(' | ')}${cur ? `   (table: ${cur})` : ''}`);
  }
}
