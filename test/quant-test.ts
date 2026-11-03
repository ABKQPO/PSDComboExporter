/** Compare buffer-precision hypotheses on .ipv / .psd files: node test/quant-run.mjs <files...> */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { decodeIpv } from '../src/engine/ipv';
import { decodeDocument } from '../src/engine/doc';
import { render, authoredVisibility, type RenderOptions } from '../src/engine/composite';
import { pixelDiff } from '../src/engine/compare';
const VARIANTS: [string, RenderOptions][] = [
  ['ps8', { mode: 'ps8' }],
  ['float', { mode: 'float' }],
  ['float+u8p', { mode: 'float', stepQuant: 'u8p' }],
  ['float+u8s', { mode: 'float', stepQuant: 'u8s' }],
  ['float+f16', { mode: 'float', stepQuant: 'f16' }],
  ['ps8 trunc', { mode: 'ps8', trunc8: true }],
  ['float trunc', { mode: 'float', quantize: 'trunc' }],
];
console.log('file'.padEnd(18) + VARIANTS.map(([k]) => k.padStart(18)).join(''));
for (const f of process.argv.slice(2)) {
  const buf = readFileSync(f);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const doc = await (/\.ipv$/i.test(f) ? decodeIpv : decodeDocument)(ab, { keepComposite: true });
  if (!doc.composite) continue;
  const cells: string[] = [];
  for (const [, o] of VARIANTS) {
    const img = render(doc, 0, authoredVisibility(doc), o);
    let sum = 0, same = 0;
    for (let p = 0; p < doc.composite.length; p += 4) { const d = pixelDiff(img.data, doc.composite, p); sum += d; if (!d) same++; }
    const n = doc.composite.length / 4;
    cells.push(`${(sum / n).toFixed(3)}/${((same / n) * 100).toFixed(1)}%`.padStart(18));
  }
  console.log(basename(f).slice(0, 16).padEnd(18) + cells.join(''));
}
