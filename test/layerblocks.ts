// Which layers have pixels in how many blocks, and how strong is their alpha there?
import { readFileSync } from 'node:fs';
import { decodeDocument } from '../src/engine/doc';
const [file, ...ids] = process.argv.slice(2);
const buf = readFileSync(file);
const doc = await decodeDocument(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), { keepComposite: false });
const lvl = doc.levels[0];
for (const id of ids) {
  const n = doc.nodes.get(id)!;
  const blocks = lvl.layers.get(id)?.blocks ?? [];
  let count = 0;
  let maxA = 0;
  let px = 0;
  const hist = [0, 0, 0, 0];
  for (const b of blocks) {
    if (!b) continue;
    count++;
    for (let i = 3; i < b.length; i += 4) if (b[i]) {
      px++;
      maxA = Math.max(maxA, b[i]);
      hist[b[i] <= 2 ? 0 : b[i] <= 16 ? 1 : b[i] < 255 ? 2 : 3]++;
    }
  }
  const b0 = blocks[0];
  let a0 = 0;
  if (b0) for (let i = 3; i < b0.length; i += 4) a0 = Math.max(a0, b0[i]);
  console.log(`${id} ${n.name} bbox=${JSON.stringify(n.bbox)} blocks=${count}/${blocks.length} px=${px} alpha<=2:${hist[0]} <=16:${hist[1]} mid:${hist[2]} 255:${hist[3]} corner-tile maxA=${a0}`);
}
