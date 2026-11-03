/** One-line fidelity summary per .ipv file: node test/ipv-all-run.mjs <dir> */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeIpv } from '../src/engine/ipv';
import { render, authoredVisibility } from '../src/engine/composite';
import { pixelDiff } from '../src/engine/compare';
import { calibrate } from '../src/engine/calibrate';
const dir = process.argv[2];
let n = 0, exact = 0, near = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith('.ipv'))) {
  try {
    const buf = readFileSync(join(dir, f));
    const doc = await decodeIpv(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), { keepComposite: true });
    if (!doc.composite) { console.log(`${f.slice(0, 24).padEnd(24)} no merged image`); continue; }
    const prof = calibrate(doc).profile;
    const img = render(doc, 0, authoredVisibility(doc), { profile: prof });
    let sum = 0, same = 0, max = 0; const ref = doc.composite;
    for (let p = 0; p < ref.length; p += 4) { const d = pixelDiff(img.data, ref, p); sum += d; if (!d) same++; if (d > max) max = d; }
    const px = ref.length / 4; n++;
    if (same / px > 0.99) exact++;
    if (sum / px < 0.1) near++;
    const unk = doc.warnings.find((w) => w.includes('混合模式')) ? ' [unknown blend]' : '';
    console.log(`${f.slice(0, 24).padEnd(24)} ${prof.padEnd(9)} mean ${(sum / px).toFixed(3).padStart(6)} identical ${((same / px) * 100).toFixed(2).padStart(6)}% max ${String(max).padStart(3)}${unk}`);
  } catch (e) { console.log(`${f.slice(0, 24).padEnd(24)} ERROR ${(e as Error).message}`); }
}
console.log(`files ${n}: ≥99% identical ${exact}, mean<0.1 ${near}`);
