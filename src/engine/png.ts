/**
 * Lossless PNG encoder working on raw RGBA bytes.
 *
 * Canvas `toBlob` goes through premultiplied alpha and silently changes the
 * colour of semi-transparent pixels, so exported PNGs would not be byte-exact.
 * This encoder writes exactly the pixels the compositor produced.
 * Deflate comes from the platform `CompressionStream` (browser, worker, Node 18+).
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(v: number): Uint8Array {
  return new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
}

function chunk(type: string, data: Uint8Array): Uint8Array[] {
  const t = new TextEncoder().encode(type);
  return [u32(data.length), t, data, u32(crc32([t, data]))];
}

export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Per-row filtering. The filter of each row is chosen like libpng's heuristic
 * (minimum sum of absolute differences), but estimated on a sample of the row
 * instead of computing all five candidates in full: about 5x faster with
 * practically the same file size. Filters are lossless; the pixels are exact.
 */
export function filterRows(px: Uint8ClampedArray | Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array((stride + 1) * height);
  let row = new Uint8Array(stride);
  let prev = new Uint8Array(stride); // zeros for the first row
  // sample every `step`-th pixel (all its channels)
  const step = width > 64 ? 5 : 1;
  const abs = (v: number) => {
    v &= 255;
    return v < 128 ? v : 256 - v;
  };
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = p > a ? p - a : a - p;
    const pb = p > b ? p - b : b - p;
    const pc = p > c ? p - c : c - p;
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  for (let y = 0; y < height; y++) {
    if (bpp === 4) row.set(px.subarray(y * width * 4, (y + 1) * width * 4));
    else
      for (let x = 0, s = y * width * 4, d = 0; x < width; x++, s += 4, d += 3) {
        row[d] = px[s];
        row[d + 1] = px[s + 1];
        row[d + 2] = px[s + 2];
      }
    // estimate the cost of the 5 filters on sampled pixels
    let k0 = 0;
    let k1 = 0;
    let k2 = 0;
    let k3 = 0;
    let k4 = 0;
    for (let x = 1; x < width; x += step) {
      for (let ch = 0, i = x * bpp; ch < bpp; ch++, i++) {
        const r = row[i];
        const a = row[i - bpp];
        const b = prev[i];
        const c = prev[i - bpp];
        k0 += abs(r);
        k1 += abs(r - a);
        k2 += abs(r - b);
        k3 += abs(r - ((a + b) >> 1));
        k4 += abs(r - paeth(a, b, c));
      }
    }
    let best = 0;
    let bc = k0;
    if (k1 < bc) (bc = k1), (best = 1);
    if (k2 < bc) (bc = k2), (best = 2);
    if (k3 < bc) (bc = k3), (best = 3);
    if (k4 < bc) (bc = k4), (best = 4);

    const o = y * (stride + 1);
    out[o] = best;
    const d = out.subarray(o + 1, o + 1 + stride);
    switch (best) {
      case 0:
        d.set(row);
        break;
      case 1:
        for (let i = 0; i < bpp; i++) d[i] = row[i];
        for (let i = bpp; i < stride; i++) d[i] = row[i] - row[i - bpp];
        break;
      case 2:
        for (let i = 0; i < stride; i++) d[i] = row[i] - prev[i];
        break;
      case 3:
        for (let i = 0; i < bpp; i++) d[i] = row[i] - (prev[i] >> 1);
        for (let i = bpp; i < stride; i++) d[i] = row[i] - ((row[i - bpp] + prev[i]) >> 1);
        break;
      default:
        for (let i = 0; i < bpp; i++) d[i] = row[i] - prev[i]; // paeth with a = c = 0 picks b
        for (let i = bpp; i < stride; i++) d[i] = row[i] - paeth(row[i - bpp], prev[i], prev[i - bpp]);
    }
    const t = prev;
    prev = row;
    row = t;
  }
  return out;
}

export async function encodePng(
  px: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  opts: { opaque?: boolean; stats?: { filter: number; deflate: number } } = {},
): Promise<Uint8Array> {
  let opaque = opts.opaque;
  if (opaque === undefined) {
    opaque = true;
    for (let i = 3; i < px.length; i += 4) {
      if (px[i] !== 255) {
        opaque = false;
        break;
      }
    }
  }
  const bpp = opaque ? 3 : 4;
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width), 0);
  ihdr.set(u32(height), 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = opaque ? 2 : 6; // RGB / RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const t0 = performance.now();
  const filtered = filterRows(px, width, height, bpp);
  const t1 = performance.now();
  const idat = await deflate(filtered);
  if (opts.stats) {
    opts.stats.filter += t1 - t0;
    opts.stats.deflate += performance.now() - t1;
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', idat),
    ...chunk('IEND', new Uint8Array(0)),
  ];
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
