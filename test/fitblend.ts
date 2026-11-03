/**
 * Blend-formula fitter: finds the integer arithmetic a painting app used for
 * its merged image. Collects pixels where exactly one layer (top level, no
 * clipping) lies on an opaque backdrop we can reproduce exactly, then scores
 * candidate formulas per blend mode against the PSD's merged image.
 *
 *   node test/fit-run.mjs <file.psd> [maxSamples]
 */

import { readFileSync } from 'node:fs';
import { decodeDocument, BLOCK, type EngineNode } from '../src/engine/doc';
import { render, authoredVisibility } from '../src/engine/composite';

const file = process.argv[2];
const maxSamples = Number(process.argv[3] ?? 60000);
const buf = readFileSync(file);
const doc = await decodeDocument(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), { keepComposite: true });
const ref = doc.composite;
if (!ref) {
  console.log('no merged image');
  process.exit(0);
}
const vis = authoredVisibility(doc);
const L = doc.levels[0];
const W = doc.width;

// drawn leaves bottom -> top, with their top-level ancestry
const leaves: EngineNode[] = [];
const walk = (list: EngineNode[], on: boolean) => {
  for (const n of list) {
    const v = on && vis(n.id);
    if (n.kind === 'group') walk(n.children, v);
    else if (v && n.bbox) leaves.push(n);
  }
};
walk(doc.roots, true);
const topLevel = new Set(doc.roots.map((n) => n.id));
const px = (n: EngineNode, x: number, y: number) => {
  const b = L.layers.get(n.id)?.blocks[Math.floor(y / BLOCK) * L.bw + Math.floor(x / BLOCK)];
  if (!b) return null;
  const i = ((y % BLOCK) * BLOCK + (x % BLOCK)) * 4;
  return b[i + 3] ? b.subarray(i, i + 4) : null;
};

interface Sample {
  Cd: number[];
  Cs: number[];
  a: number;
  o: number;
  ref: number[];
}
const byMode = new Map<string, Sample[]>();

// For each candidate top layer, render everything below it (that's the backdrop
// we trust only where it is a single opaque normal layer, so the backdrop is exact).
for (let li = 1; li < leaves.length; li++) {
  const top = leaves[li];
  if (!topLevel.has(top.id) || top.clipping || top.special) continue;
  const below = leaves.slice(0, li);
  const above = leaves.slice(li + 1);
  const mode = top.blendMode;
  const list = byMode.get(mode) ?? [];
  if (list.length >= maxSamples) continue;
  const [x0, y0, x1, y1] = top.bbox!;
  for (let y = y0; y < y1 && list.length < maxSamples; y += 1) {
    for (let x = x0; x < x1 && list.length < maxSamples; x += 1) {
      const s = px(top, x, y);
      if (!s || s[3] === 255 && mode === 'normal') continue;
      if (above.some((n) => px(n, x, y))) continue;
      // exactly one opaque, normal, full-opacity layer underneath
      const under = below.filter((n) => px(n, x, y));
      if (under.length !== 1) continue;
      const u = under[0];
      const up = px(u, x, y)!;
      if (up[3] !== 255 || u.blendMode !== 'normal' || u.opacity < 0.999 || u.clipping || !topLevel.has(u.id)) continue;
      const p = (y * W + x) * 4;
      if (ref[p + 3] !== 255) continue;
      list.push({ Cd: [up[0], up[1], up[2]], Cs: [s[0], s[1], s[2]], a: s[3], o: Math.round(top.opacity * 255), ref: [ref[p], ref[p + 1], ref[p + 2]] });
    }
  }
  byMode.set(mode, list);
}

/* ---------------- candidate arithmetic ---------------- */

type Div = (v: number) => number; // v / 255 in some integer flavour
const DIVS: Record<string, Div> = {
  round255: (v) => Math.round(v / 255),
  ps255: (v) => {
    const t = v + 128;
    return (t + (t >> 8)) >> 8;
  },
  trunc255: (v) => Math.floor(v / 255),
  shr8: (v) => v >> 8,
  shr8r: (v) => (v + 128) >> 8,
  shr8p: (v) => (v + (v >> 8)) >> 8,
};
type AlphaMix = (a: number, o: number) => number; // effective alpha 0..255
const ALPHAS: Record<string, AlphaMix> = {
  r: (a, o) => Math.round((a * o) / 255),
  t: (a, o) => Math.floor((a * o) / 255),
  s8: (a, o) => (a * o) >> 8,
  s8r: (a, o) => (a * o + 128) >> 8,
  s8p: (a, o) => (a * (o + (o >> 7))) >> 8,
  f: (a, o) => (a * o) / 255,
};

const SEP: Record<string, (d: number, s: number, div: Div) => number> = {
  normal: (d, s) => s,
  multiply: (d, s, div) => div(d * s),
  screen: (d, s, div) => d + s - div(d * s),
  'linear dodge': (d, s) => Math.min(255, d + s),
  overlay: (d, s, div) => (d < 128 ? div(2 * d * s) : 255 - div(2 * (255 - d) * (255 - s))),
  darken: (d, s) => Math.min(d, s),
  lighten: (d, s) => Math.max(d, s),
};

function score(samples: Sample[], f: (s: Sample, c: number) => number): number {
  let bad = 0;
  for (const s of samples) {
    for (let c = 0; c < 3; c++) {
      if (f(s, c) !== s.ref[c]) {
        bad++;
        break;
      }
    }
  }
  return bad / samples.length;
}

for (const [mode, samples] of byMode) {
  if (samples.length < 200 || !SEP[mode]) {
    if (samples.length) console.log(`${mode}: ${samples.length} samples ${SEP[mode] ? '' : '(no candidates)'}`);
    continue;
  }
  const results: [string, number][] = [];
  for (const [an, af] of Object.entries(ALPHAS))
    for (const [bn, bdiv] of Object.entries(DIVS))
      for (const [ln, ldiv] of Object.entries(DIVS)) {
        // lerp form: Cd + (B - Cd) * A
        results.push([
          `lerp  A:${an} B:${bn} mix:${ln}`,
          score(samples, (s, c) => {
            const A = af(s.a, s.o);
            const B = SEP[mode](s.Cd[c], s.Cs[c], bdiv);
            return Number.isInteger(A) ? ldiv(B * A + s.Cd[c] * (255 - A)) : Math.round((B * A + s.Cd[c] * (255 - A)) / 255);
          }),
        ]);
        // premultiplied form: Cs·A + Cd·(1−A) computed as two separate rounded terms
        results.push([
          `split A:${an} B:${bn} mix:${ln}`,
          score(samples, (s, c) => {
            const A = Math.round(af(s.a, s.o));
            const B = SEP[mode](s.Cd[c], s.Cs[c], bdiv);
            return Math.min(255, ldiv(B * A) + ldiv(s.Cd[c] * (255 - A)));
          }),
        ]);
      }
  // fully float reference
  results.push([
    'float exact',
    score(samples, (s, c) => {
      const A = (s.a * s.o) / 65025;
      const B = SEP[mode](s.Cd[c], s.Cs[c], (v) => v / 255);
      return Math.round(s.Cd[c] + (B - s.Cd[c]) * A);
    }),
  ]);
  results.sort((a, b) => a[1] - b[1]);
  console.log(`${mode}: ${samples.length} samples`);
  for (const [k, v] of results.slice(0, 4)) console.log(`   ${(v * 100).toFixed(3).padStart(7)}%  ${k}`);
}

if (process.argv.includes('--samples')) {
  for (const [mode, samples] of byMode) {
    console.log(`--- ${mode} samples (Cd | Cs a o -> ref | float-exact)`);
    const step = Math.max(1, Math.floor(samples.length / 14));
    for (let i = 0; i < samples.length; i += step) {
      const s = samples[i];
      const A = (s.a * s.o) / 65025;
      const ex = s.Cs.map((v, c) => {
        const B = SEP[mode] ? SEP[mode](s.Cd[c], v, (x) => x / 255) : v;
        return (s.Cd[c] + (B - s.Cd[c]) * A).toFixed(1);
      });
      console.log(`  ${s.Cd.join(',').padEnd(12)}| ${s.Cs.join(',').padEnd(12)} a=${String(s.a).padEnd(3)} o=${String(s.o).padEnd(3)} -> ${s.ref.join(',').padEnd(12)}| ${ex.join(',')}`);
    }
  }
}
