/** Print the auto-detected compositing profile for each PSD: node test/calibrate-run.mjs <files...> */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { decodeDocument } from '../src/engine/doc';
import { calibrate } from '../src/engine/calibrate';

for (const f of process.argv.slice(2)) {
  const buf = readFileSync(f);
  const doc = await decodeDocument(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), { keepComposite: true });
  const t = performance.now();
  const c = calibrate(doc);
  const ms = performance.now() - t;
  const sc = c.scores.map((s) => `${s.profile} ${s.mean.toFixed(3)}/${(s.same * 100).toFixed(1)}%`).join('  ');
  console.log(`${basename(f).slice(0, 22).padEnd(22)} -> ${c.profile.padEnd(9)} (${c.reason}, ${ms.toFixed(0)} ms, ${c.sampledPixels} px)  ${sc}`);
}
