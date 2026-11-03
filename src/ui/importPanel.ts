/** Import flow: file picker / drag-drop / Electron "open with" -> engine decode. */

import * as store from './store';
import * as recent from './recent';
import { h } from './dom';
import { engine } from '../engine/client';
import { buildProject } from '../core/project';
import { fmtBytes } from './dom';

/** Photoshop documents and ibisPaint artworks */
export const PSD_EXT = /\.(psd|psb|ipv)$/i;

export async function importFile(file: File): Promise<void> {
  if (!PSD_EXT.test(file.name)) {
    store.toast('请选择 .psd / .psb（Photoshop 等）或 .ipv（爱笔思画）文件', 'bad');
    return;
  }
  store.setBusy(`正在读取 ${file.name}（${fmtBytes(file.size)}）…`, 0.02);
  try {
    const tStart = performance.now();
    const buffer = await file.arrayBuffer();
    store.setBusy('正在解析图层结构…', 0.05);
    const doc = await engine.load(buffer, {
      // (test hook: simulate a phone's worker setup on a PC)
      workers: (window as any).__psdForceLanes?.workers ?? store.workerCount(),
      // PNG compression on its own light worker (no document copy), so the
      // next picture renders meanwhile: on phones this nearly halves exports
      // (2 on phones with 6+ cores: with unchanged tiles reused, compression
      // became the slower half of each picture)
      encoders: (window as any).__psdForceLanes?.encoders ?? store.encoderCount(),
      keepComposite: store.state.platform !== 'android',
      onProgress: (done, total, label) =>
        store.setBusy(`解码图层 ${done}/${total}：${label}`, 0.05 + (done / Math.max(1, total)) * 0.9),
    });
    const tLoaded = performance.now();
    const project = buildProject(file.name, file.size, doc);

    const thumbs = new Map<string, string>();
    const c = document.createElement('canvas');
    for (const [id, t] of Object.entries(doc.thumbs)) {
      c.width = t.width;
      c.height = t.height;
      c.getContext('2d')!.putImageData(new ImageData(t.data as Uint8ClampedArray<ArrayBuffer>, t.width, t.height), 0, 0);
      thumbs.set(id, c.toDataURL('image/png'));
    }
    const tThumbs = performance.now();
    const warnings = [...doc.warnings];
    const unsupported = project.layers.filter((l) => l.unsupported.length);
    if (unsupported.length) {
      warnings.push(
        `${unsupported.length} 个图层含有无法完全还原的特性（${[...new Set(unsupported.flatMap((l) => l.unsupported))].join('、')}），已在「图层」页标出。`,
      );
    }
    store.loadProject(project, thumbs, warnings, { writer: doc.writer, calibration: doc.calibration });
    rememberFile(file, project);
    (window as any).__psdLoadStats = {
      ...(doc.stats ?? {}),
      engineWall: tLoaded - tStart,
      mainThumbs: tThumbs - tLoaded,
      mainLoadProject: performance.now() - tThumbs,
      total: performance.now() - tStart,
    };
    store.toast(
      `已载入 ${file.name}：${project.width}×${project.height}，${project.layers.length} 个图层/组，用时 ${(doc.ms / 1000).toFixed(1)} 秒`,
      'ok',
    );
  } catch (err) {
    console.error(err);
    engine.dispose();
    const msg = (err as Error).message || String(err);
    store.toast(
      /memory|内存|allocation/i.test(msg) ? `内存不足，无法打开这个 PSD：${msg}` : `解析失败：${msg}`,
      'bad',
    );
  } finally {
    store.setBusy(null);
  }
}

export function pickFile(): void {
  const input = document.createElement('input');
  input.type = 'file';
  // Android's picker greys out .psd when only the extension is listed
  input.accept = store.state.platform === 'android' ? '*/*' : '.psd,.psb,.ipv,image/vnd.adobe.photoshop';
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) void importFile(f);
  };
  input.click();
}

/** Downscaled data URL of the current document, for the home screen. */
function captureThumb(): string | undefined {
  try {
    const src = store.previewSourceCanvas?.() ?? null;
    if (!src || !src.width || !src.height) return undefined;
    const max = 168;
    const scale = Math.min(1, max / Math.max(src.width, src.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(src.width * scale));
    c.height = Math.max(1, Math.round(src.height * scale));
    const ctx = c.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.72);
  } catch {
    return undefined;
  }
}

function rememberFile(file: File, project: { name: string; width: number; height: number; layers: unknown[]; rules: unknown[] }): void {
  const p = store.state.project;
  if (!p) return;
  const key = store.storageKeyOf(p);
  // The preview is rendered asynchronously after load, so capture the
  // thumbnail once it is available rather than right away.
  const commit = (thumb?: string) => {
    recent.touchRecent(
      {
        key,
        name: file.name,
        width: project.width,
        height: project.height,
        layerCount: project.layers.length,
        ruleCount: project.rules.length,
        thumb,
        openedAt: Date.now(),
      },
      store.state.prefs.recentCount,
    );
    store.state.recent = recent.loadRecent();
    store.notify(true);
  };

  setTimeout(() => commit(captureThumb()), 700);
}

export function renderDropZone(): HTMLElement {
  const zone = h('div', { class: 'dropzone' });
  zone.appendChild(h('div', { class: 'dz-icon' }, 'PSD'));
  zone.appendChild(h('div', { class: 'big' }, '导入 PSD，批量导出所有图层组合'));
  zone.appendChild(
    h(
      'div',
      { class: 'hint', style: 'max-width:460px' },
      '选择要参与组合的图层 → 设定「必选 / 可选 / 互斥」规则 → 预览所有组合 → 一键导出为一个 ZIP 压缩包。导出图像按 Photoshop 的方式逐像素合成，与 PSD 原图一致。',
    ),
  );
  zone.appendChild(h('button', { class: 'btn primary big-btn', onclick: () => pickFile() }, '选择 PSD / IPV 文件'));
  zone.appendChild(h('div', { class: 'hint' }, '支持 Photoshop、SAI、Procreate、MediBang 等导出的 .psd / .psb，以及爱笔思画的 .ipv 作品文件。'))
  zone.appendChild(
    h(
      'div',
      { class: 'hint', style: 'margin-top:4px' },
      store.state.platform === 'android'
        ? '提示：若文件列表里看不到 PSD，请在选择器左上角菜单里切换到「文件」或对应文件夹。'
        : '也可以直接把 .psd / .ipv 文件拖进窗口。',
    ),
  );
  zone.appendChild(
    h('button', { class: 'btn ghost small', onclick: () => ((store.state.helpOpen = true), store.notify()) }, '查看使用说明'),
  );

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('hot');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('hot'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('hot');
    const f = e.dataTransfer?.files?.[0];
    if (f) void importFile(f);
  });
  return zone;
}
