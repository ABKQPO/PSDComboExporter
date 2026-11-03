/**
 * Engine worker: owns the decoded PSD and does all pixel work off the UI
 * thread (decode, preview, thumbnails, full-size export + encoding).
 */

import { decodeDocument, type EngineDoc, type EngineNode } from './doc';
import { decodeIpv, isIpv } from './ipv';
import { render, renderCached, renderInterruptible, authoredVisibility, type ProfileId, type TileCache } from './composite';
import { calibrate, type Calibration } from './calibrate';
import { pixelDiff } from './compare';
import { encodePng } from './png';
import type { EngineRequest, LayerMeta, EncodeFormat } from './protocol';

let doc: EngineDoc | null = null;
/** generation of the newest "latest" (preview) render */
let latestGen = 0;
/** finished tiles of the last full-size export render (reused when unchanged) */
let tileCache: TileCache | null = null;
/** compositing rules used for every render (auto-detected at load, user can override) */
let profile: ProfileId = 'photoshop';
/** level indices: 0 = full, 1 = preview, 2 = thumbnail */
const LEVEL = { full: 0, preview: 1, thumb: 2 } as const;

const post = (msg: unknown, transfer: Transferable[] = []) => (self as any).postMessage(msg, transfer);

function meta(n: EngineNode): LayerMeta {
  return {
    id: n.id,
    kind: n.kind,
    name: n.name,
    hidden: n.hidden,
    opacity: n.opacity,
    fill: n.fill,
    blendMode: n.blendMode,
    clipping: n.clipping,
    bbox: n.bbox,
    hasMask: n.hasMask,
    effects: n.effects.map((e) => (e.kind === 'pattern' ? '图案叠加' : '颜色叠加')),
    unsupported: n.unsupported,
    children: n.children.map(meta),
  };
}

function boxDownscale(src: Uint8ClampedArray, w: number, h: number, scale: number) {
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const acc = new Float64Array(tw * th * 5);
  for (let y = 0; y < h; y++) {
    const ty = Math.min(th - 1, Math.floor((y * th) / h));
    for (let x = 0; x < w; x++) {
      const tx = Math.min(tw - 1, Math.floor((x * tw) / w));
      const s = (y * w + x) * 4;
      const t = (ty * tw + tx) * 5;
      const a = src[s + 3];
      acc[t] += src[s] * a;
      acc[t + 1] += src[s + 1] * a;
      acc[t + 2] += src[s + 2] * a;
      acc[t + 3] += a;
      acc[t + 4]++;
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
  return { data: out, width: tw, height: th };
}

async function encode(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  opaque: boolean,
  format: EncodeFormat,
  quality: number,
  stats?: { filter: number; deflate: number },
): Promise<Uint8Array> {
  if (format === 'png') return encodePng(data, width, height, { opaque, stats });
  if (typeof OffscreenCanvas === 'undefined') throw new Error('此设备不支持 JPEG/WebP 编码，请改用 PNG');
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  if (format === 'jpeg') {
    // JPEG has no alpha: flatten onto white like Photoshop's "Save As JPEG"
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    const tmp = new OffscreenCanvas(width, height);
    tmp.getContext('2d')!.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
    ctx.drawImage(tmp, 0, 0);
  } else {
    ctx.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  }
  const blob = await canvas.convertToBlob({
    type: format === 'jpeg' ? 'image/jpeg' : 'image/webp',
    quality: Math.max(0.05, Math.min(1, quality / 100)),
  });
  return new Uint8Array(await blob.arrayBuffer());
}

self.onmessage = async (ev: MessageEvent<EngineRequest>) => {
  const req = ev.data;
  try {
    switch (req.type) {
      case 'load': {
        const t0 = performance.now();
        doc = null;
        tileCache = null;
        const decode = isIpv(req.buffer) ? decodeIpv : decodeDocument;
        doc = await decode(req.buffer, {
          // the merged image is needed to detect the writer's compositing rules
          keepComposite: req.keepComposite || req.calibrate,
          thumbSize: req.exportOnly ? 0 : 48,
          onProgress: req.reportProgress
            ? (done, total, label) => post({ id: req.id, type: 'progress', done, total, label })
            : undefined,
          // integer box-filter factors for the preview and thumbnail levels
          levelFactorsFor: (w, h) => {
            if (req.exportOnly) return [];
            const m = Math.max(w, h);
            return [Math.max(1, Math.ceil(m / req.previewEdge)), Math.max(2, Math.ceil(m / req.thumbEdge))];
          },
        });
        const thumbs: Record<string, { width: number; height: number; data: Uint8ClampedArray }> = {};
        const transfer: Transferable[] = [];
        if (req.wantThumbs) {
          for (const [id, t] of doc.thumbs) {
            thumbs[id] = t;
            transfer.push(t.data.buffer);
          }
        }
        doc.thumbs.clear();
        let calibration: Calibration | null = null;
        const stats: Record<string, number> = { ...(doc.stats ?? {}), decodeTotal: performance.now() - t0 };
        if (req.calibrate) {
          if (req.reportProgress) post({ id: req.id, type: 'progress', done: 1, total: 1, label: '识别绘图软件的合成方式…' });
          const tc = performance.now();
          calibration = calibrate(doc);
          stats.calibrate = performance.now() - tc;
          profile = calibration.profile;
        }
        if (!req.keepComposite) doc.composite = null; // free memory (Android)
        post(
          {
            id: req.id,
            type: 'loaded',
            width: doc.width,
            height: doc.height,
            bitsPerChannel: doc.bitsPerChannel,
            hasComposite: !!doc.composite,
            writer: doc.writer,
            calibration,
            roots: doc.roots.map(meta),
            warnings: doc.warnings,
            thumbs,
            levels: doc.levels.map((l) => ({ k: l.k, width: l.width, height: l.height })),
            ms: performance.now() - t0,
            stats,
          },
          transfer,
        );
        break;
      }
      case 'render': {
        if (!doc) throw new Error('文档未载入');
        const on = new Set(req.visible);
        if (req.latest) {
          const gen = ++latestGen;
          const d = doc;
          const img = await renderInterruptible(d, LEVEL[req.level], (id) => on.has(id), { profile }, () => gen !== latestGen || doc !== d);
          if (!img) {
            post({ id: req.id, type: 'error', message: 'superseded' });
            break;
          }
          post({ id: req.id, type: 'image', width: img.width, height: img.height, data: img.data, opaque: img.opaque }, [img.data.buffer]);
          break;
        }
        const img = render(doc, LEVEL[req.level], (id) => on.has(id), { profile });
        post({ id: req.id, type: 'image', width: img.width, height: img.height, data: img.data, opaque: img.opaque }, [
          img.data.buffer,
        ]);
        break;
      }
      case 'renderExport': {
        if (!doc) throw new Error('文档未载入');
        const on = new Set(req.visible);
        const t0 = performance.now();
        const r = renderCached(doc, 0, (id) => on.has(id), { profile }, tileCache, profile);
        tileCache = r.cache;
        let { data, width, height } = r.result;
        const opaque = r.result.opaque;
        if (req.scale < 0.999) {
          const d = boxDownscale(data, width, height, req.scale);
          data = d.data;
          width = d.width;
          height = d.height;
        }
        const msg = { id: req.id, type: 'raw', data, width, height, opaque, render: performance.now() - t0, reused: r.reused, tiles: r.cache.keys.length };
        post(msg, [data.buffer]);
        break;
      }
      case 'encode': {
        const stats = { filter: 0, deflate: 0 };
        const t1 = performance.now();
        const bytes = await encode(req.data, req.width, req.height, req.opaque, req.format, req.quality, stats);
        const tEnc = performance.now() - t1;
        const timing = { render: 0, filter: stats.filter, deflate: stats.deflate, other: tEnc - stats.filter - stats.deflate };
        post({ id: req.id, type: 'encoded', bytes, width: req.width, height: req.height, timing }, [bytes.buffer]);
        break;
      }
      case 'export': {
        if (!doc) throw new Error('文档未载入');
        const on = new Set(req.visible);
        const t0 = performance.now();
        let img = render(doc, 0, (id) => on.has(id), { profile });
        const tRender = performance.now() - t0;
        let { data, width, height, opaque } = img;
        if (req.scale < 0.999) {
          const d = boxDownscale(data, width, height, req.scale);
          data = d.data;
          width = d.width;
          height = d.height;
        }
        const stats = { filter: 0, deflate: 0 };
        const t1 = performance.now();
        const bytes = await encode(data, width, height, opaque, req.format, req.quality, stats);
        const tEnc = performance.now() - t1;
        img = null as any;
        const timing = { render: tRender, filter: stats.filter, deflate: stats.deflate, other: tEnc - stats.filter - stats.deflate };
        post({ id: req.id, type: 'encoded', bytes, width, height, timing }, [bytes.buffer]);
        break;
      }
      case 'setProfile': {
        profile = req.profile;
        post({ id: req.id, type: 'ok' });
        break;
      }
      case 'compare': {
        if (!doc) throw new Error('文档未载入');
        if (!doc.composite) {
          post({ id: req.id, type: 'compared', available: false });
          break;
        }
        const vis = authoredVisibility(doc);
        const img = render(doc, 0, vis, { profile });
        // pixels touched by layer effects (rendered vs. hidden effect layers, grown by 2 px)
        const fxIds = new Set([...doc.nodes.values()].filter((n) => n.effects.length).map((n) => n.id));
        const W = doc.width;
        const H = doc.height;
        let fx: Uint8Array | null = null;
        if (fxIds.size) {
          const plain = render(doc, 0, (id) => vis(id) && !fxIds.has(id), { profile });
          fx = new Uint8Array(W * H);
          for (let i = 0; i < W * H; i++) {
            const p = i * 4;
            if (plain.data[p] === img.data[p] && plain.data[p + 1] === img.data[p + 1] && plain.data[p + 2] === img.data[p + 2] && plain.data[p + 3] === img.data[p + 3]) continue;
            const x = i % W;
            const y = (i - x) / W;
            for (let yy = Math.max(0, y - 2); yy <= Math.min(H - 1, y + 2); yy++)
              for (let xx = Math.max(0, x - 2); xx <= Math.min(W - 1, x + 2); xx++) fx[yy * W + xx] = 1;
          }
        }
        const ref = doc.composite;
        const stat = { same: 0, near: 0, max: 0, n: 0 };
        const fstat = { same: 0, near: 0, max: 0, n: 0 };
        for (let i = 0; i < W * H; i++) {
          const d = pixelDiff(img.data, ref, i * 4);
          const st = fx && fx[i] ? fstat : stat;
          st.n++;
          if (d === 0) st.same++;
          if (d <= 2) st.near++;
          if (d > st.max) st.max = d;
        }
        post({
          id: req.id,
          type: 'compared',
          available: true,
          same: stat.same / Math.max(1, stat.n),
          near: stat.near / Math.max(1, stat.n),
          max: stat.max,
          effectPixels: fstat.n / (W * H),
          effectSame: fstat.n ? fstat.same / fstat.n : 1,
          effectMax: fstat.max,
        });
        break;
      }
    }
  } catch (err) {
    post({ id: req.id, type: 'error', message: (err as Error)?.message ?? String(err) });
  }
};
