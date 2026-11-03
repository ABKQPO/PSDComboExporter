/**
 * Exhaustive search for a painting app's NORMAL-mode arithmetic:
 *   out = Q3( Q1(Cd·(K−A)) / K + Q2(Cs·A) / K )   or   Q3((Cd·(K−A) + Cs·A) / K)
 * with internal scale K, A derived from the 8-bit alpha in several ways and
 * floor / ceil / round at each step.
 *   node test/fit-run.mjs (bundles this file when passed --normal)
 */

import { readFileSync } from 'node:fs';
import { decodeDocument, BLOCK, type EngineNode } from '../src/engine/doc';
import { authoredVisibility } from '../src/engine/composite';

const buf = readFileSync(process.argv[2]);
const doc = await decodeDocument(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), { keepComposite: true });
const ref = doc.composite!;
const vis = authoredVisibility(doc);
const L = doc.levels[0];
const W = doc.width;
const leaves: EngineNode[] = [];
const walk = (list: EngineNode[], on: boolean) => {
  for (const n of list) {
    const v = on && vis(n.id);
    if (n.kind === 'group') walk(n.children, v);
    else if (v && n.bbox) leaves.push(n);
  }
};
walk(doc.roots, true);
const px = (n: EngineNode, x: number, y: number) => {
  const b = L.layers.get(n.id)?.blocks[Math.floor(y / BLOCK) * L.bw + Math.floor(x / BLOCK)];
  if (!b) return null;
  const i = ((y % BLOCK) * BLOCK + (x % BLOCK)) * 4;
  return b[i + 3] ? b.subarray(i, i + 4) : null;
};

const S: { d: number; s: number; a: number; r: number }[] = [];
for (let li = 1; li < leaves.length && S.length < 30000; li++) {
  const top = leaves[li];
  if (top.blendMode !== 'normal' || top.clipping || top.opacity < 0.999 || top.parentId) continue;
  const [x0, y0, x1, y1] = top.bbox!;
  for (let y = y0; y < y1 && S.length < 30000; y++)
    for (let x = x0; x < x1 && S.length < 30000; x++) {
      const s = px(top, x, y);
      if (!s || s[3] === 255) continue;
      if (leaves.slice(li + 1).some((n) => px(n, x, y))) continue;
      const under = leaves.slice(0, li).filter((n) => px(n, x, y));
      if (under.length !== 1) continue;
      const u = under[0];
      const up = px(u, x, y)!;
      if (up[3] !== 255 || u.blendMode !== 'normal' || u.opacity < 0.999 || u.clipping) continue;
      const p = (y * W + x) * 4;
      if (ref[p + 3] !== 255) continue;
      for (let c = 0; c < 3; c++) S.push({ d: up[c], s: s[c], a: s[3], r: ref[p + c] });
    }
}
console.log('channel samples', S.length);
if (S.length < 100) process.exit(0);

const Q: Record<string, (v: number) => number> = { f: Math.floor, c: Math.ceil, r: Math.round, x: (v) => v };
const KS: Record<string, number> = { '255': 255, '256': 256, '1024': 1024, '4096': 4096, '16384': 16384, '32768': 32768, '65535': 65535, '65536': 65536 };
const AS: Record<string, (a: number, K: number) => number> = {
  scale: (a, K) => (a * K) / 255,
  scaleR: (a, K) => Math.round((a * K) / 255),
  scaleF: (a, K) => Math.floor((a * K) / 255),
  scaleC: (a, K) => Math.ceil((a * K) / 255),
  plus1: (a, K) => ((a + 1) * K) / 256,
  plusHalf: (a, K) => (a + (a >> 7)) * (K / 256),
};
const res: [string, number][] = [];
for (const [kn, K] of Object.entries(KS))
  for (const [an, af] of Object.entries(AS))
    for (const [q1n, q1] of Object.entries(Q))
      for (const [q2n, q2] of Object.entries(Q))
        for (const [q3n, q3] of Object.entries(Q)) {
          if (q3n === 'x') continue;
          let bad = 0;
          for (const t of S) {
            const A = af(t.a, K);
            // values scaled to K first (color in K units), then back to 8 bits
            const cd = (t.d * K) / 255;
            const cs = (t.s * K) / 255;
            const v = q1((cd * (K - A)) / K) + q2((cs * A) / K);
            if (q3((v * 255) / K) !== t.r) bad++;
          }
          res.push([`K=${kn} A=${an} terms:${q1n}${q2n} out:${q3n}`, bad / S.length]);
        }
res.sort((a, b) => a[1] - b[1]);
for (const [k, v] of res.slice(0, 6)) console.log(`  ${(v * 100).toFixed(3).padStart(7)}%  ${k}`);

// form 2: out = Cd − T1(Cd·a) + T2(Cs·a), with T = integer "/255" approximations
const T: Record<string, (v: number) => number> = {
  f255: (v) => Math.floor(v / 255),
  c255: (v) => Math.ceil(v / 255),
  r255: (v) => Math.round(v / 255),
  shr8: (v) => v >> 8,
  shr8r: (v) => (v + 128) >> 8,
  ps: (v) => { const t = v + 128; return (t + (t >> 8)) >> 8; },
  shr8p: (v) => (v + (v >> 8)) >> 8,
  shr8p1: (v) => (v + (v >> 8) + 1) >> 8,
  c256: (v) => Math.ceil(v / 256),
};
const AA: Record<string, (a: number) => number> = { a: (a) => a, a1: (a) => a + 1, ah: (a) => a + (a >> 7) };
const res2: [string, number][] = [];
for (const [an, af] of Object.entries(AA))
  for (const [t1n, t1] of Object.entries(T))
    for (const [t2n, t2] of Object.entries(T)) {
      let bad = 0;
      for (const t of S) {
        const A = af(t.a);
        const v = Math.max(0, Math.min(255, t.d - t1(t.d * A) + t2(t.s * A)));
        if (v !== t.r) bad++;
      }
      res2.push([`Cd - ${t1n}(Cd*${an}) + ${t2n}(Cs*${an})`, bad / S.length]);
    }
res2.sort((a, b) => a[1] - b[1]);
console.log('form 2:');
for (const [k, v] of res2.slice(0, 5)) console.log(`  ${(v * 100).toFixed(3).padStart(7)}%  ${k}`);

// error rate of the float-exact formula by alpha bucket; and whether the stored
// colour looks like an un-premultiplied value (Cs·a/255 close to an integer)
{
  const buckets = new Map<number, [number, number, number]>();
  for (const t of S) {
    const exact = t.d + ((t.s - t.d) * t.a) / 255;
    const b = Math.min(7, t.a >> 5);
    const e = buckets.get(b) ?? [0, 0, 0];
    e[0]++;
    if (Math.round(exact) !== t.r) e[1]++;
    const p = (t.s * t.a) / 255;
    if (Math.abs(p - Math.round(p)) < 0.02) e[2]++;
    buckets.set(b, e);
  }
  console.log('alpha bucket: n, float-exact miss %, colour·a/255 ~integer %');
  for (const [b, [n, miss, intish]] of [...buckets.entries()].sort((x, y) => x[0] - y[0]))
    console.log(`  a ${String(b * 32).padStart(3)}-${b * 32 + 31}: n=${String(n).padStart(6)}  miss ${((100 * miss) / n).toFixed(1).padStart(5)}%  premul-int ${((100 * intish) / n).toFixed(1).padStart(5)}%`);
}

// opaque top pixels: the merged image must equal the layer colour
{
  let n = 0, miss = 0, maxd = 0;
  const hist: Record<string, number> = {};
  for (let y = 0; y < doc.height; y += 2)
    for (let x = 0; x < W; x += 2) {
      let top: EngineNode | null = null;
      for (let i = leaves.length - 1; i >= 0; i--) if (px(leaves[i], x, y)) { top = leaves[i]; break; }
      if (!top || top.blendMode !== 'normal' || top.opacity < 0.999 || top.clipping) continue;
      const s = px(top, x, y)!;
      if (s[3] !== 255) continue;
      const p = (y * W + x) * 4;
      n++;
      let d = 0;
      for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(s[c] - ref[p + c]));
      if (d) { miss++; const k = [0, 1, 2].map((c) => ref[p + c] - s[c]).join(','); hist[k] = (hist[k] ?? 0) + 1; }
      maxd = Math.max(maxd, d);
    }
  console.log(`opaque top pixels: n=${n} differ ${((100 * miss) / Math.max(1, n)).toFixed(2)}% max ${maxd}`, JSON.stringify(Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 6)));
}

{
  console.log('high-alpha misses (d s a -> ref | exact):');
  let k = 0;
  for (const t of S) {
    const exact = t.d + ((t.s - t.d) * t.a) / 255;
    if (t.a >= 160 && Math.round(exact) !== t.r && k++ < 16) console.log(`  d=${t.d} s=${t.s} a=${t.a} -> ${t.r} | ${exact.toFixed(2)}`);
  }
}

// form 3: out = Cd + T((Cs − Cd)·A) with signed rounding variants
{
  const TS: Record<string, (v: number) => number> = {
    floor255: (v) => Math.floor(v / 255),
    trunc255: (v) => Math.trunc(v / 255),
    round255: (v) => Math.round(v / 255),
    sar8: (v) => v >> 8,
    sar8r: (v) => (v + 128) >> 8,
    sar8p: (v) => (v + (v >> 8)) >> 8,
    sar8p128: (v) => (v + 128 + ((v + 128) >> 8)) >> 8,
    trunc256: (v) => Math.trunc(v / 256),
    floorf: (v) => Math.floor(v / 255 + 1e-9),
  };
  const AA3: Record<string, (a: number) => number> = { a: (a) => a, a1: (a) => a + 1, ah: (a) => a + (a >> 7), a257: (a) => (a * 257) >> 8 };
  const r3: [string, number][] = [];
  for (const [an, af] of Object.entries(AA3))
    for (const [tn, tf] of Object.entries(TS)) {
      let bad = 0;
      for (const t of S) if (Math.max(0, Math.min(255, t.d + tf((t.s - t.d) * af(t.a)))) !== t.r) bad++;
      r3.push([`Cd + ${tn}((Cs-Cd)*${an})`, bad / S.length]);
    }
  r3.sort((a, b) => a[1] - b[1]);
  console.log('form 3:');
  for (const [k, v] of r3.slice(0, 4)) console.log(`  ${(v * 100).toFixed(3).padStart(7)}%  ${k}`);
}

// form 4: out = T2(Cs·a) + T1(Cd·(255−a)) — premultiplied source recovered from the
// stored straight colour, backdrop scaled by (255−a), independent rounding
{
  const r4: [string, number][] = [];
  const inv: Record<string, (s: number, a: number) => number> = {
    // largest P with ceil(P·255/a) == s  (exporter did ceil when un-premultiplying)
    invCeil: (s, a) => { let P = Math.floor((s * a) / 255); while (P > 0 && Math.ceil(((P) * 255) / a) > s) P--; while (Math.ceil(((P + 1) * 255) / a) <= s && P + 1 <= a) P++; return P; },
    // P with round(P·255/a) == s
    invRound: (s, a) => { let P = Math.round((s * a) / 255); while (P > 0 && Math.round((P * 255) / a) > s) P--; while (P < a && Math.round(((P + 1) * 255) / a) <= s) P++; return P; },
  };
  for (const [t1n, t1] of Object.entries(T)) {
    for (const [t2n, t2] of Object.entries(T)) {
      let bad = 0;
      for (const t of S) if (Math.min(255, t2(t.s * t.a) + t1(t.d * (255 - t.a))) !== t.r) bad++;
      r4.push([`${t2n}(Cs*a) + ${t1n}(Cd*(255-a))`, bad / S.length]);
    }
    for (const [pn, pf] of Object.entries(inv)) {
      let bad = 0;
      for (const t of S) if (Math.min(255, pf(t.s, t.a) + t1(t.d * (255 - t.a))) !== t.r) bad++;
      r4.push([`${pn}(Cs,a) + ${t1n}(Cd*(255-a))`, bad / S.length]);
    }
  }
  r4.sort((a, b) => a[1] - b[1]);
  console.log('form 4:');
  for (const [k, v] of r4.slice(0, 4)) console.log(`  ${(v * 100).toFixed(3).padStart(7)}%  ${k}`);
}
