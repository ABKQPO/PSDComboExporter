/** Full-resolution match against each PSD's merged image: Photoshop rules vs auto-detected rules. */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { decodeDocument } from '../src/engine/doc';
import { render, authoredVisibility, type ProfileId } from '../src/engine/composite';
import { calibrate } from '../src/engine/calibrate';
import { pixelDiff } from '../src/engine/compare';

const stat = (doc: Awaited<ReturnType<typeof decodeDocument>>, profile: ProfileId) => {
  const img = render(doc, 0, authoredVisibility(doc), { profile });
  const ref = doc.composite!;
  let sum = 0, same = 0, max = 0;
  for (let p = 0; p < ref.length; p += 4) {
    const d = pixelDiff(img.data, ref, p);
    sum += d;
    if (!d) same++;
    if (d > max) max = d;
  }
  const n = ref.length / 4;
  return `${(sum / n).toFixed(3).padStart(6)} ${((same / n) * 100).toFixed(2).padStart(6)}% ${String(max).padStart(3)}`;
};
console.log('file                     auto-profile   Photoshop rules(mean ident max)   auto(mean ident max)');
for (const f of process.argv.slice(2)) {
  const buf = readFileSync(f);
  const doc = await decodeDocument(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), { keepComposite: true });
  if (!doc.composite) continue;
  const c = calibrate(doc);
  const name = basename(f, '.psd').slice(0, 20).padEnd(21);
  console.log(`${name}    ${c.profile.padEnd(10)}  ${stat(doc, 'photoshop')}          ${c.profile === 'photoshop' ? '(same)' : stat(doc, c.profile)}`);
}
