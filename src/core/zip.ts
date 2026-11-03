/**
 * Minimal streaming ZIP writer (STORE method).
 *
 * JSZip would hold every encoded image in RAM until the archive closes, which
 * exhausts the WebView heap on Android for a few hundred 4K variants. Here each
 * entry is emitted as soon as it is encoded and can be appended straight to a
 * file, so peak memory is one image.
 *
 * PNG/JPEG/WebP are already compressed: STORE costs almost nothing in size and
 * saves a full deflate pass per file.
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

export function crc32(data: Uint8Array, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface CentralRecord {
  nameBytes: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

class Writer {
  private buf: Uint8Array;
  private len = 0;
  constructor(size: number) {
    this.buf = new Uint8Array(size);
  }
  get view(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
  u16(v: number): void {
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
  }
  u32(v: number): void {
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 24) & 0xff;
  }
  bytes(b: Uint8Array): void {
    this.buf.set(b, this.len);
    this.len += b.length;
  }
}

export interface ZipEntryMeta {
  name: string;
  bytes: number;
}

export class ZipWriter {
  private records: CentralRecord[] = [];
  private offset = 0;
  private closed = false;
  readonly entries: ZipEntryMeta[] = [];

  constructor(private readonly sink: (chunk: Uint8Array) => Promise<void> | void) {}

  get totalBytes(): number {
    return this.offset;
  }

  async addEntry(path: string, data: Uint8Array, when = new Date()): Promise<void> {
    if (this.closed) throw new Error('ZIP 已关闭');
    if (this.records.length >= 0xffff) throw new Error('压缩包内文件数量超过 65535，请分批导出');
    if (data.length >= 0xffffffff) throw new Error(`单个文件过大：${path}`);

    const nameBytes = new TextEncoder().encode(path.replace(/\\/g, '/'));
    const { time, date } = dosDateTime(when);
    const crc = crc32(data);

    const header = new Writer(30 + nameBytes.length);
    header.u32(0x04034b50);
    header.u16(20); // version needed
    header.u16(0x0800); // UTF-8 filename
    header.u16(0); // STORE
    header.u16(time);
    header.u16(date);
    header.u32(crc);
    header.u32(data.length);
    header.u32(data.length);
    header.u16(nameBytes.length);
    header.u16(0); // extra len
    header.bytes(nameBytes);

    const offset = this.offset;
    await this.sink(header.view);
    await this.sink(data);
    this.offset += header.view.length + data.length;

    this.records.push({ nameBytes, crc, size: data.length, offset, time, date });
    this.entries.push({ name: path, bytes: data.length });
  }

  /** Emit the central directory and the end-of-central-directory record. */
  async finish(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const cdStart = this.offset;
    let cdSize = 0;

    for (const r of this.records) {
      const w = new Writer(46 + r.nameBytes.length);
      w.u32(0x02014b50);
      w.u16(20); // version made by
      w.u16(20); // version needed
      w.u16(0x0800);
      w.u16(0);
      w.u16(r.time);
      w.u16(r.date);
      w.u32(r.crc);
      w.u32(r.size);
      w.u32(r.size);
      w.u16(r.nameBytes.length);
      w.u16(0); // extra
      w.u16(0); // comment
      w.u16(0); // disk number
      w.u16(0); // internal attrs
      w.u32(0); // external attrs
      w.u32(r.offset);
      w.bytes(r.nameBytes);
      await this.sink(w.view);
      cdSize += w.view.length;
    }

    const eocd = new Writer(22);
    eocd.u32(0x06054b50);
    eocd.u16(0);
    eocd.u16(0);
    eocd.u16(this.records.length);
    eocd.u16(this.records.length);
    eocd.u32(cdSize);
    eocd.u32(cdStart);
    eocd.u16(0);
    await this.sink(eocd.view);

    this.offset = cdStart + cdSize + 22;
  }
}
