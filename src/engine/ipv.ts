/**
 * ibisPaint (.ipv) reader.
 *
 * An .ipv file is the drawing *history* (strokes, transforms, layer edits) as
 * a stream of chunks, followed by a snapshot of every layer as it was when the
 * file was saved, the merged canvas, and a metadata chunk with the layer tree.
 * We only need the snapshot, so nothing has to be replayed.
 *
 * Chunk:  u32 type · u32 length · payload · i32 trailer = −(length + 8)
 * (big-endian; the trailer allows walking backwards for playback).
 *
 *   01000100  header: f64 time, u32 width, u32 height, str artwork id
 *   01000500  layer image: f64 time, i32 layer id, u32 flags (low byte 1 =
 *             RPNG / 0 = PNG), u8 channels, u8 0, u32 size, data
 *   01000600  metadata; contains one 03000402 record per layer and one
 *             03000403 record per folder, bottom → top
 *
 * RPNG ("region PNG"): 'RPNG', u32 header size (45), header, u32 span bytes,
 * spans, u32 PNG size, PNG. Spans are big-endian u16 (skip, take) pairs walking
 * the region rectangle row by row; the taken pixels are packed one after
 * another into the PNG raster, which only serves as a compressed pixel list.
 * Files from ibisPaint 10+ use OpenGL orientation (rows counted from the
 * bottom). Colours are not premultiplied.
 */

import type { DecodeOptions, EngineDoc, EngineNode, Level } from './doc';
import { newLevel, storeFull, storeScaled, makeThumb, thumbFromLevel, yieldNow } from './doc';
import { decodePng } from './pngdecode';

/**
 * ibisPaint blend mode numbers -> blend mode names understood by the engine.
 * Fitted against the merged images stored in real .ipv files (test/ipv-blend.ts):
 * jointly aligned over 69 files (test/ipv-align.ts); 13+ follow Photoshop's menu
 * order without multiply / screen / overlay. Codes not listed fall back to
 * normal with a warning.
 */
export const IPV_BLEND: Record<number, string> = {
  0: 'normal',
  2: 'multiply',
  5: 'overlay',
  9: 'screen',
  // 13+ follow Photoshop's menu order (minus multiply / screen / overlay above)
  7: 'subtract',
  13: 'darken',
  14: 'color burn',
  15: 'linear burn',
  16: 'darker color',
  17: 'lighten',
  18: 'color dodge',
  19: 'linear dodge',
  20: 'lighter color',
  21: 'soft light',
  22: 'hard light',
  23: 'vivid light',
  24: 'linear light',
  25: 'pin light',
  26: 'hard mix',
  27: 'difference',
  28: 'exclusion',
  29: 'divide',
  // ibisPaint's component modes work in HSL (lightness = (max+min)/2), not
  // Photoshop's weighted luminance: measured on several files
  30: 'hsl hue',
  31: 'hsl saturation',
  32: 'hsl color',
  33: 'hsl luminosity',
};

/** "Add" (code 1) is a plain sum Cd + Cs·α, not Photoshop's linear dodge. */
const IPV_ADDITIVE = new Set([1]);

export function isIpv(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 24) return false;
  const dv = new DataView(buf);
  if (dv.getUint32(0) !== 0x01000100) return false;
  const n = dv.getUint32(4);
  return n < 4096 && 8 + n + 4 <= buf.byteLength && dv.getInt32(8 + n) === -(n + 8);
}

interface Chunk {
  type: number;
  start: number; // payload start
  length: number;
}

function readChunks(dv: DataView, start: number, end: number): Chunk[] {
  const out: Chunk[] = [];
  let p = start;
  while (p + 12 <= end) {
    const type = dv.getUint32(p);
    const length = dv.getUint32(p + 4);
    const q = p + 8 + length;
    if (q + 4 > end || dv.getInt32(q) !== -(length + 8)) throw new Error(`ipv 文件结构损坏（偏移 ${p}）`);
    out.push({ type, start: p + 8, length });
    p = q + 4;
  }
  return out;
}

const utf8 = new TextDecoder('utf-8');

export interface IpvLayerRecord {
  id: number;
  folder: boolean;
  visible: boolean;
  clipping: boolean;
  opacity: number;
  blendCode: number;
  name: string;
  parent: number;
}

/** Scan the metadata chunk for layer (03000402) and folder (03000403) records. */
function readLayerRecords(dv: DataView, bytes: Uint8Array, start: number, end: number): IpvLayerRecord[] {
  const out: IpvLayerRecord[] = [];
  let i = start;
  while (i + 12 <= end) {
    const type = dv.getUint32(i);
    if (type === 0x03000402 || type === 0x03000403) {
      const n = dv.getUint32(i + 4);
      const q = i + 8 + n;
      if (q + 4 <= end && dv.getInt32(q) === -(n + 8) && n >= 35) {
        const d = i + 8;
        const flags = bytes[d + 4];
        const nameLen = dv.getUint16(d + 21);
        const nameEnd = d + 23 + nameLen;
        out.push({
          id: dv.getInt32(d),
          folder: type === 0x03000403,
          visible: (flags & 1) !== 0,
          clipping: (flags & 2) !== 0,
          opacity: dv.getFloat32(d + 5),
          blendCode: dv.getUint32(d + 9),
          name: utf8.decode(bytes.subarray(d + 23, nameEnd)),
          // name is followed by i32 −1, u32 0, i32 parent
          parent: dv.getInt32(nameEnd + 8),
        });
        i = q + 4;
        continue;
      }
    }
    i++;
  }
  return out;
}

interface LayerImage {
  /** document-space RGBA of the layer's bounding box */
  data: Uint8ClampedArray;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Decode an RPNG payload into a bbox-cropped straight RGBA image. */
async function decodeRpng(dv: DataView, bytes: Uint8Array, p: number, end: number): Promise<LayerImage | null> {
  if (String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]) !== 'RPNG') throw new Error('RPNG 标记缺失');
  const hdr = dv.getUint32(p + 4);
  const h = p + 8;
  // header: u32 0, u8 flags, u32 canvas w, u32 canvas h, u32 region w, u32 region h,
  //         i32 region x, i32 region y, u32 png w, u32 png h, ...
  // OpenGL orientation: region y, the span walk and the PNG raster all count
  // from the bottom of the canvas (every ibisPaint version seen so far).
  const canvasH = dv.getUint32(h + 9);
  const rw = dv.getUint32(h + 13);
  const rx = dv.getInt32(h + 21);
  const ry = dv.getInt32(h + 25);
  const docY = (row: number) => canvasH - 1 - (ry + row);
  let q = h + hdr;
  const spanBytes = dv.getUint32(q);
  q += 4;
  const spanEnd = q + spanBytes;
  // u32 PNG size, then the PNG holding the packed pixels
  const pngSize = dv.getUint32(spanEnd);
  const png = await decodePng(bytes.subarray(spanEnd + 4, Math.min(end, spanEnd + 4 + pngSize)));
  {
    // PNG raster: bottom row first as well
    const rowB = png.width * 4;
    const tmp = new Uint8ClampedArray(rowB);
    for (let y = 0; y < png.height >> 1; y++) {
      const a = y * rowB;
      const b2 = (png.height - 1 - y) * rowB;
      tmp.set(png.data.subarray(a, a + rowB));
      png.data.copyWithin(a, b2, b2 + rowB);
      png.data.set(tmp, b2);
    }
  }

  // first pass: bounding box of the taken pixels
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  let pos = 0;
  for (let s = q; s + 4 <= spanEnd; s += 4) {
    pos += dv.getUint16(s);
    const take = dv.getUint16(s + 2);
    if (take) {
      for (let k = pos, e = pos + take; k < e; ) {
        const row = Math.floor(k / rw);
        const x0 = rx + k - row * rw;
        const y = docY(row);
        const run = Math.min(e - k, rw - (k - row * rw));
        if (x0 < minX) minX = x0;
        if (x0 + run - 1 > maxX) maxX = x0 + run - 1;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        k += run;
      }
    }
    pos += take;
  }
  if (maxX < 0) return null;
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const data = new Uint8ClampedArray(width * height * 4);
  // second pass: scatter the packed pixels
  pos = 0;
  let src = 0;
  for (let s = q; s + 4 <= spanEnd; s += 4) {
    pos += dv.getUint16(s);
    const take = dv.getUint16(s + 2);
    for (let k = pos, e = pos + take; k < e; ) {
      const row = Math.floor(k / rw);
      const x0 = rx + k - row * rw;
      const y = docY(row);
      const run = Math.min(e - k, rw - (k - row * rw));
      const d = ((y - minY) * width + (x0 - minX)) * 4;
      data.set(png.data.subarray(src * 4, (src + run) * 4), d);
      src += run;
      k += run;
    }
    pos += take;
  }
  return { data, left: minX, top: minY, width, height };
}

export async function decodeIpv(buffer: ArrayBuffer, opts: DecodeOptions = {}): Promise<EngineDoc> {
  const dv = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const chunks = readChunks(dv, 0, buffer.byteLength);
  const header = chunks.find((c) => c.type === 0x01000100);
  if (!header) throw new Error('不是有效的爱笔思画 ipv 文件');
  const W = dv.getUint32(header.start + 8);
  const H = dv.getUint32(header.start + 12);
  const appInfo = chunks.find((c) => c.type === 0x01000200);
  let version = '';
  if (appInfo) {
    // u16 ?, u16 ?, f64 time, str app name, str version, str device
    let p = appInfo.start + 12;
    const s1 = dv.getUint16(p);
    p += 2 + s1;
    const s2 = dv.getUint16(p);
    version = utf8.decode(bytes.subarray(p + 2, p + 2 + s2));
  }

  // the snapshot: last image record of each layer id after the last 01000300 marker
  let lastMarker = -1;
  chunks.forEach((c, i) => {
    if (c.type === 0x01000300) lastMarker = i;
  });
  const images = new Map<number, Chunk>();
  for (let i = lastMarker + 1; i < chunks.length; i++) {
    const c = chunks[i];
    if (c.type === 0x01000500) images.set(dv.getInt32(c.start + 8), c);
  }
  const meta = [...chunks].reverse().find((c) => c.type === 0x01000600);
  if (!meta) throw new Error('ipv 文件缺少图层信息');
  const records = readLayerRecords(dv, bytes, meta.start, meta.start + meta.length).filter((r) => r.id >= 0);

  // ---- tree: records are bottom -> top, a folder record follows its children
  const warnings: string[] = [];
  const nodes = new Map<string, EngineNode>();
  const byIpvId = new Map<number, EngineNode>();
  const roots: EngineNode[] = [];
  let counter = 0;
  const unknownBlend = new Set<number>();
  for (const r of records) {
    // folders are isolated groups; their blend number uses the same table
    const additive = !r.folder && IPV_ADDITIVE.has(r.blendCode);
    const blendMode = additive ? 'linear dodge' : IPV_BLEND[r.blendCode];
    const node: EngineNode = {
      id: `L${counter++}`,
      kind: r.folder ? 'group' : 'layer',
      // older versions leave default names empty
      name: r.name || (r.folder ? `组 ${r.id}` : `图层 ${r.id}`),
      hidden: !r.visible,
      opacity: Math.max(0, Math.min(1, r.opacity)),
      fill: 1,
      blendMode: blendMode ?? 'normal',
      clipping: r.clipping,
      // SAI-style linear dodge = Cd + Cs·α, used for ibisPaint's "Add"
      special: additive,
      children: [],
      bbox: null,
      hasMask: false,
      effects: [],
      unsupported: blendMode ? [] : [`爱笔思画混合模式 #${r.blendCode}（按正常处理）`],
      sourceBlendCode: r.blendCode,
    };
    if (additive) {
      // "Add" sums Cs·α·opacity onto the backdrop: opacity acts before the
      // blend, which the engine's special mode does with fill
      node.fill = node.opacity;
      node.opacity = 1;
    }
    if (!blendMode) unknownBlend.add(r.blendCode);
    nodes.set(node.id, node);
    byIpvId.set(r.id, node);
  }
  // children of folders in record order; folders appear after their children,
  // so attach in a second pass
  for (const r of records) {
    const node = byIpvId.get(r.id)!;
    const parent = r.parent >= 0 ? byIpvId.get(r.parent) : undefined;
    if (parent && parent.kind === 'group') parent.children.push(node);
    else roots.push(node);
  }
  if (unknownBlend.size) warnings.push(`有图层使用了尚未支持的爱笔思画混合模式（${[...unknownBlend].join('、')}），按正常模式处理。`);

  // ---- pixels
  const factors = [1, ...(opts.levelFactorsFor ? opts.levelFactorsFor(W, H) : opts.levelFactors ?? [])];
  const levels: Level[] = factors.map((k) => newLevel(k, W, H));
  const thumbs = new Map<string, { width: number; height: number; data: Uint8ClampedArray }>();
  const leaves = records.filter((r) => !r.folder);
  let done = 0;
  let lastYield = performance.now();
  for (const r of leaves) {
    const node = byIpvId.get(r.id)!;
    const c = images.get(r.id);
    if (c) {
      const flags = dv.getUint32(c.start + 12);
      const size = dv.getUint32(c.start + 18);
      const dataStart = c.start + 22;
      if (size > 0) {
        let img: LayerImage | null = null;
        try {
          if ((flags & 0xff) === 1) img = await decodeRpng(dv, bytes, dataStart, dataStart + size);
          else {
            const png = await decodePng(bytes.subarray(dataStart, dataStart + size));
            img = { data: png.data, left: 0, top: 0, width: png.width, height: png.height };
          }
        } catch (err) {
          warnings.push(`图层「${node.name}」图像解码失败：${(err as Error).message}`);
        }
        if (img) {
          const full = storeFull(levels[0], img.data, img.width, img.height, img.left, img.top);
          node.bbox = full.bbox;
          if (full.bbox) {
            levels[0].layers.set(node.id, full.blocks);
            for (let li = 1; li < levels.length; li++) {
              levels[li].layers.set(node.id, storeScaled(levels[li], img.data, img.width, img.height, img.left, img.top, W, H, full.blocks));
            }
            const size = opts.thumbSize ?? 48;
            if (size > 0) {
              const last = levels[levels.length - 1];
              const t = levels.length > 1 ? thumbFromLevel(last, last.layers.get(node.id)!, full.bbox, size) : makeThumb(img.data, img.width, img.height, size);
              if (t) thumbs.set(node.id, t);
            }
          }
        }
      }
    }
    done++;
    if (opts.onProgress && (performance.now() - lastYield > 60 || done === leaves.length)) {
      opts.onProgress(done, leaves.length, node.name);
      await yieldNow();
      lastYield = performance.now();
    }
  }

  // group bboxes = union of descendants
  const unionBox = (n: EngineNode): [number, number, number, number] | null => {
    if (n.kind === 'layer') return n.bbox;
    let box: [number, number, number, number] | null = null;
    for (const c of n.children) {
      const b = unionBox(c);
      if (b) box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : [...b];
    }
    n.bbox = box;
    return box;
  };
  roots.forEach(unionBox);

  // merged canvas (layer id −1, plain PNG)
  let composite: Uint8ClampedArray | null = null;
  const merged = images.get(-1);
  if (opts.keepComposite && merged) {
    const size = dv.getUint32(merged.start + 18);
    if (size > 0) {
      try {
        const png = await decodePng(bytes.subarray(merged.start + 22, merged.start + 22 + size));
        if (png.width === W && png.height === H) composite = png.data;
      } catch {
        composite = null;
      }
    }
  }

  return {
    width: W,
    height: H,
    bitsPerChannel: 8,
    colorMode: 3,
    writer: `ibisPaint ${version}`.trim(),
    roots,
    nodes,
    levels,
    patterns: new Map(),
    composite,
    thumbs,
    warnings,
  };
}
