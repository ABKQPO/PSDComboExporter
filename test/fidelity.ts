/**
 * Fidelity check: render a PSD with the app's engine using the visibility saved
 * in the file, and compare it pixel by pixel with the merged image Photoshop
 * stored inside the PSD.
 *
 *   npm run test:fidelity -- <file.psd> [outDir] [--sampling=nearest|bilinear] [--quantize=round|trunc]
 *
 * Writes <outDir>/engine.png, <outDir>/photoshop.png and <outDir>/diff.png
 * (diff amplified ×16) and exits non-zero when the images are not identical
 * within the tolerance given by --tolerance (default 0 = exact).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeDocument } from '../src/engine/doc';
import { render, authoredVisibility, defaultMode, type RenderOptions } from '../src/engine/composite';
import { encodePng } from '../src/engine/png';
import { pixelDiff } from '../src/engine/compare';
import { calibrate } from '../src/engine/calibrate';

const args = process.argv.slice(2);
const flags = Object.fromEntries(
  args.filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.slice(2).split('=');
    return [k, v ?? 'true'];
  }),
);
const [psdPath, outDir = 'test-out/fidelity'] = args.filter((a) => !a.startsWith('--'));
if (!psdPath) {
  console.error('usage: fidelity <file.psd> [outDir]');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const t0 = performance.now();
const buf = readFileSync(psdPath);
const doc = await decodeDocument(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), {
  keepComposite: true,
});
const t1 = performance.now();
const opts: RenderOptions = {
  patternSampling: (flags.sampling as RenderOptions['patternSampling']) ?? undefined,
  quantize: (flags.quantize as RenderOptions['quantize']) ?? undefined,
  mode: (flags.mode as RenderOptions['mode']) ?? undefined,
  profile: (flags.profile as RenderOptions['profile']) ?? undefined,
};
if (flags.profile === 'auto') {
  opts.profile = calibrate(doc).profile;
  console.log(`auto profile: ${opts.profile}`);
}
const img = render(doc, 0, authoredVisibility(doc), opts);
console.log(`writer: ${doc.writer || '(unknown)'}, mode: ${opts.mode ?? defaultMode(doc)}`);
const t2 = performance.now();
console.log(`decode ${(t1 - t0).toFixed(0)} ms, render ${(t2 - t1).toFixed(0)} ms, ${img.width}x${img.height}`);
for (const w of doc.warnings) console.log('warning:', w);
for (const n of doc.nodes.values()) if (n.unsupported.length) console.log(`unsupported: ${n.name}: ${n.unsupported.join(', ')}`);

writeFileSync(join(outDir, 'engine.png'), await encodePng(img.data, img.width, img.height));
if (!doc.composite) {
  console.log('PSD has no merged image, nothing to compare');
  process.exit(0);
}
const ref = doc.composite;
writeFileSync(join(outDir, 'photoshop.png'), await encodePng(ref, img.width, img.height));

// --exclude-effects: ignore pixels touched by layer effects (to judge plain compositing)
let excluded: Uint8Array | null = null;
if (flags['exclude-effects']) {
  const fxIds = new Set([...doc.nodes.values()].filter((n) => n.effects.length).map((n) => n.id));
  const base = authoredVisibility(doc);
  const plain = render(doc, 0, (id) => base(id) && !fxIds.has(id), opts);
  const raw = render(doc, 0, (id) => base(id), { ...opts });
  excluded = new Uint8Array(ref.length / 4);
  const r = 3;
  for (let p = 0; p < ref.length; p += 4) {
    let same = true;
    for (let c = 0; c < 4; c++) if (plain.data[p + c] !== raw.data[p + c]) same = false;
    if (same) continue;
    const x = (p / 4) % img.width;
    const y = Math.floor(p / 4 / img.width);
    for (let yy = Math.max(0, y - r); yy <= Math.min(img.height - 1, y + r); yy++)
      for (let xx = Math.max(0, x - r); xx <= Math.min(img.width - 1, x + r); xx++) excluded[yy * img.width + xx] = 1;
  }
  let n = 0;
  for (const v of excluded) n += v;
  console.log(`excluding ${n} effect pixels`);
}
const diff = new Uint8ClampedArray(ref.length);
const hist = new Array(256).fill(0);
let max = 0;
let sum = 0;
let differing = 0;
const W = img.width;
let bx0 = W, by0 = img.height, bx1 = -1, by1 = -1;
for (let p = 0; p < ref.length; p += 4) {
  if (excluded && excluded[p / 4]) {
    diff[p + 3] = 255;
    continue;
  }
  const d = pixelDiff(img.data, ref, p);
  hist[d]++;
  if (d > max) max = d;
  sum += d;
  if (d > 0) {
    differing++;
    const x = (p / 4) % W;
    const y = Math.floor(p / 4 / W);
    if (x < bx0) bx0 = x;
    if (y < by0) by0 = y;
    if (x > bx1) bx1 = x;
    if (y > by1) by1 = y;
  }
  diff[p] = diff[p + 1] = diff[p + 2] = Math.min(255, d * 16);
  diff[p + 3] = 255;
}
writeFileSync(join(outDir, 'diff.png'), await encodePng(diff, img.width, img.height));
const px = ref.length / 4;
console.log(
  `max diff ${max}, mean ${(sum / px).toFixed(4)}, differing pixels ${differing} (${((differing / px) * 100).toFixed(3)}%)` +
    (differing ? `, bbox ${bx0},${by0}-${bx1},${by1}` : ''),
);
console.log('histogram', hist.map((n, i) => (n ? `${i}:${n}` : '')).filter(Boolean).join(' '));
const tol = Number(flags.tolerance ?? 0);
process.exit(max <= tol ? 0 : 1);
