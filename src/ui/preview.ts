import type { Combo } from '../core/rules';
import { detectPlatform } from '../core/platform';
import { engine } from '../engine/client';
import type { RenderedImage } from '../engine/protocol';
import * as store from './store';
import { t } from '../i18n';

let previewTarget: HTMLCanvasElement | null = null;
let previewTimer: number | undefined;
let lastPreviewKey = '';
type PreviewJob = { key: string; on: Set<string> };
let wanted: PreviewJob | null = null;
let previewRunning = false;
let lastPreviewMs = 0;
let previewToken = 0;
const previewCache = new Map<string, RenderedImage>();
let previewCacheBytes = 0;
const PREVIEW_CACHE_BYTES = (detectPlatform() === 'android' ? 32 : 96) * 1024 * 1024;
const thumbQueue: Combo[] = [];
let thumbRunning = false;

export function setPreviewCanvas(canvas: HTMLCanvasElement | null): void {
  previewTarget = canvas;
}

export function previewSourceCanvas(): HTMLCanvasElement | null {
  return previewTarget && previewTarget.width && previewTarget.height ? previewTarget : null;
}

export function schedulePreview(delay = 30): void {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => void renderPreview(), delay);
}

export function imageToCanvas(img: RenderedImage, canvas?: HTMLCanvasElement): HTMLCanvasElement {
  const target = canvas ?? document.createElement('canvas');
  if (target.width !== img.width) target.width = img.width;
  if (target.height !== img.height) target.height = img.height;
  target.getContext('2d')!.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  return target;
}

function cachePreview(key: string, img: RenderedImage): void {
  if (previewCache.has(key)) return;
  previewCache.set(key, img);
  previewCacheBytes += img.data.byteLength;
  for (const [cacheKey, value] of previewCache) {
    if (previewCacheBytes <= PREVIEW_CACHE_BYTES || previewCache.size <= 1) break;
    previewCache.delete(cacheKey);
    previewCacheBytes -= value.data.byteLength;
  }
}

function showPreview(img: RenderedImage, key: string, final: boolean): void {
  if (!previewTarget) return;
  imageToCanvas(img, previewTarget);
  store.state.previewSize = { width: img.width, height: img.height };
  lastPreviewKey = final ? key : '';
  store.notify(true);
}

async function renderPreview(): Promise<void> {
  const vis = store.state.vis;
  if (!vis || !previewTarget || !engine.doc) return;
  const key = [...vis.on].sort().join(',');
  if (wanted?.key === key && previewRunning) return;
  wanted = { key, on: new Set(vis.on) };
  if (key === lastPreviewKey && store.state.previewSize) {
    if (previewRunning) {
      previewToken++;
      previewRunning = false;
      store.state.previewBusy = false;
      store.notify(true);
    }
    return;
  }
  const hit = previewCache.get(key);
  if (hit) {
    previewCache.delete(key);
    previewCache.set(key, hit);
    previewToken++;
    previewRunning = false;
    store.state.previewBusy = false;
    showPreview(hit, key, true);
    return;
  }
  const job = wanted;
  const token = ++previewToken;
  previewRunning = true;
  if (!store.state.previewBusy) {
    store.state.previewBusy = true;
    store.notify(true);
  }
  try {
    if (store.state.prefs.quickPreview && lastPreviewMs > 160) {
      const quick = await engine.previewRender(job.on, 'thumb');
      if (token !== previewToken) return;
      showPreview(quick, job.key, false);
    }
    const start = performance.now();
    const img = await engine.previewRender(job.on, 'preview');
    lastPreviewMs = performance.now() - start;
    cachePreview(job.key, img);
    if (token === previewToken) showPreview(img, job.key, true);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg !== 'superseded' && token === previewToken) store.toast(t('app.previewFailed', { msg }), 'bad');
  } finally {
    if (token === previewToken) {
      previewRunning = false;
      store.state.previewBusy = false;
      store.notify(true);
    }
  }
}

export function previewPending(): boolean {
  return previewRunning;
}

export function invalidatePreview(): void {
  lastPreviewKey = '';
  previewCache.clear();
  previewCacheBytes = 0;
  lastPreviewMs = 0;
}

export function requestComboThumb(combo: Combo): void {
  if (store.state.comboThumbs.has(combo.signature) || thumbQueue.includes(combo)) return;
  thumbQueue.push(combo);
  if (!thumbRunning) void pumpThumbs();
}

async function pumpThumbs(): Promise<void> {
  thumbRunning = true;
  while (thumbQueue.length) {
    while (previewRunning) await new Promise((resolve) => setTimeout(resolve, 40));
    const combo = thumbQueue.shift()!;
    if (store.state.comboThumbs.has(combo.signature)) continue;
    try {
      const img = await engine.thumb(combo.on);
      store.state.comboThumbs.set(combo.signature, imageToCanvas(img).toDataURL('image/png'));
      store.notify(true);
    } catch {
      break;
    }
  }
  thumbRunning = false;
}

export function clearThumbQueue(): void {
  thumbQueue.length = 0;
}
