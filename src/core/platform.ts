/**
 * Platform abstraction: one UI, three shells, one delivery format (a single
 * ZIP archive containing every exported image).
 *
 *  - electron : stream the ZIP to a file chosen with the native "Save as" dialog
 *  - android  : stream the ZIP into a Uri chosen with the system picker
 *  - web      : stream the ZIP into memory and hand it to the download manager
 *
 * The ZIP is streamed (see core/zip.ts) so peak memory stays at ~1 image no
 * matter how many variants are exported.
 */

import { ZipWriter } from './zip';
import type { ExportMode } from './model';

export type Platform = 'electron' | 'android' | 'web';

export function detectPlatform(): Platform {
  const w = window as any;
  if (w.psdExportNative?.isElectron) return 'electron';
  if (w.Capacitor?.isNativePlatform?.()) return 'android';
  return 'web';
}

export function bytesToBase64(data: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    s += String.fromCharCode.apply(null, Array.from(data.subarray(i, i + chunk)));
  }
  return btoa(s);
}

export interface ExportSummary {
  /** human readable location of the archive */
  location: string;
  entries: number;
  archiveBytes: number;
  /** set when the archive lives on disk */
  archivePath?: string;
}

/**
 * Owns the archive lifecycle for one export run.
 */
export interface ExportTarget {
  platform: Platform;
  /** Called once before the first image. May prompt for a destination. */
  begin(meta: { suggestedName: string; total: number }): Promise<void>;
  /** Append one already-encoded image to the archive. */
  add(path: string, data: Uint8Array): Promise<void>;
  /** Close the archive and deliver it. */
  finish(): Promise<ExportSummary>;
  /** Abort: release handles, delete partial output where possible. */
  cancel(): Promise<void>;
}

function sanitizeName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'psd-export'
  );
}

function dayStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/* Electron (Windows EXE) */

class ElectronTarget implements ExportTarget {
  platform: Platform = 'electron';
  private zip: ZipWriter | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private writeError: Error | null = null;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private filePath = '';

  constructor(private bridge: any) {}

  async begin(meta: { suggestedName: string }) {
    const name = `${sanitizeName(meta.suggestedName)}-${dayStamp()}.zip`;
    const res = await this.bridge.chooseZip(name);
    if (!res?.ok) throw new Error(res?.error ?? '已取消导出');
    const opened = await this.bridge.beginArchive(res.path);
    if (!opened?.ok) throw new Error(opened?.error ?? '无法创建压缩包');
    this.filePath = opened.path;
    this.zip = new ZipWriter((chunk) => {
      // batch small chunks into fewer IPC round trips
      this.pending.push(chunk.slice());
      this.pendingBytes += chunk.length;
      if (this.pendingBytes >= 8 * 1024 * 1024) this.flush();
    });
  }

  private flush(): void {
    if (!this.pending.length) return;
    const parts = this.pending;
    const total = this.pendingBytes;
    this.pending = [];
    this.pendingBytes = 0;
    const buf = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      buf.set(p, o);
      o += p.length;
    }
    this.writes = this.writes.then(async () => {
      if (this.writeError) return;
      const r = await this.bridge.appendArchive(buf);
      if (!r?.ok) this.writeError = new Error(r?.error ?? '写入压缩包失败');
    });
  }

  async add(path: string, data: Uint8Array) {
    if (!this.zip) throw new Error('压缩包未打开');
    await this.zip.addEntry(path, data);
    this.flush();
    await this.writes;
    if (this.writeError) throw this.writeError;
  }

  async finish(): Promise<ExportSummary> {
    const zip = this.zip;
    if (!zip) throw new Error('压缩包未打开');
    await zip.finish();
    this.flush();
    await this.writes;
    if (this.writeError) throw this.writeError;
    const closed = await this.bridge.finishArchive();
    if (!closed?.ok) throw new Error(closed?.error ?? '关闭压缩包失败');
    await this.bridge.revealFile(closed.path);
    return { location: closed.path ?? this.filePath, archivePath: closed.path, entries: zip.entries.length, archiveBytes: closed.bytes ?? zip.totalBytes };
  }

  async cancel() {
    try {
      await this.writes;
      await this.bridge.abortArchive();
    } catch {
      /* best effort */
    }
  }
}

class ElectronFolderTarget implements ExportTarget {
  platform: Platform = 'electron';
  private root = '';
  private entries = 0;
  private bytes = 0;

  constructor(private bridge: any) {}

  async begin(meta: { suggestedName: string }) {
    const res = await this.bridge.chooseFolder(sanitizeName(meta.suggestedName));
    if (!res?.ok) throw new Error(res?.error ?? '已取消导出');
    const opened = await this.bridge.beginFolder(res.path);
    if (!opened?.ok) throw new Error(opened?.error ?? '无法打开导出文件夹');
    this.root = opened.path;
  }

  async add(path: string, data: Uint8Array) {
    const written = await this.bridge.writeFolderFile(path, data);
    if (!written?.ok) throw new Error(written?.error ?? '写入图片失败');
    this.entries++;
    this.bytes += data.byteLength;
  }

  async finish(): Promise<ExportSummary> {
    const closed = await this.bridge.finishFolder();
    if (!closed?.ok) throw new Error(closed?.error ?? '关闭导出文件夹失败');
    await this.bridge.revealFolder(closed.path ?? this.root);
    return { location: closed.path ?? this.root, archivePath: closed.path ?? this.root, entries: this.entries, archiveBytes: closed.bytes ?? this.bytes };
  }

  async cancel() {
    try {
      await this.bridge.abortFolder();
    } catch {
      /* best effort */
    }
  }
}

/* Android (Capacitor) */

/**
 * The user picks the destination with the system "Save to..." document picker
 * (local SaveFile plugin -> ACTION_CREATE_DOCUMENT) and the archive is streamed
 * straight into that Uri. Nothing is staged in app-private storage, so a 300 MB
 * archive still costs only a few MB of JS memory.
 */
class AndroidTarget implements ExportTarget {
  platform: Platform = 'android';
  private zip: ZipWriter | null = null;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private uri = '';
  private fileName = '';
  private saveFile: any;

  constructor() {
    const plugins = (window as any).Capacitor?.Plugins ?? {};
    this.saveFile = plugins.SaveFile;
  }

  async begin(meta: { suggestedName: string }) {
    if (!this.saveFile) throw new Error('保存插件不可用（请重新安装 APK）');
    this.fileName = `${sanitizeName(meta.suggestedName)}-${dayStamp()}.zip`;

    const res = await this.saveFile.chooseFile({
      fileName: this.fileName,
      mimeType: 'application/zip',
    });
    this.uri = res?.uri ?? '';
    if (!this.uri) throw new Error('未选择保存位置');

    this.zip = new ZipWriter((chunk) => this.push(chunk));
  }

  private push(chunk: Uint8Array): void {
    // keep raw bytes (copied: the writer may reuse its buffer) and encode once
    // per transfer. Encoding pieces separately and joining the strings put
    // "=" padding in the middle, which Android rejects as "bad base-64".
    this.pending.push(chunk.slice());
    this.pendingBytes += chunk.length;
  }

  private async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const all = new Uint8Array(this.pendingBytes);
    let o = 0;
    for (const c of this.pending) {
      all.set(c, o);
      o += c.length;
    }
    this.pending = [];
    this.pendingBytes = 0;
    await this.saveFile.appendChunk({ data: bytesToBase64(all) });
  }

  async add(path: string, data: Uint8Array) {
    if (!this.zip) throw new Error('未初始化输出');
    await this.zip.addEntry(path, data);
    if (this.pendingBytes > 4 * 1024 * 1024) await this.flush();
  }

  async finish(): Promise<ExportSummary> {
    const zip = this.zip;
    if (!zip) throw new Error('未初始化输出');
    await zip.finish();
    await this.flush();
    const closed = await this.saveFile.closeFile();
    return {
      location: describeUri(closed?.uri ?? this.uri),
      archivePath: this.fileName,
      entries: zip.entries.length,
      archiveBytes: zip.totalBytes,
    };
  }

  async cancel() {
    try {
      await this.saveFile?.abortFile();
    } catch {
      /* ignore */
    }
  }
}

class AndroidFolderTarget implements ExportTarget {
  platform: Platform = 'android';
  private uri = '';
  private currentPath = '';
  private currentBytes = 0;
  private entries = 0;
  private bytes = 0;
  private saveFile: any;

  constructor() {
    this.saveFile = (window as any).Capacitor?.Plugins?.SaveFile;
  }

  async begin(meta: { suggestedName: string }) {
    if (!this.saveFile?.chooseDirectory) throw new Error('保存插件不可用（请重新安装 APK）');
    const res = await this.saveFile.chooseDirectory({ suggestedName: sanitizeName(meta.suggestedName) });
    this.uri = res?.uri ?? '';
    if (!this.uri) throw new Error('未选择保存文件夹');
  }

  async add(path: string, data: Uint8Array) {
    await this.saveFile.beginOutputFile({ path });
    this.currentPath = path;
    this.currentBytes = 0;
    try {
      const chunk = 0x80000;
      for (let i = 0; i < data.length; i += chunk) {
        const part = data.subarray(i, i + chunk);
        await this.saveFile.appendOutputChunk({ data: bytesToBase64(part) });
        this.currentBytes += part.length;
      }
      await this.saveFile.finishOutputFile();
    } catch (err) {
      try {
        await this.saveFile.abortOutputFile();
      } catch {
        /* best effort */
      }
      throw err;
    }
    this.entries++;
    this.bytes += this.currentBytes;
    this.currentPath = '';
    this.currentBytes = 0;
  }

  async finish(): Promise<ExportSummary> {
    const closed = await this.saveFile.closeDirectory();
    return {
      location: describeUri(closed?.uri ?? this.uri),
      entries: this.entries,
      archiveBytes: this.bytes,
    };
  }

  async cancel() {
    try {
      if (this.currentPath) await this.saveFile?.abortOutputFile();
      await this.saveFile?.abortDirectory();
    } catch {
      /* best effort */
    }
  }
}

function describeUri(uri: string): string {
  try {
    const decoded = decodeURIComponent(uri);
    const parts = decoded.split('/').filter(Boolean);
    return parts.slice(-2).join('/') || uri;
  } catch {
    return uri;
  }
}

/* Plain browser */

class WebTarget implements ExportTarget {
  platform: Platform = 'web';
  private chunks: Uint8Array[] = [];
  private zip: ZipWriter | null = null;

  async begin() {
    this.zip = new ZipWriter((chunk) => {
      this.chunks.push(chunk);
    });
  }

  async add(path: string, data: Uint8Array) {
    if (!this.zip) throw new Error('未初始化输出');
    await this.zip.addEntry(path, data);
  }

  async finish(): Promise<ExportSummary> {
    const zip = this.zip;
    if (!zip) throw new Error('未初始化输出');
    await zip.finish();
    const blob = new Blob(this.chunks as BlobPart[], { type: 'application/zip' });
    const name = `psd-export-${dayStamp()}.zip`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return { location: `浏览器下载：${name}`, entries: zip.entries.length, archiveBytes: blob.size };
  }

  async cancel() {
    this.chunks = [];
  }
}

class WebFolderTarget implements ExportTarget {
  platform: Platform = 'web';
  private root: any;
  private entries = 0;
  private bytes = 0;

  async begin() {
    const picker = (window as any).showDirectoryPicker;
    if (!picker) throw new Error('当前浏览器不支持直接选择文件夹，请改用 ZIP 压缩导出');
    this.root = await picker.call(window, { mode: 'readwrite' });
  }

  async add(path: string, data: Uint8Array) {
    if (!this.root) throw new Error('导出文件夹未打开');
    const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) throw new Error('导出文件名为空');
    let dir = this.root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
    const file = await dir.getFileHandle(fileName, { create: true });
    const writable = await file.createWritable();
    await writable.write(data);
    await writable.close();
    this.entries++;
    this.bytes += data.byteLength;
  }

  async finish(): Promise<ExportSummary> {
    return { location: `浏览器文件夹：${this.root?.name ?? ''}`, entries: this.entries, archiveBytes: this.bytes };
  }

  async cancel() {
    this.root = null;
  }
}

export async function createTarget(mode: ExportMode = 'zip'): Promise<ExportTarget> {
  const platform = detectPlatform();
  if (platform === 'electron') return mode === 'folder' ? new ElectronFolderTarget((window as any).psdExportNative) : new ElectronTarget((window as any).psdExportNative);
  if (platform === 'android') return mode === 'folder' ? new AndroidFolderTarget() : new AndroidTarget();
  return mode === 'folder' ? new WebFolderTarget() : new WebTarget();
}

/* Small text files (configuration) */

/** Save a text file where the user chooses. Returns a description of the location, or null if cancelled. */
export async function saveTextFile(name: string, text: string): Promise<string | null> {
  const platform = detectPlatform();
  if (platform === 'electron') {
    const res = await (window as any).psdExportNative.saveText(name, text);
    if (!res?.ok) {
      if (res?.error && res.error !== '已取消') throw new Error(res.error);
      return null;
    }
    return res.path as string;
  }
  if (platform === 'android') {
    const plugin = (window as any).Capacitor?.Plugins?.SaveFile;
    if (!plugin) throw new Error('保存插件不可用');
    let res;
    try {
      res = await plugin.chooseFile({ fileName: name, mimeType: 'application/json' });
    } catch {
      return null; // cancelled
    }
    await plugin.appendChunk({ data: bytesToBase64(new TextEncoder().encode(text)) });
    const closed = await plugin.closeFile();
    return describeUri(closed?.uri ?? res?.uri ?? name);
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return `浏览器下载：${name}`;
}

/** Let the user pick a text file. Resolves null if cancelled. */
export async function openTextFile(accept = '.json'): Promise<{ name: string; text: string } | null> {
  if (detectPlatform() === 'electron') {
    const res = await (window as any).psdExportNative.openText();
    return res?.ok ? { name: res.name, text: res.text } : null;
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    // Android's picker greys out unknown types when filtered
    input.accept = detectPlatform() === 'android' ? '*/*' : accept;
    input.onchange = async () => {
      const f = input.files?.[0];
      resolve(f ? { name: f.name, text: await f.text() } : null);
    };
    input.click();
  });
}
