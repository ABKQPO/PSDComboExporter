/** Decode an .ipv with the engine and compare the render with its stored merged image. */
import { readFileSync } from 'node:fs';
import { decodeIpv, IPV_BLEND } from '../src/engine/ipv';
for (const a of process.argv) if (a.startsWith('--map=')) for (const kv of a.slice(6).split(',')) { const [k, v] = kv.split(':'); IPV_BLEND[Number(k)] = v.replace('_', ' '); }
import { render, authoredVisibility, type ProfileId } from '../src/engine/composite';
import { pixelDiff } from '../src/engine/compare';
const buf = readFileSync(process.argv[2]);
const t0 = performance.now();
const doc = await decodeIpv(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), { keepComposite: true });
console.log(`${doc.writer} ${doc.width}x${doc.height} layers ${[...doc.nodes.values()].filter((n) => n.kind === 'layer').length} groups ${[...doc.nodes.values()].filter((n) => n.kind === 'group').length} decode ${(performance.now() - t0).toFixed(0)}ms composite ${!!doc.composite}`);
for (const w of doc.warnings) console.log('  warning:', w);
if (process.argv.includes('--tree')) {
  const p = (l: typeof doc.roots, d: number) => [...l].reverse().forEach((n) => { console.log('  '.repeat(d + 1) + `${n.kind === 'group' ? '[G] ' : ''}${n.name} ${n.blendMode} ${n.opacity.toFixed(2)}${n.clipping ? ' clip' : ''}${n.hidden ? ' hidden' : ''} ${n.bbox ?? ''}`); p(n.children, d + 1); });
  p(doc.roots, 0);
}
// premultiplied check: any layer pixel with colour > alpha?
let over = 0, semi = 0;
for (const [, b] of doc.levels[0].layers) for (const blk of b.blocks) if (blk) for (let i = 0; i < blk.length; i += 4) { const a = blk[i + 3]; if (a && a < 255) { semi++; if (blk[i] > a || blk[i + 1] > a || blk[i + 2] > a) over++; } }
console.log(`  semi-transparent px ${semi}, with colour > alpha ${over} (${over ? 'straight' : 'looks premultiplied'})`);
const hide = new Set((process.argv.find((a) => a.startsWith('--hide=')) ?? '--hide=').slice(7).split(',').filter(Boolean));
const hiddenIds = new Set([...doc.nodes.values()].filter((n) => hide.has(n.name)).map((n) => n.id));
const baseVis = authoredVisibility(doc);
if (doc.composite) for (const profile of ['photoshop', 'painter'] as ProfileId[]) {
  const img = render(doc, 0, (id) => baseVis(id) && !hiddenIds.has(id), { profile });
  let signed = 0;
  for (let p = 0; p < doc.composite.length; p += 4) signed += doc.composite[p] + doc.composite[p + 1] + doc.composite[p + 2] - img.data[p] - img.data[p + 1] - img.data[p + 2];
  console.log(`  ${profile} signed (ref - ours) per channel: ${(signed / (doc.composite.length / 4) / 3).toFixed(3)}`);
  let sum = 0, same = 0, max = 0; const ref = doc.composite;
  for (let p = 0; p < ref.length; p += 4) { const d = pixelDiff(img.data, ref, p); sum += d; if (!d) same++; if (d > max) max = d; }
  const n = ref.length / 4;
  console.log(`  ${profile}: mean ${(sum / n).toFixed(3)} identical ${((same / n) * 100).toFixed(2)}% max ${max}`);
}
if (process.argv.includes('--dump')) {
  const { writeFileSync } = await import('node:fs');
  const { encodePng } = await import('../src/engine/png');
  const img = render(doc, 0, authoredVisibility(doc));
  writeFileSync('test-out/ipv-engine.png', await encodePng(img.data, img.width, img.height, { opaque: false }));
  if (doc.composite) writeFileSync('test-out/ipv-ref.png', await encodePng(doc.composite, doc.width, doc.height, { opaque: false }));
}
if (process.argv.includes('--no-hex')) {
  // ignore layers injected by third-party watermark tools
  const injected = new Set([...doc.nodes.values()].filter((n) => /HEX加码|仅可QQ|趣绮梦/.test(n.name)).map((n) => n.id));
  const vis = authoredVisibility(doc);
  const img = render(doc, 0, (id) => vis(id) && !injected.has(id));
  let sum = 0, same = 0, max = 0; const ref = doc.composite!;
  for (let p = 0; p < ref.length; p += 4) { const d = pixelDiff(img.data, ref, p); sum += d; if (!d) same++; if (d > max) max = d; }
  console.log(`  without ${injected.size} injected layers: mean ${(sum / (ref.length / 4)).toFixed(3)} identical ${((same / (ref.length / 4)) * 100).toFixed(2)}% max ${max}`);
}
