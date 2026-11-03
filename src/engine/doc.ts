/**
 * Engine document: the PSD decoded into a compact, render-friendly form.
 *
 * - Layer pixels are stored as document-aligned BLOCK×BLOCK RGBA tiles and
 *   fully transparent tiles are not stored at all. On real artwork that is
 *   ~3× less memory than one bitmap per layer, which is what makes full-size
 *   exports possible inside an Android WebView.
 * - Besides the full-resolution level (used for export, pixel exact) there are
 *   integer box-filtered levels for the live preview and for thumbnails.
 * - Layers are decoded one at a time from ag-psd's raw (still compressed)
 *   channel data, so peak memory is the block store plus a single layer.
 *
 * DOM free: runs in a Web Worker and in Node (tests).
 */

import {
  readPsd,
  initializeCanvas,
  getLayerImageData,
  getLayerMaskImageData,
  getLayerRealMaskImageData,
  getCompositeImageData,
  type Layer as AgLayer,
  type Psd,
  type PixelData,
} from 'ag-psd';
import { isKnownBlend } from './blend';

export const BLOCK = 64;
const BLOCK_PX = BLOCK * BLOCK;

let canvasReady = false;
/** ag-psd wants a canvas factory; we only ever need plain pixel buffers. */
export function ensureAgPsd(): void {
  if (canvasReady) return;
  canvasReady = true;
  initializeCanvas(
    () => {
      throw new Error('canvas not available in the engine');
    },
    (width: number, height: number) =>
      ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as unknown as ImageData,
  );
}

/* Types */

export interface OverlayEffect {
  kind: 'pattern' | 'color';
  blendMode: string;
  opacity: number;
  /** color overlay: straight RGB 0..1 */
  color?: [number, number, number];
  /** pattern overlay */
  patternId?: string;
  scale?: number;
  phaseX?: number;
  phaseY?: number;
  /** pattern origin in document pixels (layer origin when linked) */
  originX?: number;
  originY?: number;
}

export interface EngineNode {
  id: string;
  kind: 'layer' | 'group';
  name: string;
  hidden: boolean;
  opacity: number;
  fill: number;
  blendMode: string;
  clipping: boolean;
  /** "transparency shapes layer" off: SAI-style blending, fill before / opacity after */
  special: boolean;
  /** bottom -> top, exactly like the PSD records */
  children: EngineNode[];
  /** content bounds in document pixels, clamped to the canvas; null = empty */
  bbox: [number, number, number, number] | null;
  hasMask: boolean;
  effects: OverlayEffect[];
  /** human readable notes about features we cannot reproduce */
  unsupported: string[];
  /** blend mode number in the source file, for formats that use numbers (ibisPaint) */
  sourceBlendCode?: number;
}

export interface Blocks {
  blocks: (Uint8Array | null)[];
}

export interface MaskBlocks {
  /** one byte per pixel; null = whole block equals `def` */
  blocks: (Uint8Array | null)[];
  def: number;
}

export interface Level {
  /** integer down-scale factor (1 = full resolution) */
  k: number;
  width: number;
  height: number;
  bw: number;
  bh: number;
  layers: Map<string, Blocks>;
  masks: Map<string, MaskBlocks>;
}

export interface Pattern {
  width: number;
  height: number;
  /** straight RGBA */
  data: Uint8Array;
}

export interface EngineDoc {
  width: number;
  height: number;
  bitsPerChannel: number;
  colorMode: number;
  /** application that wrote the file ("Adobe Photoshop"; empty when unknown) */
  writer: string;
  roots: EngineNode[];
  nodes: Map<string, EngineNode>;
  levels: Level[];
  patterns: Map<string, Pattern>;
  /** PSD's own merged image (straight RGBA) when present and requested */
  composite: Uint8ClampedArray | null;
  /** small per-layer thumbnails for the layer picker */
  thumbs: Map<string, { width: number; height: number; data: Uint8ClampedArray }>;
  warnings: string[];
  /** decode time per stage (ms), for diagnostics */
  stats?: Record<string, number>;
}

export interface DecodeProgress {
  (done: number, total: number, label: string): void;
}

export interface DecodeOptions {
  /** extra down-scaled levels, e.g. [3, 12] */
  levelFactors?: number[];
  /** alternative to `levelFactors` that can look at the document size */
  levelFactorsFor?: (width: number, height: number) => number[];
  keepComposite?: boolean;
  thumbSize?: number;
  onProgress?: DecodeProgress;
}

/* Helpers */

export function newLevel(k: number, W: number, H: number): Level {
  const width = Math.ceil(W / k);
  const height = Math.ceil(H / k);
  return {
    k,
    width,
    height,
    bw: Math.ceil(width / BLOCK),
    bh: Math.ceil(height / BLOCK),
    layers: new Map(),
    masks: new Map(),
  };
}

/** Normalise 8/16/32-bit pixel arrays to 8-bit. */
function to8(data: PixelData['data']): Uint8Array | Uint8ClampedArray {
  if (data instanceof Uint8ClampedArray || data instanceof Uint8Array) return data;
  const out = new Uint8Array(data.length);
  if (data instanceof Uint16Array) for (let i = 0; i < data.length; i++) out[i] = Math.round(data[i] / 257);
  else for (let i = 0; i < data.length; i++) out[i] = Math.round(Math.min(1, Math.max(0, data[i])) * 255);
  return out;
}

/**
 * Copy an RGBA image positioned at (ox, oy) in document space into sparse
 * blocks of a full resolution level. Returns the clamped content bbox.
 */
export function storeFull(
  level: Level,
  img: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  ox: number,
  oy: number,
): { blocks: Blocks; bbox: [number, number, number, number] | null } {
  const blocks: (Uint8Array | null)[] = new Array(level.bw * level.bh).fill(null);
  const x0 = Math.max(0, ox);
  const y0 = Math.max(0, oy);
  const x1 = Math.min(level.width, ox + w);
  const y1 = Math.min(level.height, oy + h);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  if (x1 <= x0 || y1 <= y0) return { blocks: { blocks }, bbox: null };

  const bx0 = Math.floor(x0 / BLOCK);
  const by0 = Math.floor(y0 / BLOCK);
  const bx1 = Math.floor((x1 - 1) / BLOCK);
  const by1 = Math.floor((y1 - 1) / BLOCK);
  for (let by = by0; by <= by1; by++) {
    for (let bx = bx0; bx <= bx1; bx++) {
      const gx0 = Math.max(x0, bx * BLOCK);
      const gy0 = Math.max(y0, by * BLOCK);
      const gx1 = Math.min(x1, (bx + 1) * BLOCK);
      const gy1 = Math.min(y1, (by + 1) * BLOCK);
      // any alpha in this block?
      let any = false;
      for (let y = gy0; y < gy1 && !any; y++) {
        let si = ((y - oy) * w + (gx0 - ox)) * 4 + 3;
        for (let x = gx0; x < gx1; x++, si += 4) {
          if (img[si] !== 0) {
            any = true;
            break;
          }
        }
      }
      if (!any) continue;
      const blk = new Uint8Array(BLOCK_PX * 4);
      for (let y = gy0; y < gy1; y++) {
        const si = ((y - oy) * w + (gx0 - ox)) * 4;
        const di = ((y - by * BLOCK) * BLOCK + (gx0 - bx * BLOCK)) * 4;
        blk.set(img.subarray(si, si + (gx1 - gx0) * 4), di);
        for (let x = gx0; x < gx1; x++) {
          if (img[si + (x - gx0) * 4 + 3] !== 0) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      blocks[by * level.bw + bx] = blk;
    }
  }
  const bbox: [number, number, number, number] | null =
    maxX >= minX ? [minX, minY, maxX + 1, maxY + 1] : null;
  return { blocks: { blocks }, bbox };
}

let colBuf = new Int32Array(0);
function colTable(x0: number, x1: number, k: number, tx0: number): Int32Array {
  if (colBuf.length < x1 - x0) colBuf = new Int32Array(x1 - x0);
  for (let x = x0; x < x1; x++) colBuf[x - x0] = (Math.floor(x / k) - tx0) * 4;
  return colBuf;
}

let scratchBuf = new Float32Array(0);
/** Reusable accumulator (one per worker; decoding is sequential). */
function scratch(n: number): Float32Array {
  if (scratchBuf.length < n) scratchBuf = new Float32Array(n);
  return scratchBuf;
}

/** Box-filter a full-res RGBA image into a down-scaled level (premultiplied average). */
export function storeScaled(
  level: Level,
  img: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  ox: number,
  oy: number,
  W: number,
  H: number,
  full?: Blocks,
): Blocks {
  const k = level.k;
  const blocks: (Uint8Array | null)[] = new Array(level.bw * level.bh).fill(null);
  const x0 = Math.max(0, ox);
  const y0 = Math.max(0, oy);
  const x1 = Math.min(W, ox + w);
  const y1 = Math.min(H, oy + h);
  if (x1 <= x0 || y1 <= y0) return { blocks };
  const tx0 = Math.floor(x0 / k);
  const ty0 = Math.floor(y0 / k);
  const tx1 = Math.floor((x1 - 1) / k) + 1;
  const ty1 = Math.floor((y1 - 1) / k) + 1;
  const tw = tx1 - tx0;
  const th = ty1 - ty0;
  const acc = scratch(tw * th * 4);
  // Source rectangles to visit: the non-empty full-resolution blocks when
  // known (layers saved full-canvas but mostly transparent made this loop
  // scan millions of empty pixels per layer), else everything. Skipped pixels
  // have alpha 0 and never contributed; the sums are exact integers in
  // float32, so the order of accumulation doesn't change the result.
  const rects: [number, number, number, number][] = [];
  if (full) {
    const fb = full.blocks;
    const bw = Math.ceil(W / BLOCK);
    for (let bi = 0; bi < fb.length; bi++) {
      if (!fb[bi]) continue;
      const bx = bi % bw;
      const by = (bi - bx) / bw;
      const rx0 = Math.max(x0, bx * BLOCK);
      const ry0 = Math.max(y0, by * BLOCK);
      const rx1 = Math.min(x1, (bx + 1) * BLOCK);
      const ry1 = Math.min(y1, (by + 1) * BLOCK);
      if (rx1 > rx0 && ry1 > ry0) rects.push([rx0, ry0, rx1, ry1]);
    }
  } else rects.push([x0, y0, x1, y1]);
  // clear the cells we touch, accumulate, then emit those cells
  for (const [rx0, ry0, rx1, ry1] of rects) {
    const cx0 = Math.floor(rx0 / k) - tx0;
    const cx1 = Math.floor((rx1 - 1) / k) - tx0;
    for (let cy = Math.floor(ry0 / k) - ty0; cy <= Math.floor((ry1 - 1) / k) - ty0; cy++) acc.fill(0, (cy * tw + cx0) * 4, (cy * tw + cx1 + 1) * 4);
  }
  // column -> accumulator offset, computed once instead of a division per pixel
  const colOff = colTable(x0, x1, k, tx0);
  for (const [rx0, ry0, rx1, ry1] of rects) {
    for (let y = ry0; y < ry1; y++) {
      const row = (Math.floor(y / k) - ty0) * tw * 4;
      let si = ((y - oy) * w + (rx0 - ox)) * 4;
      for (let x = rx0; x < rx1; x++, si += 4) {
        const a = img[si + 3];
        if (a === 0) continue;
        const ti = row + colOff[x - x0];
        acc[ti] += img[si] * a;
        acc[ti + 1] += img[si + 1] * a;
        acc[ti + 2] += img[si + 2] * a;
        acc[ti + 3] += a;
      }
    }
  }
  // the full block area is k*k document pixels (edge cells are smaller but rare)
  const area = k * k;
  for (const [rx0, ry0, rx1, ry1] of rects) {
  for (let ty = Math.floor(ry0 / k); ty <= Math.floor((ry1 - 1) / k); ty++) {
    for (let tx = Math.floor(rx0 / k); tx <= Math.floor((rx1 - 1) / k); tx++) {
      const ti = ((ty - ty0) * tw + (tx - tx0)) * 4;
      const sa = acc[ti + 3];
      if (sa === 0) continue;
      const cellW = Math.min(W, (tx + 1) * k) - tx * k;
      const cellH = Math.min(H, (ty + 1) * k) - ty * k;
      const a = sa / (cellW * cellH || area);
      const bi = Math.floor(ty / BLOCK) * level.bw + Math.floor(tx / BLOCK);
      let blk = blocks[bi];
      if (!blk) blk = blocks[bi] = new Uint8Array(BLOCK_PX * 4);
      const di = ((ty % BLOCK) * BLOCK + (tx % BLOCK)) * 4;
      blk[di] = Math.round(acc[ti] / sa);
      blk[di + 1] = Math.round(acc[ti + 1] / sa);
      blk[di + 2] = Math.round(acc[ti + 2] / sa);
      blk[di + 3] = Math.max(1, Math.round(a));
    }
  }
  }
  return { blocks };
}

/** Store a grey mask (one byte per pixel) at a level, with default value outside. */
function storeMask(
  level: Level,
  mask: Uint8Array,
  w: number,
  h: number,
  ox: number,
  oy: number,
  def: number,
  W: number,
  H: number,
): MaskBlocks {
  const k = level.k;
  const blocks: (Uint8Array | null)[] = new Array(level.bw * level.bh).fill(null);
  // mask value at document pixel
  const at = (x: number, y: number): number => {
    const mx = x - ox;
    const my = y - oy;
    if (mx < 0 || my < 0 || mx >= w || my >= h) return def;
    return mask[my * w + mx];
  };
  // only blocks overlapping the mask rect can differ from `def`
  const x0 = Math.max(0, Math.floor(ox / k));
  const y0 = Math.max(0, Math.floor(oy / k));
  const x1 = Math.min(level.width, Math.ceil((ox + w) / k));
  const y1 = Math.min(level.height, Math.ceil((oy + h) / k));
  if (x1 <= x0 || y1 <= y0) return { blocks, def };
  for (let by = Math.floor(y0 / BLOCK); by <= Math.floor((y1 - 1) / BLOCK); by++) {
    for (let bx = Math.floor(x0 / BLOCK); bx <= Math.floor((x1 - 1) / BLOCK); bx++) {
      const blk = new Uint8Array(BLOCK_PX).fill(def);
      let differs = false;
      for (let ly = 0; ly < BLOCK; ly++) {
        const ty = by * BLOCK + ly;
        if (ty >= level.height) break;
        for (let lx = 0; lx < BLOCK; lx++) {
          const tx = bx * BLOCK + lx;
          if (tx >= level.width) break;
          let v: number;
          if (k === 1) v = at(tx, ty);
          else {
            let sum = 0;
            let n = 0;
            for (let yy = ty * k; yy < Math.min(H, ty * k + k); yy++)
              for (let xx = tx * k; xx < Math.min(W, tx * k + k); xx++) {
                sum += at(xx, yy);
                n++;
              }
            v = n ? Math.round(sum / n) : def;
          }
          blk[ly * BLOCK + lx] = v;
          if (v !== def) differs = true;
        }
      }
      if (differs) blocks[by * level.bw + bx] = blk;
    }
  }
  return { blocks, def };
}

/**
 * Layer-picker thumbnail from the smallest level's blocks (cropped to the
 * layer's content box): a few thousand pixels instead of the full layer.
 */
export function thumbFromLevel(level: Level, blocks: Blocks, bbox: [number, number, number, number], size: number) {
  const k = level.k;
  const lx0 = Math.floor(bbox[0] / k);
  const ly0 = Math.floor(bbox[1] / k);
  const lx1 = Math.min(level.width, Math.floor((bbox[2] - 1) / k) + 1);
  const ly1 = Math.min(level.height, Math.floor((bbox[3] - 1) / k) + 1);
  const w = lx1 - lx0;
  const h = ly1 - ly0;
  if (w <= 0 || h <= 0) return null;
  const img = new Uint8ClampedArray(w * h * 4);
  for (let y = ly0; y < ly1; y++) {
    for (let x = lx0; x < lx1; x++) {
      const blk = blocks.blocks[Math.floor(y / BLOCK) * level.bw + Math.floor(x / BLOCK)];
      if (!blk) continue;
      const si = ((y % BLOCK) * BLOCK + (x % BLOCK)) * 4;
      const di = ((y - ly0) * w + (x - lx0)) * 4;
      img[di] = blk[si];
      img[di + 1] = blk[si + 1];
      img[di + 2] = blk[si + 2];
      img[di + 3] = blk[si + 3];
    }
  }
  return makeThumb(img, w, h, size);
}

export function makeThumb(
  img: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  size: number,
): { width: number; height: number; data: Uint8ClampedArray } | null {
  // crop to content
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    let i = y * w * 4 + 3;
    for (let x = 0; x < w; x++, i += 4) {
      if (img[i]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const s = Math.min(1, size / Math.max(cw, ch));
  const tw = Math.max(1, Math.round(cw * s));
  const th = Math.max(1, Math.round(ch * s));
  const acc = new Float32Array(tw * th * 5);
  for (let y = minY; y <= maxY; y++) {
    const ty = Math.min(th - 1, Math.floor((y - minY) * s));
    let i = (y * w + minX) * 4;
    for (let x = minX; x <= maxX; x++, i += 4) {
      const tx = Math.min(tw - 1, Math.floor((x - minX) * s));
      const ti = (ty * tw + tx) * 5;
      const a = img[i + 3];
      acc[ti] += img[i] * a;
      acc[ti + 1] += img[i + 1] * a;
      acc[ti + 2] += img[i + 2] * a;
      acc[ti + 3] += a;
      acc[ti + 4] += 1;
    }
  }
  const out = new Uint8ClampedArray(tw * th * 4);
  for (let i = 0; i < tw * th; i++) {
    const a = acc[i * 5 + 3];
    if (!a) continue;
    out[i * 4] = acc[i * 5] / a;
    out[i * 4 + 1] = acc[i * 5 + 1] / a;
    out[i * 4 + 2] = acc[i * 5 + 2] / a;
    out[i * 4 + 3] = a / acc[i * 5 + 4];
  }
  return { width: tw, height: th, data: out };
}

function colorToRgb(c: any): [number, number, number] {
  if (!c) return [0, 0, 0];
  if ('r' in c) return [c.r / 255, c.g / 255, c.b / 255];
  if ('fr' in c) return [c.fr, c.fg, c.fb];
  if ('k' in c && 'c' in c) {
    const k = c.k / 255;
    return [(1 - c.c / 255) * (1 - k), (1 - c.m / 255) * (1 - k), (1 - c.y / 255) * (1 - k)];
  }
  return [0, 0, 0];
}

function readEffects(layer: AgLayer, node: EngineNode): void {
  const fx = layer.effects;
  if (!fx || fx.disabled) return;
  const on = (e: { enabled?: boolean } | undefined) => !!e && e.enabled !== false;
  const list = (v: any) => (Array.isArray(v) ? v : v ? [v] : []);

  // Photoshop stacks interior overlays (bottom -> top): pattern, gradient, colour.
  const po = fx.patternOverlay as any;
  if (on(po) && po.pattern?.id) {
    const linked = po.align !== false;
    node.effects.push({
      kind: 'pattern',
      blendMode: po.blendMode ?? 'normal',
      opacity: po.opacity ?? 1,
      patternId: po.pattern.id,
      scale: po.scale ?? 1,
      phaseX: po.phase?.x ?? 0,
      phaseY: po.phase?.y ?? 0,
      originX: linked ? layer.left ?? 0 : 0,
      originY: linked ? layer.top ?? 0 : 0,
    });
  }
  if (list(fx.gradientOverlay).some(on)) node.unsupported.push('渐变叠加');
  for (const sf of list(fx.solidFill)) {
    if (!on(sf)) continue;
    node.effects.push({
      kind: 'color',
      blendMode: sf.blendMode ?? 'normal',
      opacity: sf.opacity ?? 1,
      color: colorToRgb(sf.color),
    });
  }
  if (list(fx.dropShadow).some(on)) node.unsupported.push('投影');
  if (list(fx.innerShadow).some(on)) node.unsupported.push('内阴影');
  if (on(fx.outerGlow)) node.unsupported.push('外发光');
  if (on(fx.innerGlow)) node.unsupported.push('内发光');
  if (on(fx.bevel)) node.unsupported.push('斜面和浮雕');
  if (on(fx.satin)) node.unsupported.push('光泽');
  if (list(fx.stroke).some(on)) node.unsupported.push('描边');
}

/**
 * Pre-scale a pattern tile the way Photoshop's pattern overlay does it as
 * closely as we can: premultiplied area (box) resampling to a tile of
 * round(w·s)×round(h·s) pixels, followed by a light [¼ ½ ¼] smoothing that
 * matches Photoshop's softer resampler. Photoshop's exact filter is not
 * documented; at 100 % scale no resampling happens and the result is exact.
 */
export function scalePattern(p: Pattern, s: number): Pattern {
  if (Math.abs(s - 1) < 1e-6) return p;
  const tw = Math.max(1, Math.round(p.width * s));
  const th = Math.max(1, Math.round(p.height * s));
  const sx = p.width / tw;
  const sy = p.height / th;
  // premultiplied source
  const src = new Float64Array(p.width * p.height * 4);
  for (let i = 0; i < p.width * p.height; i++) {
    const a = p.data[i * 4 + 3];
    src[i * 4] = p.data[i * 4] * a;
    src[i * 4 + 1] = p.data[i * 4 + 1] * a;
    src[i * 4 + 2] = p.data[i * 4 + 2] * a;
    src[i * 4 + 3] = a;
  }
  // separable resample; box filter when shrinking, linear when enlarging
  const weights = (n: number, srcN: number, scale: number) => {
    const out: { i: number; w: number }[][] = [];
    for (let t = 0; t < n; t++) {
      const list: { i: number; w: number }[] = [];
      if (scale >= 1) {
        const a = t * scale;
        const b = a + scale;
        for (let i = Math.floor(a); i < Math.ceil(b); i++) {
          const w = Math.min(b, i + 1) - Math.max(a, i);
          if (w > 0) list.push({ i: ((i % srcN) + srcN) % srcN, w: w / scale });
        }
      } else {
        const c = (t + 0.5) * scale - 0.5;
        const i0 = Math.floor(c);
        const f = c - i0;
        list.push({ i: ((i0 % srcN) + srcN) % srcN, w: 1 - f }, { i: (((i0 + 1) % srcN) + srcN) % srcN, w: f });
      }
      out.push(list);
    }
    return out;
  };
  const wx = weights(tw, p.width, sx);
  const wy = weights(th, p.height, sy);
  const tmp = new Float64Array(tw * p.height * 4);
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < tw; x++)
      for (const { i, w } of wx[x]) for (let c = 0; c < 4; c++) tmp[(y * tw + x) * 4 + c] += src[(y * p.width + i) * 4 + c] * w;
  let acc = new Float64Array(tw * th * 4);
  for (let y = 0; y < th; y++)
    for (const { i, w } of wy[y])
      for (let x = 0; x < tw; x++) for (let c = 0; c < 4; c++) acc[(y * tw + x) * 4 + c] += tmp[(i * tw + x) * 4 + c] * w;
  // [1/4 1/2 1/4] smoothing with wrap-around (the tile repeats)
  for (const horiz of [true, false]) {
    const out = new Float64Array(acc.length);
    for (let y = 0; y < th; y++)
      for (let x = 0; x < tw; x++) {
        const a = horiz ? y * tw + ((x + tw - 1) % tw) : ((y + th - 1) % th) * tw + x;
        const b = horiz ? y * tw + ((x + 1) % tw) : ((y + 1) % th) * tw + x;
        const o = y * tw + x;
        for (let c = 0; c < 4; c++) out[o * 4 + c] = acc[a * 4 + c] * 0.25 + acc[o * 4 + c] * 0.5 + acc[b * 4 + c] * 0.25;
      }
    acc = out;
  }
  const data = new Uint8Array(tw * th * 4);
  for (let i = 0; i < tw * th; i++) {
    const a = acc[i * 4 + 3];
    if (a <= 0) continue;
    data[i * 4] = Math.round(acc[i * 4] / a);
    data[i * 4 + 1] = Math.round(acc[i * 4 + 1] / a);
    data[i * 4 + 2] = Math.round(acc[i * 4 + 2] / a);
    data[i * 4 + 3] = Math.round(a);
  }
  return { width: tw, height: th, data };
}

/**
 * Apps that only write the legacy (Pascal) layer name store it in the system
 * code page; ag-psd reads it as Latin-1, giving mojibake like "µ×É«1". Re-decode
 * such names as GBK / Big5 / Shift-JIS when that yields CJK text.
 */
export function fixLegacyName(name: string): string {
  if (!/[\u0080-\u00ff]/.test(name) || /[^\u0000-\u00ff]/.test(name)) return name;
  const bytes = Uint8Array.from(name, (c) => c.charCodeAt(0));
  for (const enc of ['gbk', 'big5', 'shift_jis']) {
    try {
      const text = new TextDecoder(enc, { fatal: true }).decode(bytes);
      if (/[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/.test(text)) return text;
    } catch {
      /* not this encoding */
    }
  }
  return name;
}

/* Decode */

/** Let the worker take messages (progress, cancel) without setTimeout's clamping. */
export function yieldNow(): Promise<void> {
  return new Promise((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => r();
    ch.port2.postMessage(0);
  });
}

export async function decodeDocument(buffer: ArrayBuffer, opts: DecodeOptions = {}): Promise<EngineDoc> {
  ensureAgPsd();
  const stats: Record<string, number> = { parse: 0, rle: 0, store: 0, scaled: 0, thumb: 0, mask: 0, yield: 0 };
  let tt = performance.now();
  const lap = (k: string) => {
    const now = performance.now();
    stats[k] += now - tt;
    tt = now;
  };
  const psd: Psd = readPsd(buffer, {
    useRawData: true,
    skipThumbnail: true,
    skipLinkedFilesData: true,
    skipCompositeImageData: !opts.keepComposite,
  });

  lap('parse');
  const W = psd.width;
  const H = psd.height;
  const factors = [1, ...(opts.levelFactorsFor ? opts.levelFactorsFor(W, H) : opts.levelFactors ?? [])];
  const levels = factors.map((k) => newLevel(k, W, H));
  const warnings: string[] = [];
  if ((psd.bitsPerChannel ?? 8) !== 8) {
    warnings.push(`文档为 ${psd.bitsPerChannel} 位/通道，导出时转换为 8 位。`);
  }

  const patterns = new Map<string, Pattern>();
  for (const p of (psd as any).patterns ?? []) {
    if (!p?.data || !p.bounds) continue;
    patterns.set(p.id, { width: p.bounds.w, height: p.bounds.h, data: p.data });
  }

  const nodes = new Map<string, EngineNode>();
  const agById = new Map<string, AgLayer>();
  let counter = 0;
  const walk = (layer: AgLayer): EngineNode => {
    const isGroup = Array.isArray(layer.children);
    const id = `L${counter++}`;
    // The CLI only switches to SAI blending when `iOpa` is present, but Photoshop
    // applies the same formulas to any layer saved with tsly = 0.
    const special = layer.transparencyShapesLayer === false;
    const node: EngineNode = {
      id,
      kind: isGroup ? 'group' : 'layer',
      name: fixLegacyName(layer.name ?? ''),
      hidden: !!layer.hidden,
      opacity: layer.opacity ?? 1,
      fill: layer.fillOpacity ?? 1,
      blendMode: layer.blendMode ?? 'normal',
      clipping: !!layer.clipping,
      special,
      children: [],
      bbox: null,
      hasMask: false,
      effects: [],
      unsupported: [],
    };
    if (!isKnownBlend(node.blendMode)) node.unsupported.push(`混合模式 ${node.blendMode}`);
    if (node.blendMode === 'dissolve') node.unsupported.push('溶解模式按正常处理');
    if (layer.adjustment) node.unsupported.push(`调整图层（${layer.adjustment.type}）`);
    if (layer.vectorMask && !layer.mask?.fromVectorData) node.unsupported.push('矢量蒙版');
    if (layer.text && !isGroup) node.unsupported.push('文字图层按栅格化结果显示');
    if (layer.placedLayer) node.unsupported.push('智能对象按栅格化结果显示');
    readEffects(layer, node);
    for (const e of node.effects) {
      if (e.kind === 'pattern' && !patterns.has(e.patternId!)) node.unsupported.push('图案叠加（PSD 中缺少图案数据）');
    }
    nodes.set(id, node);
    agById.set(id, layer);
    if (isGroup) node.children = (layer.children ?? []).map(walk);
    return node;
  };
  const roots = (psd.children ?? []).map(walk);

  const thumbs = new Map<string, { width: number; height: number; data: Uint8ClampedArray }>();
  const all = [...nodes.values()];
  const total = all.length;
  let done = 0;
  const thumbSize = opts.thumbSize ?? 48;

  tt = performance.now();
  let lastYield = tt;
  for (const node of all) {
    const ag = agById.get(node.id)!;
    if (node.kind === 'layer') {
      let img: PixelData | undefined;
      try {
        img = getLayerImageData(ag) as PixelData | undefined;
      } catch (err) {
        warnings.push(`图层「${node.name}」解码失败：${(err as Error).message}`);
      }
      lap('rle');
      if (img && img.width && img.height) {
        const px = to8(img.data);
        const ox = ag.left ?? 0;
        const oy = ag.top ?? 0;
        const full = storeFull(levels[0], px, img.width, img.height, ox, oy);
        node.bbox = full.bbox;
        lap('store');
        if (full.bbox) {
          levels[0].layers.set(node.id, full.blocks);
          for (let li = 1; li < levels.length; li++) {
            levels[li].layers.set(node.id, storeScaled(levels[li], px, img.width, img.height, ox, oy, W, H, full.blocks));
          }
          lap('scaled');
          if (thumbSize > 0) {
            const last = levels[levels.length - 1];
            const t = levels.length > 1 ? thumbFromLevel(last, last.layers.get(node.id)!, full.bbox, thumbSize) : makeThumb(px, img.width, img.height, thumbSize);
            if (t) thumbs.set(node.id, t);
          }
          lap('thumb');
        }
      }
    }

    // pixel mask (layers and groups)
    const m = ag.realMask ?? ag.mask;
    if (m && !m.disabled) {
      let mimg: PixelData | undefined;
      try {
        mimg = (ag.realMask ? getLayerRealMaskImageData(ag) : getLayerMaskImageData(ag)) as PixelData | undefined;
      } catch {
        mimg = undefined;
      }
      const def = m.defaultColor ?? 0;
      const mw = mimg?.width ?? 0;
      const mh = mimg?.height ?? 0;
      const grey = new Uint8Array(mw * mh);
      if (mimg) {
        const src = to8(mimg.data);
        for (let i = 0; i < mw * mh; i++) grey[i] = src[i * 4];
      }
      const ox = m.left ?? 0;
      const oy = m.top ?? 0;
      if (mw * mh > 0 || def !== 255) {
        node.hasMask = true;
        for (const level of levels) {
          level.masks.set(node.id, storeMask(level, grey, mw, mh, ox, oy, def, W, H));
        }
      }
    }

    lap('mask');
    done++;
    if (opts.onProgress && (performance.now() - lastYield > 60 || done === total)) {
      opts.onProgress(done, total, node.name);
      await yieldNow();
      lastYield = performance.now();
    }
    lap('yield');
    // free the compressed channel data as we go
    (ag as any).rawData = undefined;
    if (ag.mask) (ag.mask as any).imageData = undefined;
  }

  // group bboxes = union of descendants
  const unionBox = (n: EngineNode): [number, number, number, number] | null => {
    if (n.kind === 'layer') return n.bbox;
    let box: [number, number, number, number] | null = null;
    for (const c of n.children) {
      const b = unionBox(c);
      if (!b) continue;
      box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : [...b];
    }
    n.bbox = box;
    return box;
  };
  roots.forEach(unionBox);

  let composite: Uint8ClampedArray | null = null;
  if (opts.keepComposite) {
    try {
      const id = getCompositeImageData(psd) as PixelData | undefined;
      if (id && id.width === W && id.height === H) composite = new Uint8ClampedArray(to8(id.data));
    } catch {
      composite = null;
    }
  }

  return {
    width: W,
    height: H,
    bitsPerChannel: psd.bitsPerChannel ?? 8,
    colorMode: psd.colorMode ?? 3,
    writer: psd.imageResources?.versionInfo?.writerName ?? '',
    roots,
    nodes,
    levels,
    patterns,
    composite,
    thumbs,
    warnings,
    stats,
  };
}
