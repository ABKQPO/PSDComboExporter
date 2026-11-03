/**
 * Tile compositor.
 *
 * Structure is a port of `psd_export/composite.py::composite_group_layer`
 * (clip grouping, pass-through backdrops, clipping layers painted onto the
 * base colour, blend -> mask -> alpha union). Two arithmetic back-ends:
 *
 *  - 'ps8'  (default for 8-bit documents): straight 8-bit integer colour with
 *    Photoshop's rounding, i.e. B = round(f(Cd, Cs)) then
 *    Cr = round((B·α + Cd·(255−α)) / 255). This reproduces the merged image
 *    Photoshop stores in the PSD bit for bit on real artwork.
 *  - 'float': premultiplied float32, identical to the float build of the CLI.
 *
 * Photoshop-compatibility additions the CLI lacks: fill opacity, "transparency
 * shapes layer" off for any layer, and colour / pattern overlay effects.
 *
 * The document is processed in BLOCK×BLOCK tiles; each tile walks the tree and
 * only touches layers whose stored blocks overlap it.
 */

import { BLOCK, scalePattern, type EngineDoc, type EngineNode, type Level, type MaskBlocks, type Pattern } from './doc';
import { getBlend, nonSep8, premulNonSep, STRAIGHT, type BlendImpl, type RGB } from './blend';

const N = BLOCK * BLOCK;
const INV255 = 1 / 255;

/** round(v / 255) for non-negative integers, the way Photoshop does it. */
const div255 = (v: number): number => {
  const t = v + 128;
  return (t + (t >> 8)) >> 8;
};

/**
 * Working buffer for one tile.
 * float mode: c = premultiplied colour, a = alpha, both 0..1
 * ps8 mode:   c = straight colour, a = alpha, both integers 0..255
 */
interface Buf {
  c: Float32Array;
  a: Float32Array;
  drawn: boolean;
}

class BufPool {
  private free: Buf[] = [];
  get(): Buf {
    const b = this.free.pop();
    if (b) {
      b.c.fill(0);
      b.a.fill(0);
      b.drawn = false;
      return b;
    }
    return { c: new Float32Array(N * 3), a: new Float32Array(N), drawn: false };
  }
  put(b: Buf): void {
    this.free.push(b);
  }
}

interface PreparedEffect {
  kind: 'pattern' | 'color';
  blend: BlendImpl;
  opacity: number;
  color?: [number, number, number];
  pattern?: Pattern;
  scale: number;
  ox: number;
  oy: number;
}

interface RNode {
  id: string;
  isGroup: boolean;
  pass: boolean;
  children: RNode[];
  clips: RNode[];
  /** applied to the source alpha before blending (opacity × fill, or fill alone in special mode) */
  opacity: number;
  /** applied as a lerp after blending (layer opacity in special mode, else 1) */
  post: number;
  /** plain layer opacity, used for effects */
  layerOpacity: number;
  blend: BlendImpl;
  blocks: (Uint8Array | null)[] | null;
  mask: MaskBlocks | null;
  effects: PreparedEffect[];
  /** inclusive block range at this level; bx0 > bx1 => empty */
  bx0: number;
  by0: number;
  bx1: number;
  by1: number;
}

/**
 * How the app that wrote the PSD composites layers. Photoshop is the default;
 * other painting apps differ in a few modes, fitted against their merged images.
 */
export interface BlendProfile {
  id: ProfileId;
  /** integer arithmetic for 8-bit documents */
  mode: 'ps8' | 'float';
  /** float back-end: buffer precision between layers */
  stepQuant?: StepQuant;
  /** ps8 back-end: truncate instead of round */
  trunc8?: boolean;
  /** "Add" / linear dodge is a plain sum: Cd + Cs·α·opacity (Procreate) */
  additiveDodge?: boolean;
}
export type ProfileId = 'photoshop' | 'procreate' | 'painter' | 'gpu-trunc' | 'gpu-u8';
export const PROFILES: Record<ProfileId, BlendProfile> = {
  /** Photoshop: 8-bit integer maths with its rounding (fitted exactly) */
  photoshop: { id: 'photoshop', mode: 'ps8' },
  /** Procreate: GPU float maths, "Add" is a plain sum */
  procreate: { id: 'procreate', mode: 'float', additiveDodge: true },
  /** SAI / ibisPaint / MediBang and other painting apps: float maths */
  painter: { id: 'painter', mode: 'float' },
  /** mobile GPU that truncates when mixing (measured on several ibisPaint devices) */
  'gpu-trunc': { id: 'gpu-trunc', mode: 'ps8', trunc8: true },
  /** mobile GPU with an 8-bit straight-colour buffer between layers */
  'gpu-u8': { id: 'gpu-u8', mode: 'float', stepQuant: 'u8s' },
};

/** profile of the render in progress (render() is synchronous) */
let profile: BlendProfile = PROFILES.photoshop;

export interface RenderOptions {
  /** float back-end only: precision of the buffer between layers (default none) */
  stepQuant?: StepQuant;
  /** ps8 back-end: truncate (GPU-style) instead of Photoshop's rounding */
  trunc8?: boolean;
  /** compositing rules of the app that wrote the file (default Photoshop) */
  profile?: ProfileId;
  /** arithmetic back-end, see file header. Default: 'ps8' for 8-bit documents. */
  mode?: 'ps8' | 'float';
  /** float mode only: 'round' (default) or 'trunc' (exactly like the Python CLI) */
  quantize?: 'round' | 'trunc';
  /** pattern sampling for scaled patterns */
  patternSampling?: 'nearest' | 'bilinear';
  /** called once per block row (progress / cooperative yielding) */
  onRow?: (row: number, rows: number) => void;
  /** test only: group tile ranges from the document bbox (the pre-1.3.3 rule) */
  legacyGroupBounds?: boolean;
}

/* Render tree */

/** Port of `get_layer_and_clip_groupings`: input/output bottom -> top. */
function groupClips(list: EngineNode[]): { base: EngineNode; clips: EngineNode[] }[] {
  const out: { base: EngineNode; clips: EngineNode[] }[] = [];
  let stack: EngineNode[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const layer = list[i];
    if (layer.clipping) {
      stack.push(layer);
      continue;
    }
    stack.reverse();
    if (layer.kind === 'group' && layer.blendMode === 'pass through') {
      // clipping onto a pass-through group behaves as if clipping were off
      for (const s of stack) out.push({ base: s, clips: [] });
      out.push({ base: layer, clips: [] });
    } else {
      out.push({ base: layer, clips: stack });
    }
    stack = [];
  }
  for (const s of stack) out.push({ base: s, clips: [] });
  out.reverse();
  return out;
}

function blockRange(level: Level, bbox: [number, number, number, number] | null) {
  if (!bbox) return { bx0: 1, by0: 1, bx1: 0, by1: 0 };
  const k = level.k;
  return {
    bx0: Math.floor(Math.floor(bbox[0] / k) / BLOCK),
    by0: Math.floor(Math.floor(bbox[1] / k) / BLOCK),
    bx1: Math.floor(Math.floor((bbox[2] - 1) / k) / BLOCK),
    by1: Math.floor(Math.floor((bbox[3] - 1) / k) / BLOCK),
  };
}

function buildTree(doc: EngineDoc, level: Level, list: EngineNode[], visible: (id: string) => boolean): RNode[] {
  const out: RNode[] = [];
  for (const { base, clips } of groupClips(list)) {
    if (!visible(base.id)) continue; // a hidden base also hides its clipping layers
    const node = prepare(doc, level, base, visible);
    if (!node) continue;
    node.clips = buildTree(doc, level, clips, visible);
    out.push(node);
  }
  return out;
}

const scaledCache = new WeakMap<Pattern, Map<number, Pattern>>();
function cachedScaled(p: Pattern, s: number): Pattern {
  let m = scaledCache.get(p);
  if (!m) scaledCache.set(p, (m = new Map()));
  let r = m.get(s);
  if (!r) m.set(s, (r = scalePattern(p, s)));
  return r;
}

function prepare(doc: EngineDoc, level: Level, n: EngineNode, visible: (id: string) => boolean): RNode | null {
  const isGroup = n.kind === 'group';
  const pass = isGroup && n.blendMode === 'pass through';
  const additive = !isGroup && !!profile.additiveDodge && n.blendMode === 'linear dodge';
  // additive dodge = SAI-style dodge with opacity applied before the sum
  const blend = getBlend(n.blendMode, !isGroup && (n.special || additive));
  const children = isGroup ? buildTree(doc, level, n.children, visible) : [];
  const blocks = isGroup ? null : level.layers.get(n.id)?.blocks ?? null;
  if (!isGroup && !blocks) return null;
  const effects: PreparedEffect[] = [];
  if (!isGroup) {
    for (const e of n.effects) {
      const pattern = e.kind === 'pattern' ? doc.patterns.get(e.patternId!) : undefined;
      if (e.kind === 'pattern' && !pattern) continue;
      effects.push({
        kind: e.kind,
        blend: getBlend(e.blendMode, false),
        opacity: e.opacity,
        color: e.color,
        // tile pre-scaled once, then sampled 1:1 in document pixels
        pattern: pattern ? cachedScaled(pattern, e.scale ?? 1) : undefined,
        scale: 1,
        ox: (e.originX ?? 0) + (e.phaseX ?? 0),
        oy: (e.originY ?? 0) + (e.phaseY ?? 0),
      });
    }
  }
  const special = !isGroup && n.special && !additive;
  return {
    id: n.id,
    isGroup,
    pass,
    children,
    clips: [],
    opacity: isGroup ? n.opacity : special ? n.fill : n.opacity * n.fill,
    post: special ? n.opacity : 1,
    layerOpacity: n.opacity,
    blend,
    blocks,
    mask: level.masks.get(n.id) ?? null,
    effects,
    // a group only does something where one of its drawn children does: the
    // document bbox also counts hidden descendants (every variant of a tail
    // group), which made each group touch far more tiles than it draws on
    // layers: where they actually have pixels (stored bounds can span the whole
    // canvas for mostly transparent layers)
    ...(legacyGroupBounds ? blockRange(level, n.bbox) : isGroup ? childRange(children) : dataRange(level, n.bbox, blocks!)),
  };
}

let legacyGroupBounds = false;

const dataRanges = new WeakMap<(Uint8Array | null)[], { bx0: number; by0: number; bx1: number; by1: number }>();
/** Block range of a layer's non-empty blocks, within its stored bounds. */
function dataRange(level: Level, bbox: [number, number, number, number] | null, blocks: (Uint8Array | null)[]) {
  let r = dataRanges.get(blocks);
  if (r) return r;
  const b = blockRange(level, bbox);
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (let by = Math.max(0, b.by0); by <= Math.min(level.bh - 1, b.by1); by++) {
    for (let bx = Math.max(0, b.bx0); bx <= Math.min(level.bw - 1, b.bx1); bx++) {
      if (!blocks[by * level.bw + bx]) continue;
      if (bx < bx0) bx0 = bx;
      if (bx > bx1) bx1 = bx;
      if (by < by0) by0 = by;
      if (by > by1) by1 = by;
    }
  }
  r = bx0 > bx1 ? { bx0: 1, by0: 1, bx1: 0, by1: 0 } : { bx0, by0, bx1, by1 };
  dataRanges.set(blocks, r);
  return r;
}

function childRange(children: RNode[]) {
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (const c of children) {
    if (c.bx0 > c.bx1 || c.by0 > c.by1) continue;
    bx0 = Math.min(bx0, c.bx0);
    by0 = Math.min(by0, c.by0);
    bx1 = Math.max(bx1, c.bx1);
    by1 = Math.max(by1, c.by1);
  }
  return bx0 > bx1 ? { bx0: 1, by0: 1, bx1: 0, by1: 0 } : { bx0, by0, bx1, by1 };
}

/* Float back-end (premultiplied) */

const tmpRGB: RGB = [0, 0, 0];

/** opacity -> premultiply -> blend -> clip -> mask lerp -> alpha union (`main_blend`). */
/**
 * Optional write-back precision for the float back-end, emulating a GPU
 * framebuffer between layers: 'u8p' premultiplied RGBA8, 'u8s' straight RGBA8,
 * 'f16' half floats. Set per render (render() is synchronous).
 */
export type StepQuant = 'none' | 'u8p' | 'u8s' | 'f16';
let stepQuant: StepQuant = 'none';
/** ps8 back-end: truncate instead of rounding when mixing onto an opaque backdrop */
let trunc8 = false;

const half = (v: number): number => {
  if (v === 0) return 0;
  const a = Math.abs(v);
  const e = Math.max(-14, Math.floor(Math.log2(a)));
  const step = 2 ** (e - 10);
  return Math.sign(v) * Math.round(a / step) * step;
};

function quantizePixel(c: Float32Array, a: Float32Array, i: number): void {
  const j = i * 3;
  if (stepQuant === 'u8p') {
    c[j] = Math.round(c[j] * 255) / 255;
    c[j + 1] = Math.round(c[j + 1] * 255) / 255;
    c[j + 2] = Math.round(c[j + 2] * 255) / 255;
    a[i] = Math.round(a[i] * 255) / 255;
  } else if (stepQuant === 'u8s') {
    const A = Math.round(a[i] * 255) / 255;
    for (let k = 0; k < 3; k++) {
      const st = a[i] > 0 ? Math.round(Math.min(1, c[j + k] / a[i]) * 255) / 255 : 0;
      c[j + k] = st * A;
    }
    a[i] = A;
  } else if (stepQuant === 'f16') {
    c[j] = half(c[j]);
    c[j + 1] = half(c[j + 1]);
    c[j + 2] = half(c[j + 2]);
    a[i] = half(a[i]);
  }
}

function blendFloat(
  dst: Buf,
  sc: Float32Array,
  sa: Float32Array,
  opacity: number,
  blend: BlendImpl,
  maskBlk: Uint8Array | null,
  maskDef: number,
  post: number,
): void {
  const dc = dst.c;
  const da = dst.a;
  const isNormal = blend.kind === 'normal';
  const uniformMask = maskBlk ? -1 : maskDef * INV255 * post;
  if (uniformMask === 0) return;
  for (let i = 0; i < N; i++) {
    const As = sa[i] * opacity;
    if (As === 0) continue;
    const m = uniformMask >= 0 ? uniformMask : maskBlk![i] * INV255 * post;
    if (m === 0) continue;
    const Ad = da[i];
    const j = i * 3;
    const s0 = sc[j] * As;
    const s1 = sc[j + 1] * As;
    const s2 = sc[j + 2] * As;
    const d0 = dc[j];
    const d1 = dc[j + 1];
    const d2 = dc[j + 2];
    let r0: number;
    let r1: number;
    let r2: number;
    if (blend.kind === 'normal') {
      const k = 1 - As;
      r0 = s0 + d0 * k;
      r1 = s1 + d1 * k;
      r2 = s2 + d2 * k;
    } else if (blend.kind === 'sep') {
      const f = blend.fn;
      r0 = f(d0, s0, Ad, As);
      r1 = f(d1, s1, Ad, As);
      r2 = f(d2, s2, Ad, As);
    } else {
      premulNonSep(blend.fn, d0, d1, d2, s0, s1, s2, Ad, As, tmpRGB);
      r0 = tmpRGB[0];
      r1 = tmpRGB[1];
      r2 = tmpRGB[2];
    }
    if (!isNormal) {
      r0 = r0 < 0 ? 0 : r0 > 1 ? 1 : r0;
      r1 = r1 < 0 ? 0 : r1 > 1 ? 1 : r1;
      r2 = r2 < 0 ? 0 : r2 > 1 ? 1 : r2;
    }
    if (m === 1) {
      dc[j] = r0;
      dc[j + 1] = r1;
      dc[j + 2] = r2;
      da[i] = Ad + As - Ad * As;
    } else {
      dc[j] = (r0 - d0) * m + d0;
      dc[j + 1] = (r1 - d1) * m + d1;
      dc[j + 2] = (r2 - d2) * m + d2;
      const am = As * m;
      da[i] = Ad + am - Ad * am;
    }
    if (stepQuant !== 'none') quantizePixel(dc, da, i);
  }
}

/* 8-bit Photoshop back-end (straight colour) */

const nonsepB = [0, 0, 0];

/** B(Cd, Cs) for separable modes on 0..255 integers. */
function blendChannel8(mode: string, f: ((d: number, s: number) => number) | undefined, d: number, s: number): number {
  switch (mode) {
    case 'multiply':
      return div255(d * s);
    case 'screen':
      return d + s - div255(d * s);
    case 'darken':
      return d < s ? d : s;
    case 'lighten':
      return d > s ? d : s;
    case 'difference':
      return d > s ? d - s : s - d;
    case 'linear dodge':
      return d + s > 255 ? 255 : d + s;
    case 'linear burn':
      return d + s < 255 ? 0 : d + s - 255;
    case 'subtract':
      return d > s ? d - s : 0;
    default: {
      const v = f!(d * INV255, s * INV255) * 255;
      return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
    }
  }
}

/** Straight 0..255 colour + 0..255 alpha. Photoshop's rounding at every step. */
function blend8(
  dst: Buf,
  sc: Float32Array,
  sa: Float32Array,
  opacity: number,
  blend: BlendImpl,
  maskBlk: Uint8Array | null,
  maskDef: number,
  post: number,
): void {
  const dc = dst.c;
  const da = dst.a;
  const O = Math.round(opacity * 255);
  const P = Math.round(post * 255);
  if (O === 0 || P === 0) return;
  if (!maskBlk && maskDef === 0) return;
  const special = blend.kind === 'sep' && blend.special;
  const mode = blend.kind === 'normal' ? 'normal' : blend.mode;
  const straight = blend.kind === 'sep' ? STRAIGHT[mode] : undefined;

  for (let i = 0; i < N; i++) {
    const a = sa[i];
    if (a === 0) continue;
    let As = O === 255 ? a : div255(a * O);
    // post-blend factor (mask × special-mode opacity)
    let m = maskBlk ? maskBlk[i] : maskDef;
    if (P !== 255) m = div255(m * P);
    if (m === 0) continue;
    if (!special && m !== 255) {
      As = div255(As * m);
      m = 255;
    }
    if (As === 0) continue;
    const Ad = da[i];
    const j = i * 3;

    if (special) {
      // SAI-style formulas are defined on premultiplied floats
      const ad = Ad * INV255;
      const as = As * INV255;
      const ar = ad + as - ad * as;
      const mf = m * INV255;
      const arm = ad + (ar - ad) * mf;
      for (let c = 0; c < 3; c++) {
        const cd = dc[j + c] * INV255 * ad;
        let r = (blend as any).fn(cd, sc[j + c] * INV255 * as, ad, as);
        r = r < 0 ? 0 : r > 1 ? 1 : r;
        r = cd + (r - cd) * mf;
        dc[j + c] = arm > 0 ? Math.min(255, (trunc8 ? Math.floor : Math.round)((r / arm) * 255)) : 0;
      }
      da[i] = Math.round(arm * 255);
      continue;
    }

    // non-separable modes (hue/saturation/color/luminosity/darker/lighter color)
    // need the whole RGB triple, so compute B for all three channels up front
    if (blend.kind === 'nonsep' && Ad !== 0) {
      nonSep8(mode, [dc[j], dc[j + 1], dc[j + 2]], [sc[j], sc[j + 1], sc[j + 2]], nonsepB);
    }
    const blendOf = (c: number): number =>
      mode === 'normal' ? sc[j + c] : blend.kind === 'nonsep' ? nonsepB[c] : blendChannel8(mode, straight, dc[j + c], sc[j + c]);

    if (Ad === 0) {
      dc[j] = sc[j];
      dc[j + 1] = sc[j + 1];
      dc[j + 2] = sc[j + 2];
      da[i] = As;
      continue;
    }
    if (Ad === 255) {
      const ia = 255 - As;
      if (trunc8) for (let c = 0; c < 3; c++) dc[j + c] = Math.floor((blendOf(c) * As + dc[j + c] * ia) / 255);
      else for (let c = 0; c < 3; c++) dc[j + c] = div255(blendOf(c) * As + dc[j + c] * ia);
      continue;
    }

    // general case: partially transparent backdrop
    const Ar = As + Ad - div255(As * Ad);
    for (let c = 0; c < 3; c++) {
      const d = dc[j + c];
      const s = sc[j + c];
      const X = mode === 'normal' ? s : div255((255 - Ad) * s + Ad * blendOf(c));
      dc[j + c] = Math.round((d * (Ar - As) + X * As) / Ar);
    }
    da[i] = Ar;
  }
}

/* Compositor */

class Compositor {
  private pool = new BufPool();
  private bx = 0;
  private by = 0;
  private bi = 0;
  readonly ps8: boolean;
  private readonly one: number;

  constructor(
    private level: Level,
    private opts: RenderOptions,
  ) {
    this.ps8 = opts.mode !== 'float';
    this.one = this.ps8 ? 255 : 1;
  }

  tile(roots: RNode[], bx: number, by: number): Buf {
    this.bx = bx;
    this.by = by;
    this.bi = by * this.level.bw + bx;
    return this.list(roots, null);
  }

  release(b: Buf): void {
    this.pool.put(b);
  }

  private hits(n: RNode): boolean {
    return this.bx >= n.bx0 && this.bx <= n.bx1 && this.by >= n.by0 && this.by <= n.by1;
  }

  private blend(dst: Buf, sc: Float32Array, sa: Float32Array, opacity: number, blend: BlendImpl, maskBlk: Uint8Array | null, maskDef: number, post: number): void {
    if (this.ps8) blend8(dst, sc, sa, opacity, blend, maskBlk, maskDef, post);
    else blendFloat(dst, sc, sa, opacity, blend, maskBlk, maskDef, post);
  }

  private list(nodes: RNode[], backdrop: Buf | null): Buf {
    const dst = this.pool.get();
    if (backdrop) {
      dst.c.set(backdrop.c);
      dst.a.set(backdrop.a);
      dst.drawn = true;
    }
    for (const n of nodes) {
      if (!this.hits(n)) continue;
      const maskBlk = n.mask ? n.mask.blocks[this.bi] : null;
      const maskDef = n.mask ? n.mask.def : 255;

      if (n.isGroup && n.pass) {
        const res = this.list(n.children, dst);
        this.passLerp(dst, res, n.opacity, maskBlk, maskDef);
        this.pool.put(res);
        continue;
      }

      let src: Buf;
      if (n.isGroup) {
        src = this.list(n.children, null);
        if (!src.drawn) {
          this.pool.put(src);
          continue;
        }
        if (!this.ps8) {
          // un-premultiply the group result (clip_divide)
          const c = src.c;
          const a = src.a;
          for (let i = 0; i < N; i++) {
            const A = a[i];
            const j = i * 3;
            if (A === 0) {
              c[j] = c[j + 1] = c[j + 2] = 1;
            } else {
              c[j] = Math.min(1, c[j] / A);
              c[j + 1] = Math.min(1, c[j + 1] / A);
              c[j + 2] = Math.min(1, c[j + 2] / A);
            }
          }
        }
      } else {
        const blk = n.blocks![this.bi];
        if (!blk) continue;
        src = this.pool.get();
        const c = src.c;
        const a = src.a;
        const s = this.ps8 ? 1 : INV255;
        for (let i = 0, p = 0; i < N; i++, p += 4) {
          const j = i * 3;
          c[j] = blk[p] * s;
          c[j + 1] = blk[p + 1] * s;
          c[j + 2] = blk[p + 2] * s;
          a[i] = blk[p + 3] * s;
        }
      }

      if (n.clips.length) {
        // clipping layers paint onto the base colour as if it were opaque
        const thr = this.pool.get();
        thr.c.set(src.c);
        for (let i = 0; i < N; i++) thr.a[i] = src.a[i] === 0 ? 0 : this.one;
        const res = this.list(n.clips, thr);
        src.c.set(res.c);
        this.pool.put(res);
        this.pool.put(thr);
      }

      this.blend(dst, src.c, src.a, n.opacity, n.blend, maskBlk, maskDef, n.post);
      dst.drawn = true;

      if (n.effects.length) this.effects(dst, n, maskBlk, maskDef);
      this.pool.put(src);
    }
    return dst;
  }

  private passLerp(dst: Buf, res: Buf, opacity: number, maskBlk: Uint8Array | null, maskDef: number): void {
    dst.drawn = true;
    const uniform = maskBlk ? -1 : maskDef * INV255 * opacity;
    if (uniform === 1) {
      dst.c.set(res.c);
      dst.a.set(res.a);
      return;
    }
    const dc = dst.c;
    const da = dst.a;
    for (let i = 0; i < N; i++) {
      const t = uniform >= 0 ? uniform : maskBlk![i] * INV255 * opacity;
      if (t === 0) continue;
      const j = i * 3;
      if (this.ps8) {
        // lerp premultiplied, back to straight, rounded
        const T = Math.round(t * 255);
        const ad = da[i];
        const ar = res.a[i];
        const A = div255(ar * T + ad * (255 - T));
        for (let c = 0; c < 3; c++) {
          const v = res.c[j + c] * ar * T + dc[j + c] * ad * (255 - T);
          dc[j + c] = A > 0 ? Math.min(255, Math.round(v / (A * 255))) : 0;
        }
        da[i] = A;
      } else {
        dc[j] += (res.c[j] - dc[j]) * t;
        dc[j + 1] += (res.c[j + 1] - dc[j + 1]) * t;
        dc[j + 2] += (res.c[j + 2] - dc[j + 2]) * t;
        da[i] += (res.a[i] - da[i]) * t;
        if (stepQuant !== 'none') quantizePixel(dc, da, i);
      }
    }
  }

  /** Interior overlay effects, drawn as extra layers clipped to the layer's own alpha. */
  private effects(dst: Buf, n: RNode, maskBlk: Uint8Array | null, maskDef: number): void {
    const blk = n.blocks![this.bi];
    if (!blk) return;
    const k = this.level.k;
    const ec = this.pool.get();
    const ea = ec.a;
    const sampling = this.opts.patternSampling ?? (k === 1 ? 'nearest' : 'bilinear');
    const one = this.one;
    for (const e of n.effects) {
      const op = e.opacity * n.layerOpacity;
      if (op <= 0) continue;
      for (let ly = 0; ly < BLOCK; ly++) {
        // document-space centre of this (possibly down-scaled) pixel
        const yd = (this.by * BLOCK + ly + 0.5) * k - 0.5;
        for (let lx = 0; lx < BLOCK; lx++) {
          const i = ly * BLOCK + lx;
          const shape = blk[i * 4 + 3];
          const j = i * 3;
          if (shape === 0) {
            ea[i] = 0;
            continue;
          }
          if (e.kind === 'color') {
            ec.c[j] = e.color![0] * one;
            ec.c[j + 1] = e.color![1] * one;
            ec.c[j + 2] = e.color![2] * one;
            ea[i] = shape * INV255 * one;
          } else {
            const xd = (this.bx * BLOCK + lx + 0.5) * k - 0.5;
            samplePattern(e.pattern!, (xd - e.ox) / e.scale, (yd - e.oy) / e.scale, sampling, ec.c, j, ea, i);
            ea[i] *= shape * INV255;
            if (this.ps8) {
              ec.c[j] = Math.round(ec.c[j] * 255);
              ec.c[j + 1] = Math.round(ec.c[j + 1] * 255);
              ec.c[j + 2] = Math.round(ec.c[j + 2] * 255);
              ea[i] = Math.round(ea[i] * 255);
            }
          }
          if (this.ps8) ea[i] = Math.round(ea[i]);
        }
      }
      this.blend(dst, ec.c, ea, op, e.blend, maskBlk, maskDef, 1);
    }
    this.pool.put(ec);
  }
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Writes straight colour (0..1) and alpha (0..1). */
function samplePattern(
  p: Pattern,
  u: number,
  v: number,
  mode: 'nearest' | 'bilinear',
  outC: Float32Array,
  j: number,
  outA: Float32Array,
  i: number,
): void {
  const d = p.data;
  if (mode === 'nearest') {
    const q = (mod(Math.round(v), p.height) * p.width + mod(Math.round(u), p.width)) * 4;
    outC[j] = d[q] * INV255;
    outC[j + 1] = d[q + 1] * INV255;
    outC[j + 2] = d[q + 2] * INV255;
    outA[i] = d[q + 3] * INV255;
    return;
  }
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  const xa = mod(x0, p.width);
  const xb = mod(x0 + 1, p.width);
  const ya = mod(y0, p.height);
  const yb = mod(y0 + 1, p.height);
  const q00 = (ya * p.width + xa) * 4;
  const q10 = (ya * p.width + xb) * 4;
  const q01 = (yb * p.width + xa) * 4;
  const q11 = (yb * p.width + xb) * 4;
  // premultiplied interpolation
  const a00 = d[q00 + 3] * (1 - fx) * (1 - fy);
  const a10 = d[q10 + 3] * fx * (1 - fy);
  const a01 = d[q01 + 3] * (1 - fx) * fy;
  const a11 = d[q11 + 3] * fx * fy;
  const A = a00 + a10 + a01 + a11;
  if (A === 0) {
    outC[j] = outC[j + 1] = outC[j + 2] = 0;
    outA[i] = 0;
    return;
  }
  for (let c = 0; c < 3; c++) {
    outC[j + c] = ((d[q00 + c] * a00 + d[q10 + c] * a10 + d[q01 + c] * a01 + d[q11 + c] * a11) / A) * INV255;
  }
  outA[i] = A * INV255;
}

/* Public API */

export interface RenderResult {
  width: number;
  height: number;
  /** straight (non-premultiplied) RGBA */
  data: Uint8ClampedArray;
  opaque: boolean;
}

/**
 * Render the document at `levelIndex` with the given own-visibility predicate.
 * A node is drawn when it and all of its ancestors are visible.
 */
export function render(
  doc: EngineDoc,
  levelIndex: number,
  visible: (id: string) => boolean,
  opts: RenderOptions = {},
): RenderResult {
  const level = doc.levels[levelIndex] ?? doc.levels[0];
  const { roots, comp } = setup(doc, level, visible, opts);
  const out = new Uint8ClampedArray(level.width * level.height * 4);
  const trunc = opts.quantize === 'trunc';
  let opaque = true;
  for (let by = 0; by < level.bh; by++) {
    for (let bx = 0; bx < level.bw; bx++) {
      const res = comp.tile(roots, bx, by);
      const x0 = bx * BLOCK;
      const y0 = by * BLOCK;
      if (!writeBlock(comp, res, out, level.width, x0, y0, Math.min(BLOCK, level.width - x0), Math.min(BLOCK, level.height - y0), trunc)) opaque = false;
      comp.release(res);
    }
    opts.onRow?.(by, level.bh);
  }
  return { width: level.width, height: level.height, data: out, opaque };
}

/**
 * Finished tiles of the previous full-size render, for reuse.
 *
 * A tile's pixels depend only on which drawn nodes touch it (the compositor
 * skips everything else) and on fixed settings. Consecutive combinations
 * usually differ in one group (one tail, one expression), so most tiles are
 * touched by exactly the same nodes as in the previous picture and are copied
 * instead of composited again. The result is bit-identical.
 */
export interface TileCache {
  id: string;
  keys: string[];
  data: Uint8ClampedArray;
  opaque: Uint8Array;
}

/**
 * The nodes that contribute to tile `bi`, in drawing order. Mirrors what the
 * compositor does there: a layer without a stored block in this tile is
 * skipped entirely (clipping layers and effects included), and a group whose
 * contents draw nothing here leaves the tile unchanged. Per-tile blocks matter:
 * many layers carry an "anchor" pixel in a corner, so their bounds span the
 * whole canvas although they only draw in a few tiles.
 */
function tileKey(nodes: RNode[], bi: number, bx: number, by: number, out: string[]): boolean {
  let any = false;
  for (const n of nodes) {
    if (bx < n.bx0 || bx > n.bx1 || by < n.by0 || by > n.by1) continue;
    if (n.isGroup) {
      const mark = out.length;
      out.push(n.id, '(');
      if (!tileKey(n.children, bi, bx, by, out)) {
        out.length = mark;
        continue;
      }
      out.push(')');
    } else {
      if (!n.blocks || !n.blocks[bi]) continue;
      out.push(n.id);
    }
    if (n.clips.length) {
      out.push('[');
      tileKey(n.clips, bi, bx, by, out);
      out.push(']');
    }
    any = true;
  }
  return any;
}

/** Full render that reuses unchanged tiles of `cache` and returns the new cache. */
export function renderCached(
  doc: EngineDoc,
  levelIndex: number,
  visible: (id: string) => boolean,
  opts: RenderOptions,
  cache: TileCache | null,
  cacheId: string,
): { result: RenderResult; cache: TileCache; reused: number } {
  const level = doc.levels[levelIndex] ?? doc.levels[0];
  const { roots, comp } = setup(doc, level, visible, opts);
  const W = level.width;
  const out = new Uint8ClampedArray(W * level.height * 4);
  const trunc = opts.quantize === 'trunc';
  const keys: string[] = new Array(level.bw * level.bh);
  const opaqueBlocks = new Uint8Array(level.bw * level.bh);
  const usable = cache && cache.id === cacheId && cache.data.length === out.length ? cache : null;
  // the cache keeps its buffer: only tiles that changed are copied into it
  // (instead of copying the whole picture after every render)
  const keep = usable ? usable.data : null;
  let opaque = true;
  let reused = 0;
  const parts: string[] = [];
  for (let by = 0; by < level.bh; by++) {
    for (let bx = 0; bx < level.bw; bx++) {
      const bi = by * level.bw + bx;
      parts.length = 0;
      tileKey(roots, bi, bx, by, parts);
      const key = parts.join(',');
      keys[bi] = key;
      const x0 = bx * BLOCK;
      const y0 = by * BLOCK;
      const w = Math.min(BLOCK, W - x0);
      const h = Math.min(BLOCK, level.height - y0);
      let op: boolean;
      if (usable && usable.keys[bi] === key) {
        for (let y = 0; y < h; y++) {
          const o = ((y0 + y) * W + x0) * 4;
          out.set(usable.data.subarray(o, o + w * 4), o);
        }
        op = usable.opaque[bi] === 1;
        reused++;
      } else {
        const res = comp.tile(roots, bx, by);
        op = writeBlock(comp, res, out, W, x0, y0, w, h, trunc);
        comp.release(res);
        if (keep)
          for (let y = 0; y < h; y++) {
            const o = ((y0 + y) * W + x0) * 4;
            keep.set(out.subarray(o, o + w * 4), o);
          }
      }
      opaqueBlocks[bi] = op ? 1 : 0;
      if (!op) opaque = false;
    }
    opts.onRow?.(by, level.bh);
  }
  return {
    result: { width: W, height: level.height, data: out, opaque },
    cache: { id: cacheId, keys, data: keep ?? out.slice(), opaque: opaqueBlocks },
    reused,
  };
}

/**
 * Same result as `render`, but pauses every few milliseconds so the worker
 * can take new messages; resolves null as soon as `stop()` says a newer
 * request made this one pointless (rapid clicking never queues up renders).
 */
export async function renderInterruptible(
  doc: EngineDoc,
  levelIndex: number,
  visible: (id: string) => boolean,
  opts: RenderOptions,
  stop: () => boolean,
): Promise<RenderResult | null> {
  const level = doc.levels[levelIndex] ?? doc.levels[0];
  const { roots, comp } = setup(doc, level, visible, opts);
  const out = new Uint8ClampedArray(level.width * level.height * 4);
  const trunc = opts.quantize === 'trunc';
  let opaque = true;
  let slice = performance.now();
  for (let by = 0; by < level.bh; by++) {
    for (let bx = 0; bx < level.bw; bx++) {
      const res = comp.tile(roots, bx, by);
      const x0 = bx * BLOCK;
      const y0 = by * BLOCK;
      if (!writeBlock(comp, res, out, level.width, x0, y0, Math.min(BLOCK, level.width - x0), Math.min(BLOCK, level.height - y0), trunc)) opaque = false;
      comp.release(res);
    }
    if (performance.now() - slice > 8) {
      await new Promise((r) => setTimeout(r, 0));
      if (stop()) return null;
      // another render may have run meanwhile: restore this one's settings
      setup(doc, level, () => false, opts);
      slice = performance.now();
    }
  }
  return { width: level.width, height: level.height, data: out, opaque };
}

function setup(doc: EngineDoc, level: Level, visible: (id: string) => boolean, opts: RenderOptions) {
  profile = PROFILES[opts.profile ?? 'photoshop'] ?? PROFILES.photoshop;
  stepQuant = opts.stepQuant ?? profile.stepQuant ?? 'none';
  trunc8 = opts.trunc8 ?? profile.trunc8 ?? false;
  // arithmetic: explicit option > profile > document default
  const mode = opts.mode ?? (doc.bitsPerChannel === 8 ? profile.mode : 'float');
  legacyGroupBounds = !!opts.legacyGroupBounds;
  const roots = buildTree(doc, level, doc.roots, visible);
  return { roots, comp: new Compositor(level, { ...opts, mode }) };
}

/** Convert one tile result into straight 8-bit RGBA inside `out`. Returns whether it is fully opaque. */
function writeBlock(comp: Compositor, res: Buf, out: Uint8ClampedArray, stride: number, x0: number, y0: number, w: number, h: number, trunc: boolean): boolean {
  let opaque = true;
  const q = trunc ? Math.floor : (v: number) => Math.floor(v + 0.5);
  for (let ly = 0; ly < h; ly++) {
    let o = ((y0 + ly) * stride + x0) * 4;
    for (let lx = 0; lx < w; lx++, o += 4) {
      const i = ly * BLOCK + lx;
      const j = i * 3;
      const A = res.a[i];
      if (A <= 0) {
        opaque = false;
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
        continue;
      }
      if (comp.ps8) {
        out[o] = res.c[j];
        out[o + 1] = res.c[j + 1];
        out[o + 2] = res.c[j + 2];
        out[o + 3] = A;
        if (A !== 255) opaque = false;
        continue;
      }
      // numpy astype(uint8) truncates; Uint8ClampedArray alone would round half to even
      const inv = 1 / A;
      out[o] = q(Math.min(1, res.c[j] * inv) * 255);
      out[o + 1] = q(Math.min(1, res.c[j + 1] * inv) * 255);
      out[o + 2] = q(Math.min(1, res.c[j + 2] * inv) * 255);
      out[o + 3] = q(Math.min(1, A) * 255);
      if (out[o + 3] !== 255) opaque = false;
    }
  }
  return opaque;
}

/**
 * Render only some full-resolution blocks (for calibration). Returns one
 * BLOCK×BLOCK RGBA tile per requested block index, in order.
 */
export function renderBlocks(doc: EngineDoc, blockIdx: number[], visible: (id: string) => boolean, opts: RenderOptions = {}): Uint8ClampedArray[] {
  const level = doc.levels[0];
  const { roots, comp } = setup(doc, level, visible, opts);
  return blockIdx.map((bi) => {
    const bx = bi % level.bw;
    const by = (bi - bx) / level.bw;
    const res = comp.tile(roots, bx, by);
    const tile = new Uint8ClampedArray(BLOCK * BLOCK * 4);
    writeBlock(comp, res, tile, BLOCK, 0, 0, Math.min(BLOCK, level.width - bx * BLOCK), Math.min(BLOCK, level.height - by * BLOCK), opts.quantize === 'trunc');
    comp.release(res);
    return tile;
  });
}

export function defaultMode(doc: EngineDoc): 'ps8' | 'float' {
  return doc.bitsPerChannel === 8 ? 'ps8' : 'float';
}

export { PROFILES as BLEND_PROFILES };

/** Own-visibility exactly as saved in the PSD (no rules applied). */
export function authoredVisibility(doc: EngineDoc): (id: string) => boolean {
  return (id) => !doc.nodes.get(id)?.hidden;
}
