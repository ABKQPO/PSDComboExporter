/**
 * Blend functions — a 1:1 port of `psd_export/blendfuncs.pyx` (float build).
 *
 * All colours are *premultiplied* floats in [0, 1]. Each separable function
 * receives one channel: (Cd, Cs, Ad, As) = (dst colour, src colour, dst alpha,
 * src alpha) and returns the new premultiplied dst colour for that channel.
 * Non-separable modes (hue/saturation/colour/luminosity/darker/lighter colour)
 * work on the whole RGB triple.
 *
 * Keep this file free of DOM / worker APIs: it runs in a Web Worker in the app
 * and in Node for the pixel-exact regression tests.
 */

export type SepFn = (Cd: number, Cs: number, Ad: number, As: number) => number;
export type RGB = [number, number, number];
export type NonSepStraight = (Cd: RGB, Cs: RGB) => RGB;

const clip = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const safeDivide = (a: number, b: number): number => (b === 0 ? 1 : a / b);
const clipDivide = (a: number, b: number): number => clip(safeDivide(a, b));
const comp = (C: number, A: number): number => C * (1 - A);
const comp2 = (Cd: number, Cs: number, Ad: number, As: number): number => comp(Cd, As) + comp(Cs, Ad);
const lerp = (a: number, b: number, t: number): number => (b - a) * t + a;

function premul(Cd: number, Cs: number, Ad: number, As: number, straight: (d: number, s: number) => number): number {
  const Cdp = clipDivide(Cd, Ad);
  const Csp = clipDivide(Cs, As);
  const B = straight(Cdp, Csp);
  const Asrc = comp(As, Ad);
  const Adst = comp(Ad, As);
  const Aboth = As * Ad;
  return Csp * Asrc + Cdp * Adst + Aboth * B;
}

/* ---------------- straight (non-premultiplied) helpers ---------------- */

const screenStraight = (Cd: number, Cs: number) => Cs + Cd - Cs * Cd;
const linearBurnStraight = (Cd: number, Cs: number) => clip(Cd + Cs - 1);
const linearDodgeStraight = (Cd: number, Cs: number) => clip(Cd + Cs);
const linearLightStraight = (Cd: number, Cs: number) => {
  const Cs2 = Cs * 2;
  return Cs > 0.5 ? linearDodgeStraight(Cd, Cs2 - 1) : linearBurnStraight(Cd, Cs2);
};
const colorBurnStraight = (Cd: number, Cs: number) => 1 - clipDivide(1 - Cd, Cs);
const colorDodgeStraight = (Cd: number, Cs: number) => clipDivide(Cd, 1 - Cs);
const vividLightStraight = (Cd: number, Cs: number) => {
  const Cs2 = Cs * 2;
  return Cs > 0.5 ? colorDodgeStraight(Cd, Cs2 - 1) : colorBurnStraight(Cd, Cs2);
};
const softLightStraight = (Cd: number, Cs: number) => {
  const D = Cs <= 0.25 ? ((16 * Cd - 12) * Cd + 4) * Cd : Math.sqrt(Cd);
  return Cs <= 0.5 ? Cd - (1 - 2 * Cs) * Cd * (1 - Cd) : Cd + (2 * Cs - 1) * (D - Cd);
};
const hardLightStraight = (Cd: number, Cs: number) => {
  const Cs2 = Cs * 2;
  return Cs > 0.5 ? screenStraight(Cd, Cs2 - 1) : Cd * Cs2;
};
const pinLightStraight = (Cd: number, Cs: number) => {
  const Cs2 = Cs * 2;
  return Cs > 0.5 ? Math.max(Cs2 - 1, Cd) : Math.min(Cs2, Cd);
};
const hardMixStraight = (Cd: number, Cs: number) => (Cd + Cs > 1 ? 1 : 0);

/* ---------------- separable modes ---------------- */

export const normal: SepFn = (Cd, Cs, _Ad, As) => Cs + comp(Cd, As);
export const multiply: SepFn = (Cd, Cs, Ad, As) => Cs * Cd + comp2(Cd, Cs, Ad, As);
export const screen: SepFn = (Cd, Cs) => screenStraight(Cd, Cs);
export const hardLight: SepFn = (Cd, Cs, Ad, As) => premul(Cd, Cs, Ad, As, hardLightStraight);
export const overlay: SepFn = (Cd, Cs, Ad, As) => hardLight(Cs, Cd, As, Ad);
export const linearBurn: SepFn = (Cd, Cs, Ad, As) => premul(Cd, Cs, Ad, As, linearBurnStraight);
export const linearDodge: SepFn = (Cd, Cs, Ad, As) => premul(Cd, Cs, Ad, As, linearDodgeStraight);
export const linearLight: SepFn = (Cd, Cs, Ad, As) => premul(Cd, Cs, Ad, As, linearLightStraight);
export const colorBurn: SepFn = (Cd, Cs, Ad, As) => premul(Cd, Cs, Ad, As, colorBurnStraight);
export const colorDodge: SepFn = (Cd, Cs, Ad, As) => premul(Cd, Cs, Ad, As, colorDodgeStraight);
export const vividLight: SepFn = (Cd, Cs, Ad, As) => premul(Cd, Cs, Ad, As, vividLightStraight);
export const softLight: SepFn = (Cd, Cs, Ad, As) => premul(Cd, Cs, Ad, As, softLightStraight);
export const pinLight: SepFn = (Cd, Cs, Ad, As) => premul(Cd, Cs, Ad, As, pinLightStraight);
export const hardMix: SepFn = (Cd, Cs, Ad, As) => premul(Cd, Cs, Ad, As, hardMixStraight);
export const darken: SepFn = (Cd, Cs, Ad, As) => Math.min(Cs * Ad, Cd * As) + comp2(Cd, Cs, Ad, As);
export const lighten: SepFn = (Cd, Cs, Ad, As) => Math.max(Cs * Ad, Cd * As) + comp2(Cd, Cs, Ad, As);
export const difference: SepFn = (Cd, Cs, Ad, As) => Cs + Cd - 2 * Math.min(Cd * As, Cs * Ad);
export const exclusion: SepFn = (Cd, Cs, Ad, As) => Cs * Ad + Cd * As - 2 * Cs * Cd + comp2(Cd, Cs, Ad, As);
export const subtract: SepFn = (Cd, Cs, Ad, As) => Math.max(0, Cd * As - Cs * Ad) + comp2(Cd, Cs, Ad, As);
export const divide: SepFn = (Cd, Cs, Ad, As) => premul(Cd, Cs, Ad, As, clipDivide);

/* ---------------- PaintTool SAI "special" modes ----------------
 * SAI writes these 8 modes with `tsly = 0` and the real opacity in `iOpa`
 * (fill). They are not the Photoshop formulas, so they get their own path. */

export const saiLinearBurn: SepFn = (Cd, Cs, Ad, As) => lerp(Cs, clip(clipDivide(Cd, Ad) + Cs - As), Ad);
export const saiLinearDodge: SepFn = (Cd, Cs, Ad) => lerp(Cs, clip(clipDivide(Cd, Ad) + Cs), Ad);
export const saiLinearLight: SepFn = (Cd, Cs, Ad, As) => lerp(Cs, clip(clipDivide(Cd, Ad) + Cs * 2 - As), Ad);
export const saiColorBurn: SepFn = (Cd, Cs, Ad, As) => {
  const Cdd = clipDivide(Cd, Ad);
  return lerp(Cs, 1 - clipDivide(1 - Cdd, 1 - As + Cs), Ad);
};
export const saiColorDodge: SepFn = (Cd, Cs, Ad) => lerp(Cs, clipDivide(clipDivide(Cd, Ad), 1 - Cs), Ad);
export const saiVividLight: SepFn = (Cd, Cs, Ad, As) => {
  const Cdd = clipDivide(Cd, Ad);
  const Csd = clipDivide(Cs, As);
  const Cs2 = As - Cs * 2;
  let CB = 1 - clipDivide(1 - Cdd, 1 - Cs2);
  const CD = clipDivide(Cdd, 1 + Cs2);
  if (Csd > 0.5) CB = CD;
  if (Cs === 1) CB = 1;
  return lerp(Cs, CB, Ad);
};
export const saiHardMix: SepFn = (Cd, Cs, Ad, As) => {
  const Cdd = clipDivide(Cd, Ad);
  const Csd = clipDivide(Cs, As);
  return lerp(Cs, clipDivide(Cdd - As + As * Csd, 1 - As), Ad);
};
export const saiDifference: SepFn = (Cd, Cs, Ad) => lerp(Cs, Math.abs(clipDivide(Cd, Ad) - Cs), Ad);

/* ---------------- non-separable modes ---------------- */

const lum = (C: RGB) => 0.3 * C[0] + 0.59 * C[1] + 0.11 * C[2];

function clipColor(C: RGB): RGB {
  const L = lum(C);
  const n = Math.min(C[0], C[1], C[2]);
  const x = Math.max(C[0], C[1], C[2]);
  const r = C[0] - L;
  const g = C[1] - L;
  const b = C[2] - L;
  if (n < 0) {
    const Ln = L - n;
    C[0] = L + safeDivide(r * L, Ln);
    C[1] = L + safeDivide(g * L, Ln);
    C[2] = L + safeDivide(b * L, Ln);
  }
  if (x > 1) {
    // NOTE: the Python original reuses the deltas computed before the n<0 branch.
    const L1 = 1 - L;
    const xL = x - L;
    C[0] = L + safeDivide(r * L1, xL);
    C[1] = L + safeDivide(g * L1, xL);
    C[2] = L + safeDivide(b * L1, xL);
  }
  return C;
}

function setLum(C: RGB, L: number): RGB {
  const d = L - lum(C);
  return clipColor([C[0] + d, C[1] + d, C[2] + d]);
}

const sat = (C: RGB) => Math.max(C[0], C[1], C[2]) - Math.min(C[0], C[1], C[2]);

function setSat(Cin: RGB, S: number): RGB {
  const C: RGB = [Cin[0], Cin[1], Cin[2]];
  const amax = Math.max(C[0], C[1], C[2]);
  const amin = Math.min(C[0], C[1], C[2]);
  let imax: number;
  let imid: number;
  let imin: number;
  if (amax === C[0]) {
    imax = 0;
    if (amin === C[1]) {
      imin = 1;
      imid = 2;
    } else {
      imin = 2;
      imid = 1;
    }
  } else if (amax === C[1]) {
    imax = 1;
    if (amin === C[0]) {
      imin = 0;
      imid = 2;
    } else {
      imin = 2;
      imid = 0;
    }
  } else {
    imax = 2;
    if (amin === C[0]) {
      imin = 0;
      imid = 1;
    } else {
      imin = 1;
      imid = 0;
    }
  }
  const amid = C[imid];
  if (amax > amin) {
    C[imid] = safeDivide((amid - amin) * S, amax - amin);
    C[imax] = S;
  } else {
    C[imid] = 0;
    C[imax] = 0;
  }
  C[imin] = 0;
  return C;
}

const EPS = 2.220446049250313e-16;

export const hueStraight: NonSepStraight = (Cd, Cs) => {
  const s: RGB = [Cs[0], Cs[1], Cs[2]];
  if (s[0] === s[1] && s[0] === s[2]) s[0] += EPS;
  return setLum(setSat(s, sat(Cd)), lum(Cd));
};
export const saturationStraight: NonSepStraight = (Cd, Cs) => setLum(setSat(Cd, sat(Cs)), lum(Cd));
export const colorStraight: NonSepStraight = (Cd, Cs) => setLum(Cs, lum(Cd));
export const luminosityStraight: NonSepStraight = (Cd, Cs) => setLum(Cd, lum(Cs));
export const darkerColorStraight: NonSepStraight = (Cd, Cs) => (lum(Cs) < lum(Cd) ? Cs : Cd);
export const lighterColorStraight: NonSepStraight = (Cd, Cs) => (lum(Cs) > lum(Cd) ? Cs : Cd);

/** Premultiplied wrapper for a non-separable mode. Writes the result into `out`. */
export function premulNonSep(
  straight: NonSepStraight,
  dr: number,
  dg: number,
  db: number,
  sr: number,
  sg: number,
  sb: number,
  Ad: number,
  As: number,
  out: RGB,
): void {
  const Cdp: RGB = [clipDivide(dr, Ad), clipDivide(dg, Ad), clipDivide(db, Ad)];
  const Csp: RGB = [clipDivide(sr, As), clipDivide(sg, As), clipDivide(sb, As)];
  const B = straight([Cdp[0], Cdp[1], Cdp[2]], [Csp[0], Csp[1], Csp[2]]);
  const Asrc = comp(As, Ad);
  const Adst = comp(Ad, As);
  const Aboth = As * Ad;
  out[0] = Csp[0] * Asrc + Cdp[0] * Adst + Aboth * B[0];
  out[1] = Csp[1] * Asrc + Cdp[1] * Adst + Aboth * B[1];
  out[2] = Csp[2] * Asrc + Cdp[2] * Adst + Aboth * B[2];
}

/* ---------------- straight forms (8-bit Photoshop pipeline) ---------------- */

/** Straight (non-premultiplied) separable blend B(Cd, Cs) on [0, 1] values. */
export const STRAIGHT: Record<string, (Cd: number, Cs: number) => number> = {
  multiply: (d, s) => d * s,
  screen: screenStraight,
  overlay: (d, s) => hardLightStraight(s, d),
  'linear burn': linearBurnStraight,
  'linear dodge': linearDodgeStraight,
  'linear light': linearLightStraight,
  'color burn': colorBurnStraight,
  'color dodge': colorDodgeStraight,
  'vivid light': vividLightStraight,
  'hard light': hardLightStraight,
  'soft light': softLightStraight,
  'pin light': pinLightStraight,
  'hard mix': hardMixStraight,
  darken: (d, s) => Math.min(d, s),
  lighten: (d, s) => Math.max(d, s),
  difference: (d, s) => Math.abs(d - s),
  exclusion: (d, s) => d + s - 2 * d * s,
  subtract: (d, s) => Math.max(0, d - s),
  divide: (d, s) => clipDivide(d, s),
};

/* ---------------- non-separable modes, 8-bit Photoshop variant ----------------
 * Same structure as the float version, but luminance is the integer
 * round((30R + 59G + 11B) / 100) on 0..255 values. Fitted on a real PSD with a
 * Color-mode clipping layer: this cuts mismatches against Photoshop's merged
 * image from 19 % to 5 % of the affected pixels (the rest differ by 1–2/255
 * where a channel overflows; Photoshop's exact clipping is not documented). */

const lum8 = (C: RGB) => Math.round((30 * C[0] + 59 * C[1] + 11 * C[2]) / 100);

function clipColor8(C: RGB): RGB {
  const L = lum8(C);
  const n = Math.min(C[0], C[1], C[2]);
  const x = Math.max(C[0], C[1], C[2]);
  let out: RGB = [C[0], C[1], C[2]];
  if (n < 0 && L !== n) out = [L + ((C[0] - L) * L) / (L - n), L + ((C[1] - L) * L) / (L - n), L + ((C[2] - L) * L) / (L - n)];
  if (x > 255 && x !== L) {
    const s = out;
    out = [L + ((s[0] - L) * (255 - L)) / (x - L), L + ((s[1] - L) * (255 - L)) / (x - L), L + ((s[2] - L) * (255 - L)) / (x - L)];
  }
  return out;
}

function setLum8(C: RGB, L: number): RGB {
  const d = L - lum8(C);
  return clipColor8([C[0] + d, C[1] + d, C[2] + d]);
}

/** Non-separable B(Cd, Cs) on 0..255 values, rounded to integers. */
export function nonSep8(mode: string, Cd: RGB, Cs: RGB, out: number[]): void {
  let r: RGB;
  switch (mode) {
    case 'color':
      r = setLum8(Cs, lum8(Cd));
      break;
    case 'luminosity':
      r = setLum8(Cd, lum8(Cs));
      break;
    case 'hue': {
      const s: RGB = Cs[0] === Cs[1] && Cs[0] === Cs[2] ? [Cs[0] + EPS, Cs[1], Cs[2]] : Cs;
      r = setLum8(setSat(s, sat(Cd)), lum8(Cd));
      break;
    }
    case 'saturation':
      r = setLum8(setSat(Cd, sat(Cs)), lum8(Cd));
      break;
    case 'darker color':
      r = lum8(Cs) < lum8(Cd) ? Cs : Cd;
      break;
    case 'hsl hue':
    case 'hsl saturation':
    case 'hsl color':
    case 'hsl luminosity': {
      const f = NON_SEPARABLE[mode]!;
      const v = f([Cd[0] / 255, Cd[1] / 255, Cd[2] / 255], [Cs[0] / 255, Cs[1] / 255, Cs[2] / 255]);
      r = [v[0] * 255, v[1] * 255, v[2] * 255];
      break;
    }
    default:
      r = lum8(Cs) > lum8(Cd) ? Cs : Cd;
  }
  for (let c = 0; c < 3; c++) out[c] = r[c] <= 0 ? 0 : r[c] >= 255 ? 255 : Math.round(r[c]);
}

/* ---------------- lookup ---------------- */

export type BlendImpl =
  | { kind: 'normal' }
  | { kind: 'sep'; fn: SepFn; mode: string; special: boolean }
  | { kind: 'nonsep'; fn: NonSepStraight; mode: string };

const SEPARABLE: Record<string, SepFn | undefined> = {
  multiply,
  screen,
  overlay,
  'linear burn': linearBurn,
  'linear dodge': linearDodge,
  'linear light': linearLight,
  'color burn': colorBurn,
  'color dodge': colorDodge,
  'vivid light': vividLight,
  'hard light': hardLight,
  'soft light': softLight,
  'pin light': pinLight,
  'hard mix': hardMix,
  darken,
  lighten,
  difference,
  exclusion,
  subtract,
  divide,
};

/* ---------------- HSL variants (GPU painting apps) ----------------
 * Same idea as hue / saturation / color / luminosity, but in HSL space with
 * lightness = (max + min) / 2, as many GPU-based painting apps implement them. */

function rgbToHsl(C: RGB): [number, number, number] {
  const max = Math.max(C[0], C[1], C[2]);
  const min = Math.min(C[0], C[1], C[2]);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === C[0]) h = (C[1] - C[2]) / d + (C[1] < C[2] ? 6 : 0);
  else if (max === C[1]) h = (C[2] - C[0]) / d + 2;
  else h = (C[0] - C[1]) / d + 4;
  return [h / 6, sat, l];
}

function hslToRgb(h: number, sat: number, l: number): RGB {
  if (sat === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

const hslMix = (pick: (d: [number, number, number], s: [number, number, number]) => [number, number, number]): NonSepStraight => (Cd, Cs) => {
  const [h, sa, l] = pick(rgbToHsl(Cd), rgbToHsl(Cs));
  return hslToRgb(h, sa, l);
};
export const hslHue = hslMix((d, s) => [s[0], d[1], d[2]]);
export const hslSaturation = hslMix((d, s) => [d[0], s[1], d[2]]);
export const hslColor = hslMix((d, s) => [s[0], s[1], d[2]]);
export const hslLuminosity = hslMix((d, s) => [d[0], d[1], s[2]]);

const NON_SEPARABLE: Record<string, NonSepStraight | undefined> = {
  'hsl hue': hslHue,
  'hsl saturation': hslSaturation,
  'hsl color': hslColor,
  'hsl luminosity': hslLuminosity,
  hue: hueStraight,
  saturation: saturationStraight,
  color: colorStraight,
  luminosity: luminosityStraight,
  'darker color': darkerColorStraight,
  'lighter color': lighterColorStraight,
};

const SPECIAL: Record<string, SepFn | undefined> = {
  'linear burn': saiLinearBurn,
  'linear dodge': saiLinearDodge,
  'linear light': saiLinearLight,
  'color burn': saiColorBurn,
  'color dodge': saiColorDodge,
  'vivid light': saiVividLight,
  'hard mix': saiHardMix,
  difference: saiDifference,
};

/** ag-psd blend mode name -> implementation (falls back to normal like the CLI). */
export function getBlend(mode: string | undefined, special: boolean): BlendImpl {
  const key = (mode ?? 'normal').toLowerCase();
  if (special) {
    const fn = SPECIAL[key];
    return fn ? { kind: 'sep', fn, mode: key, special: true } : { kind: 'normal' };
  }
  const sep = SEPARABLE[key];
  if (sep) return { kind: 'sep', fn: sep, mode: key, special: false };
  const nonsep = NON_SEPARABLE[key];
  if (nonsep) return { kind: 'nonsep', fn: nonsep, mode: key };
  return { kind: 'normal' };
}

export function isKnownBlend(mode: string | undefined): boolean {
  const key = (mode ?? 'normal').toLowerCase();
  return key === 'normal' || key === 'pass through' || key in SEPARABLE || key in NON_SEPARABLE || key === 'dissolve';
}
