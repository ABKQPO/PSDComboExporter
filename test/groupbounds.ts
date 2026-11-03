/**
 * A/B check: tight group tile ranges (+ tile reuse) must render exactly like
 * the previous rule, on random visibility sets of a real document.
 *   node test/groupbounds-run.mjs <file.psd|ipv> [count]
 */
import { readFileSync } from 'node:fs';
import { decodeDocument } from '../src/engine/doc';
import { decodeIpv, isIpv } from '../src/engine/ipv';
import { render, renderCached, authoredVisibility, type TileCache } from '../src/engine/composite';
import { calibrate } from '../src/engine/calibrate';

const [file, countArg = '24'] = process.argv.slice(2);
const buf = readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const doc = isIpv(ab) ? await decodeIpv(ab, { keepComposite: true }) : await decodeDocument(ab, { keepComposite: true });
const profile = calibrate(doc).profile;
const all = [...doc.nodes.values()];
const groups = all.filter((n) => n.kind === 'group');
const authored = authoredVisibility(doc);
const base = new Set(all.filter((x) => authored(x.id)).map((x) => x.id));
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);

let same = 0;
let reusedSum = 0;
let tilesSum = 0;
let cache: TileCache | null = null;
let tOld = 0;
let tNew = 0;
const n = Number(countArg);
for (let k = 0; k < n; k++) {
  // flip a few groups / layers relative to the saved visibility
  const on = new Set(base);
  const flips = 1 + Math.floor(rnd() * 4);
  for (let f = 0; f < flips; f++) {
    const pool = rnd() < 0.7 && groups.length ? groups : all;
    const node = pool[Math.floor(rnd() * pool.length)];
    if (on.has(node.id)) on.delete(node.id);
    else on.add(node.id);
  }
  const vis = (id: string) => on.has(id);
  let t = performance.now();
  const a = render(doc, 0, vis, { profile, legacyGroupBounds: true });
  tOld += performance.now() - t;
  t = performance.now();
  const r = renderCached(doc, 0, vis, { profile }, cache, profile);
  tNew += performance.now() - t;
  cache = r.cache;
  reusedSum += r.reused;
  tilesSum += r.cache.keys.length;
  let eq = a.data.length === r.result.data.length && a.opaque === r.result.opaque;
  for (let i = 0; eq && i < a.data.length; i++) if (a.data[i] !== r.result.data[i]) eq = false;
  if (eq) same++;
  else console.log(`  DIFFERENT render #${k}`);
}
console.log(
  `${file.split(/[\/]/).pop()}: ${same}/${n} identical, tiles reused ${((100 * reusedSum) / tilesSum).toFixed(0)}%, ` +
    `old ${(tOld / n).toFixed(0)} ms -> new ${(tNew / n).toFixed(0)} ms per full render`,
);
process.exit(same === n ? 0 : 1);
