/**
 * Exact PNG decoder (8/16-bit greyscale, RGB, palette, grey+alpha, RGBA;
 * non-interlaced). Browser image decoding goes through premultiplied alpha
 * and would change semi-transparent pixels, so layer images embedded in
 * .ipv files are decoded here. Inflate comes from `DecompressionStream`.
 */

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface DecodedPng {
  width: number;
  height: number;
  /** straight RGBA, 8 bits per channel */
  data: Uint8ClampedArray;
}

export async function decodePng(png: Uint8Array): Promise<DecodedPng> {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (dv.getUint32(0) !== 0x89504e47) throw new Error('不是 PNG 数据');
  let p = 8;
  let width = 0;
  let height = 0;
  let depth = 8;
  let ctype = 6;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (p + 8 <= png.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    const body = png.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(p + 8);
      height = dv.getUint32(p + 12);
      depth = body[8];
      ctype = body[9];
      interlace = body[12];
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (interlace) throw new Error('不支持隔行扫描的 PNG');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype as 0 | 2 | 3 | 4 | 6];
  if (!channels) throw new Error(`不支持的 PNG 颜色类型 ${ctype}`);
  let total = 0;
  for (const c of idat) total += c.length;
  const joined = new Uint8Array(total);
  let o = 0;
  for (const c of idat) {
    joined.set(c, o);
    o += c.length;
  }
  const raw = await inflate(joined);

  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  const out = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const f = raw[base];
    for (let i = 0; i < stride; i++) {
      const x = raw[base + 1 + i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v: number;
      switch (f) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        default: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a);
          const pb = Math.abs(pp - b);
          const pc = Math.abs(pp - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
      }
      cur[i] = v & 255;
    }
    // expand to RGBA
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 4;
      const sample = (k: number): number => {
        if (depth === 8) return cur[x * channels + k];
        if (depth === 16) return cur[(x * channels + k) * 2]; // high byte
        // 1/2/4-bit (greyscale or palette)
        const bit = (x * channels + k) * depth;
        const v = (cur[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        return ctype === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
      };
      if (ctype === 6) {
        out[d] = sample(0);
        out[d + 1] = sample(1);
        out[d + 2] = sample(2);
        out[d + 3] = sample(3);
      } else if (ctype === 2) {
        out[d] = sample(0);
        out[d + 1] = sample(1);
        out[d + 2] = sample(2);
        out[d + 3] = 255;
      } else if (ctype === 0) {
        out[d] = out[d + 1] = out[d + 2] = sample(0);
        out[d + 3] = 255;
      } else if (ctype === 4) {
        out[d] = out[d + 1] = out[d + 2] = sample(0);
        out[d + 3] = sample(1);
      } else {
        const idx = sample(0);
        out[d] = palette ? palette[idx * 3] : 0;
        out[d + 1] = palette ? palette[idx * 3 + 1] : 0;
        out[d + 2] = palette ? palette[idx * 3 + 2] : 0;
        out[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
    prev.set(cur);
  }
  return { width, height, data: out };
}
