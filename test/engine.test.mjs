/**
 * Engine smoke test: every blend mode, on opaque / translucent / empty
 * backdrops, in normal and "transparency shapes off" mode, through both
 * arithmetic back-ends. Guards against crashes like the non-separable
 * colour-mode bug, and checks basic invariants of the results.
 */

import { writePsdBuffer, initializeCanvas } from 'ag-psd';
import { decodeDocument, storeFull, storeScaled, newLevel } from '../src/engine/doc';
import { render, authoredVisibility } from '../src/engine/composite';

initializeCanvas(
  () => {
    throw new Error('no canvas');
  },
  (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
);

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

const MODES = [
  'normal', 'dissolve', 'darken', 'multiply', 'color burn', 'linear burn', 'darker color',
  'lighten', 'screen', 'color dodge', 'linear dodge', 'lighter color',
  'overlay', 'soft light', 'hard light', 'vivid light', 'linear light', 'pin light', 'hard mix',
  'difference', 'exclusion', 'subtract', 'divide',
  'hue', 'saturation', 'color', 'luminosity',
];

const W = 32;
const H = 32;
function img(fill) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      const [r, g, b, a] = fill(x, y);
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = a;
    }
  return { width: W, height: H, data };
}

/** backdrop alpha: opaque, a gradient (translucent) or absent */
const BACKDROPS = {
  opaque: () => [200, 120, 40, 255],
  translucent: (x) => [30, 160, 220, Math.round((x / (W - 1)) * 255)],
  none: null,
};

async function doc(mode, backdrop, special) {
  const children = [];
  if (backdrop) children.push({ name: 'bg', left: 0, top: 0, imageData: img(backdrop) });
  children.push({
    name: 'top',
    left: 0,
    top: 0,
    blendMode: mode,
    opacity: 0.8,
    ...(special ? { transparencyShapesLayer: false, fillOpacity: 0.6 } : {}),
    imageData: img((x, y) => [(x * 8) & 255, (y * 8) & 255, 255 - ((x * 4) & 255), Math.round((y / (H - 1)) * 255)]),
  });
  // a group with a clipping layer exercises the group / clip paths with this mode too
  children.push({
    name: 'grp',
    opened: true,
    blendMode: mode,
    children: [
      { name: 'base', left: 4, top: 4, imageData: img((x) => [255, 255, 255, x < 16 ? 255 : 90]) },
      { name: 'clip', left: 0, top: 0, clipping: true, blendMode: mode, imageData: img(() => [10, 200, 90, 180]) },
    ],
  });
  const buf = writePsdBuffer({ width: W, height: H, children }, { noBackground: true });
  return decodeDocument(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

for (const mode of MODES) {
  for (const [bname, backdrop] of Object.entries(BACKDROPS)) {
    for (const special of [false, true]) {
      const d = await doc(mode, backdrop, special);
      for (const engineMode of ['ps8', 'float']) {
        const label = `${mode} / ${bname} backdrop / ${special ? 'tsly off' : 'normal'} / ${engineMode}`;
        let out;
        try {
          out = render(d, 0, authoredVisibility(d), { mode: engineMode });
        } catch (err) {
          check(label, false, String(err));
          continue;
        }
        let finite = true;
        for (let i = 0; i < out.data.length; i++) if (!(out.data[i] >= 0 && out.data[i] <= 255)) finite = false;
        check(`${label}: output in range`, finite);
      }
    }
  }
}

// opaque backdrop + normal mode at 100% must reproduce the top layer exactly
{
  const buf = writePsdBuffer(
    {
      width: W,
      height: H,
      children: [
        { name: 'bg', left: 0, top: 0, imageData: img(() => [1, 2, 3, 255]) },
        { name: 'top', left: 0, top: 0, imageData: img((x, y) => [x * 7, y * 7, 99, 255]) },
      ],
    },
    { noBackground: true },
  );
  const d = await decodeDocument(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const out = render(d, 0, authoredVisibility(d));
  check('opaque normal layer is copied exactly', out.data[(5 * W + 9) * 4] === 63 && out.data[(5 * W + 9) * 4 + 1] === 35);
}


/* ---------------- ibisPaint .ipv reader ---------------- */
{
  const { decodeIpv, isIpv } = await import('../src/engine/ipv');
  const { encodePng } = await import('../src/engine/png');
  const be = {
    u8: (v) => [v & 255],
    u16: (v) => [(v >> 8) & 255, v & 255],
    u32: (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255],
    i32: (v) => be.u32(v >>> 0),
    f32: (v) => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, v); return [...new Uint8Array(b.buffer)]; },
    str: (s) => { const b = [...new TextEncoder().encode(s)]; return [...be.u16(b.length), ...b]; },
  };
  const chunk = (type, payload) => [...be.u32(type), ...be.u32(payload.length), ...payload, ...be.i32(-(payload.length + 8))];
  const CW = 8, CH = 6;
  // layer 0: a 2x2 red square whose top-left is at document (5, 1);
  // ibisPaint counts rows from the bottom, so document row y is stored row CH-1-y
  const take = [];
  for (let row = 0; row < CH; row++) for (let x = 0; x < CW; x++) {
    const y = CH - 1 - row;
    take.push(x >= 5 && x < 7 && y >= 1 && y < 3);
  }
  const spans = [];
  let i = 0;
  while (i < take.length) {
    let skip = 0; while (i < take.length && !take[i]) { skip++; i++; }
    let t = 0; while (i < take.length && take[i]) { t++; i++; }
    spans.push(...be.u16(skip), ...be.u16(t));
  }
  // 4 packed pixels in a 2x2 PNG, stored bottom row first: distinct greens to check the order
  const packed = new Uint8ClampedArray([255, 30, 0, 255, 255, 40, 0, 255, 255, 10, 0, 128, 255, 20, 0, 255]);
  const png = [...(await encodePng(packed, 2, 2, { opaque: false }))];
  const header = [...be.u32(0), ...be.u8(4), ...be.u32(CW), ...be.u32(CH), ...be.u32(CW), ...be.u32(CH), ...be.i32(0), ...be.i32(0), ...be.u32(2), ...be.u32(2), ...be.u32(0), ...be.u32(0)];
  const rpng = [...new TextEncoder().encode('RPNG'), ...be.u32(header.length), ...header, ...be.u32(spans.length), ...spans, ...be.u32(png.length), ...png];
  const image = [...new Array(8).fill(0), ...be.i32(0), ...be.u32(1), 4, 0, ...be.u32(rpng.length), ...rpng];
  const layerRec = [...be.i32(0), 1 /* visible */, ...be.f32(0.5), ...be.u32(2), ...be.i32(-1), ...be.u32(0x80000000), ...be.str("线稿"), ...be.i32(-1), ...be.u32(0), ...be.i32(7)];
  const folderRec = [...be.i32(7), 0, ...be.f32(1), ...be.u32(0), ...be.i32(-1), ...be.u32(0x80000000), ...be.str("组"), ...be.i32(-1), ...be.u32(0), ...be.i32(-5)];
  const bytes = new Uint8Array([
    ...chunk(0x01000100, [...new Array(8).fill(0), ...be.u32(CW), ...be.u32(CH), ...be.str('TEST')]),
    ...chunk(0x01000300, new Array(16).fill(0)),
    ...chunk(0x01000500, image),
    ...chunk(0x01000600, [...chunk(0x03000402, layerRec), ...chunk(0x03000403, folderRec)]),
  ]);
  check('ipv: format detected', isIpv(bytes.buffer));
  const doc = await decodeIpv(bytes.buffer);
  const [folder] = doc.roots;
  const layer = folder?.children[0];
  check('ipv: folder with one child', folder?.kind === 'group' && folder.name === '组' && folder.hidden && folder.children.length === 1);
  check('ipv: layer properties', layer?.name === '线稿' && layer.blendMode === 'multiply' && Math.abs(layer.opacity - 0.5) < 1e-6 && !layer.hidden);
  check('ipv: bbox from sparse spans (bottom-up rows)', JSON.stringify(layer?.bbox) === JSON.stringify([5, 1, 7, 3]), layer?.bbox);
  const blk = doc.levels[0].layers.get(layer.id).blocks[0];
  const at = (x, y) => [...blk.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)];
  // first stored span = bottom document row (y=2), filled from the PNG's bottom row
  check('ipv: pixels land in the right place', at(5, 2)[1] === 10 && at(6, 2)[1] === 20 && at(5, 1)[1] === 30 && at(6, 1)[1] === 40, [at(5, 1), at(6, 1), at(5, 2), at(6, 2)]);
  check('ipv: straight alpha kept exactly', at(5, 2)[3] === 128 && at(5, 2)[0] === 255);
}

// ---- sparse downscale: skipping empty blocks must not change any level pixel
{
  const W = 700;
  const H = 530;
  const img = new Uint8Array(W * H * 4);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) & 255;
  img[3] = 1; // anchor pixel in the corner, like many painting apps write
  for (const [cx, cy, r] of [[150, 120, 60], [480, 300, 90], [640, 500, 25]]) {
    for (let y = cy - r; y < cy + r; y++)
      for (let x = cx - r; x < cx + r; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H || (x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
        const i = (y * W + x) * 4;
        img[i] = rnd();
        img[i + 1] = rnd();
        img[i + 2] = rnd();
        img[i + 3] = 1 + (rnd() % 255);
      }
  }
  const full = storeFull(newLevel(1, W, H), img, W, H, 0, 0);
  for (const k of [2, 3, 7, 12]) {
    const lvlA = newLevel(k, W, H);
    const lvlB = newLevel(k, W, H);
    const a = storeScaled(lvlA, img, W, H, 0, 0, W, H).blocks;
    const b = storeScaled(lvlB, img, W, H, 0, 0, W, H, full.blocks).blocks;
    let same = a.length === b.length;
    for (let i = 0; same && i < a.length; i++) {
      if (!a[i] !== !b[i]) same = false;
      else if (a[i]) for (let j = 0; j < a[i].length; j++) if (a[i][j] !== b[i][j]) (same = false), (j = a[i].length);
    }
    check(`sparse downscale k=${k} identical`, same);
  }
}

console.log(`engine + ipv: ${pass} checks passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
