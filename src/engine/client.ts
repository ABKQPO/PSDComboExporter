/**
 * UI-side handle on the engine workers.
 *
 * Worker 0 serves interactive requests (preview, thumbnails). Exports are
 * spread across all workers; every worker holds its own copy of the decoded
 * document, so the pool is 1 on Android (memory) and up to 4 on desktop.
 */

import EngineWorker from './worker?worker';
import type {
  CompareResult,
  EncodeFormat,
  Encoded,
  EngineRequest,
  LoadedDoc,
  ProfileId,
  RawImage,
  RenderedImage,
} from './protocol';

/** Omit that distributes over a union, so each request variant keeps its own fields. */
type Req = EngineRequest extends infer T ? (T extends EngineRequest ? Omit<T, 'id'> : never) : never;

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  onProgress?: (done: number, total: number, label: string) => void;
};

class Lane {
  readonly worker: Worker;
  private pending = new Map<number, Pending>();
  busy = 0;

  constructor() {
    this.worker = new EngineWorker();
    this.worker.onmessage = (ev) => {
      const msg = ev.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'progress') {
        p.onProgress?.(msg.done, msg.total, msg.label);
        return;
      }
      this.pending.delete(msg.id);
      this.busy--;
      if (msg.type === 'error') p.reject(new Error(msg.message));
      else p.resolve(msg);
    };
    this.worker.onerror = (ev) => {
      const err = new Error(ev.message || '引擎线程崩溃（可能是内存不足）');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.busy = 0;
    };
  }

  call<T>(req: Req, transfer: Transferable[] = [], onProgress?: Pending['onProgress']): Promise<T> {
    const id = ++seq;
    this.busy++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ ...req, id }, transfer);
    });
  }

  terminate(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('已取消'));
    this.pending.clear();
  }
}

let seq = 0;

export interface LoadOptions {
  workers: number;
  /** encoder-only workers (hold no document): PNG compression runs there while the next picture renders */
  encoders?: number;
  keepComposite: boolean;
  previewEdge?: number;
  thumbEdge?: number;
  onProgress?: (done: number, total: number, label: string) => void;
}

export class Engine {
  private lanes: Lane[] = [];
  /** bumps on every load, so stale background loads stop */
  private loadGen = 0;
  /** profile chosen after load (applied to export workers that join later) */
  private profile: ProfileId | null = null;
  private encoders: Lane[] = [];
  doc: LoadedDoc | null = null;
  private previewSeq = 0;

  async load(buffer: ArrayBuffer, opts: LoadOptions): Promise<LoadedDoc> {
    this.dispose();
    const n = Math.max(1, opts.workers);
    this.lanes = Array.from({ length: n }, () => new Lane());
    this.encoders = Array.from({ length: Math.max(0, opts.encoders ?? 0) }, () => new Lane());
    const base = {
      type: 'load' as const,
      previewEdge: opts.previewEdge ?? 1400,
      thumbEdge: opts.thumbEdge ?? 300,
    };
    // the first lane reports progress and returns layer thumbnails
    const first = this.lanes[0].call<LoadedDoc>(
      { ...base, buffer: buffer.slice(0), keepComposite: opts.keepComposite, wantThumbs: true, reportProgress: true, calibrate: true },
      [],
      opts.onProgress,
    );
    // The UI only needs the first worker. Extra export workers decode the file
    // afterwards, one at a time and full resolution only, so they no longer
    // compete with the first one for the CPU (loading took longer with four).
    const extra = this.lanes.slice(1);
    this.lanes = [this.lanes[0]];
    this.doc = await first;
    const profileNow = this.doc.calibration?.profile;
    const gen = ++this.loadGen;
    void (async () => {
      for (const l of extra) {
        if (gen !== this.loadGen) return l.terminate();
        try {
          await l.call<LoadedDoc>({ ...base, buffer: buffer.slice(0), keepComposite: false, wantThumbs: false, reportProgress: false, calibrate: false, exportOnly: true });
          const p = this.profile ?? profileNow;
          if (p) await l.call({ type: 'setProfile', profile: p });
          if (gen !== this.loadGen) return l.terminate();
          this.lanes.push(l);
        } catch {
          l.terminate(); // e.g. out of memory: export with fewer workers
        }
      }
    })();
    return this.doc;
  }

  /** Compositing rules for every worker (auto-detected at load, or chosen by the user). */
  async setProfile(profile: ProfileId): Promise<void> {
    this.profile = profile;
    await Promise.all(this.lanes.map((l) => l.call({ type: 'setProfile', profile })));
  }

  get workerCount(): number {
    return this.lanes.length;
  }

  get encoderCount(): number {
    return this.encoders.length;
  }

  /** Encoder workers hold no document, so their number can change any time (idle ones go first). */
  setEncoders(n: number): void {
    if (!this.doc) return;
    n = Math.max(0, n);
    while (this.encoders.length < n) this.encoders.push(new Lane());
    while (this.encoders.length > n) {
      const idle = this.encoders.findIndex((l) => l.busy === 0);
      if (idle < 0) break;
      this.encoders.splice(idle, 1)[0].terminate();
    }
  }

  /** pictures that can be in flight at once during an export */
  get exportSlots(): number {
    return this.lanes.length + this.encoders.length;
  }

  /** Latest-wins preview: stale requests resolve to null. */
  async preview(visible: Set<string>, level: 'preview' | 'full' = 'preview'): Promise<RenderedImage | null> {
    const my = ++this.previewSeq;
    const img = await this.lanes[0].call<RenderedImage>({ type: 'render', level, visible: [...visible] });
    return my === this.previewSeq ? img : null;
  }

  /**
   * Main-preview render: a newer call stops the one still running in the
   * worker (it rejects with "superseded"), so only the latest state is computed.
   */
  previewRender(visible: Set<string>, level: 'preview' | 'thumb'): Promise<RenderedImage> {
    return this.lanes[0].call<RenderedImage>({ type: 'render', level, visible: [...visible], latest: true });
  }

  /** Plain render (not latest-wins), e.g. for verification. */
  render(visible: Set<string>, level: 'full' | 'preview' | 'thumb'): Promise<RenderedImage> {
    return this.lanes[0].call<RenderedImage>({ type: 'render', level, visible: [...visible] });
  }

  thumb(visible: Set<string>): Promise<RenderedImage> {
    return this.lanes[0].call<RenderedImage>({ type: 'render', level: 'thumb', visible: [...visible] });
  }

  /**
   * Full-resolution render + encode. With encoder workers this is a pipeline:
   * a render worker hands the raw pixels to an encoder and immediately starts
   * the next picture (unchanged tiles are reused from its previous render).
   */
  async exportImage(visible: Set<string>, format: EncodeFormat, quality: number, scale: number): Promise<Encoded> {
    const least = (ls: Lane[]) => ls.reduce((a, b) => (b.busy < a.busy ? b : a));
    const lane = least(this.lanes);
    if (!this.encoders.length) return lane.call<Encoded>({ type: 'export', visible: [...visible], format, quality, scale });
    const raw = await lane.call<RawImage>({ type: 'renderExport', visible: [...visible], scale });
    const enc = await least(this.encoders).call<Encoded>(
      { type: 'encode', data: raw.data, width: raw.width, height: raw.height, opaque: raw.opaque, format, quality },
      [raw.data.buffer],
    );
    enc.timing = { ...(enc.timing ?? { filter: 0, deflate: 0, other: 0 }), render: raw.render, reused: raw.reused, tiles: raw.tiles };
    return enc;
  }

  compare(): Promise<CompareResult> {
    return this.lanes[0].call<CompareResult>({ type: 'compare' });
  }

  dispose(): void {
    this.loadGen++;
    this.profile = null;
    for (const l of this.lanes) l.terminate();
    for (const l of this.encoders) l.terminate();
    this.lanes = [];
    this.encoders = [];
    this.doc = null;
  }
}

export const engine = new Engine();
