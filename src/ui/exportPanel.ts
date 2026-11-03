/** Step 5 — export every combination into one ZIP. */

import * as store from './store';
import { h, fmtBytes } from './dom';
import { createTarget, openTextFile, saveTextFile } from '../core/platform';
import { exportNames, runExport, type ExportProgress } from '../core/exporter';
import { engine } from '../engine/client';

/** 75 -> "1:15", 3725 -> "1:02:05" */
export function fmtDuration(sec: number): string {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** A short beep (and a buzz on phones) when a long export is done. */
function remind(): void {
  try {
    navigator.vibrate?.(200);
  } catch {
    /* ignore */
  }
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.12, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.36);
    setTimeout(() => void ctx.close(), 600);
  } catch {
    /* no audio */
  }
}

let cancelRequested = false;

export function cancelExport(): void {
  cancelRequested = true;
  store.setBusy('正在取消…', store.state.busyProgress);
}

export function renderExportPanel(): HTMLElement {
  const s = store.state;
  const p = s.project!;
  const st = p.settings;
  const res = s.result!;
  const root = h('div', { class: 'col' });

  root.appendChild(
    h(
      'div',
      { class: 'guide' },
      h('b', null, '第 5 步：导出。'),
      st.exportMode === 'zip' ? ' 所有组合按原始尺寸逐像素合成，全部打包进一个 ZIP 压缩包。' : ' 所有组合按原始尺寸逐像素合成，直接写入你选择的文件夹。',
    ),
  );

  const card = h('div', { class: 'card' });
  card.appendChild(
    field(
      '格式',
      h(
        'select',
        {
          onchange: (e: Event) => {
            st.format = (e.target as HTMLSelectElement).value as typeof st.format;
            store.refresh({ keepFocus: true });
          },
        },
        h('option', { value: 'png', selected: st.format === 'png' }, 'PNG（无损，推荐）'),
        h('option', { value: 'jpeg', selected: st.format === 'jpeg' }, 'JPEG（有损，体积小，透明处填白）'),
        h('option', { value: 'webp', selected: st.format === 'webp' }, 'WebP（有损）'),
      ),
    ),
  );
  if (st.format !== 'png') {
    const val = h('span', { class: 'pill' }, String(st.quality));
    card.appendChild(
      field(
        '质量',
        h('input', {
          type: 'range',
          min: '50',
          max: '100',
          value: String(st.quality),
          oninput: (e: Event) => {
            st.quality = Number((e.target as HTMLInputElement).value);
            val.textContent = String(st.quality);
          },
          onchange: () => store.refresh({ keepFocus: true }),
        }),
        val,
      ),
    );
    card.appendChild(h('div', { class: 'notice warn' }, 'JPEG / WebP 是有损压缩，像素不会与 PSD 完全一致。需要完全一致请选 PNG。'));
  }
  card.appendChild(
    field(
      '尺寸',
      h(
        'select',
        {
          onchange: (e: Event) => {
            st.scale = Number((e.target as HTMLSelectElement).value);
            store.refresh({ keepFocus: true });
          },
        },
        ...[1, 0.5, 0.25].map((v) =>
          h(
            'option',
            { value: String(v), selected: Math.abs(st.scale - v) < 1e-6 },
            v === 1 ? `原始尺寸 ${p.width}×${p.height}（推荐）` : `${v * 100}%：${Math.round(p.width * v)}×${Math.round(p.height * v)}`,
          ),
        ),
      ),
    ),
  );
  card.appendChild(
    field(
      '文件名',
      h('input', {
        value: st.template,
        spellcheck: false,
        onchange: (e: Event) => {
          st.template = (e.target as HTMLInputElement).value.trim() || '{psd}-{combo}';
          store.refresh({ keepFocus: true });
        },
      }),
    ),
  );
  card.appendChild(
    h(
      'div',
      { class: 'hint' },
      '可用变量：{psd} 文件名　{combo} 所有选项名　{primary} 第一个选项组的选项　{index} 001 序号　{n} 1 序号。重名会自动加 (2)、(3)。',
    ),
  );
  card.appendChild(
    field(
      st.exportMode === 'zip' ? '压缩包内' : '文件夹内',
      h(
        'select',
        {
          onchange: (e: Event) => {
            st.layout = (e.target as HTMLSelectElement).value as typeof st.layout;
            store.refresh({ keepFocus: true });
          },
        },
        h('option', { value: 'flat', selected: st.layout === 'flat' }, '所有图片放在一起'),
        h('option', { value: 'primary', selected: st.layout === 'primary' }, `按第一个选项组「${p.rules.find((r) => r.enabled && r.kind !== 'fixed')?.name ?? '—'}」分文件夹`),
      ),
    ),
  );
  root.appendChild(card);

  // what to export
  const ticked = res.combos.filter((c) => !s.excludedCombos.has(c.signature)).length;
  const allN = s.exportScope === 'all' || res.rejected.length > 0 ? store.allPossibleResult()?.combos.length ?? 0 : res.combos.length;
  const scope = h('div', { class: 'card col', style: 'gap:6px' });
  scope.appendChild(h('div', { class: 'section-title', style: 'margin:0' }, '导出范围'));
  const scopes: [typeof s.exportScope, string, string][] = [
    ['selected', `已勾选的组合（${ticked} 张）`, '在「组合」页勾掉的不导出。'],
    ['valid', `全部有效组合（${res.combos.length} 张）`, '忽略「组合」页的勾选，导出所有符合规则的组合。'],
    ['all', `全部可能组合（${allN} 张）`, '连「规则」页的互斥 / 排除也忽略，选项组能拼出的每一种都导出。'],
  ];
  for (const [key, label, hint] of scopes) {
    scope.appendChild(
      h(
        'label',
        { class: 'radio' + (s.exportScope === key ? ' on' : '') },
        h('input', { type: 'radio', name: 'scope', checked: s.exportScope === key, onchange: () => store.setExportScope(key) }),
        h('span', null, h('b', null, label), h('span', { class: 'hint' }, ' ' + hint)),
      ),
    );
  }
  root.appendChild(scope);

  const chosen = store.selectedCombos();
  const names = exportNames(p, chosen);
  const sum = h('div', { class: 'card' });
  sum.appendChild(
    h(
      'div',
      { class: 'row wrap', style: 'gap:6px' },
      h('span', { class: chosen.length ? 'pill ok' : 'pill bad' }, `${chosen.length} 张图`),
      h('span', { class: 'pill' }, st.format.toUpperCase()),
      h('span', { class: 'pill' }, `${Math.round(p.width * st.scale)}×${Math.round(p.height * st.scale)}`),
      h(
        'span',
        { class: 'pill', title: '合成线程负责拼图层，压缩线程同时把上一张压成 PNG；相邻组合里没变的区域直接复用' },
        `${Math.max(1, engine.workerCount)} 合成 + ${engine.encoderCount} 压缩线程`,
      ),
    ),
  );
  const preview = h('div', { class: 'names mono' });
  for (const n of names.slice(0, 5)) preview.appendChild(h('div', null, n));
  if (names.length > 5) preview.appendChild(h('div', { class: 'hint' }, `…共 ${names.length} 个文件`));
  sum.appendChild(preview);
  sum.appendChild(
    h(
      'div',
      { class: 'hint' },
      st.exportMode === 'folder'
        ? s.platform === 'android'
          ? '点击导出后选择文件夹，图片会逐张写入该文件夹。'
          : s.platform === 'electron'
          ? '点击导出后选择文件夹，完成后会自动在资源管理器中显示。'
          : '点击导出后选择文件夹，浏览器需要支持 File System Access API。'
        : s.platform === 'android'
        ? '点击导出后会弹出系统「保存到」对话框，选择 ZIP 的保存位置（如「下载」）。'
        : s.platform === 'electron'
        ? '点击导出后选择 ZIP 的保存位置，完成后会自动在资源管理器中显示。'
        : '导出完成后浏览器会下载 ZIP。',
    ),
  );
  if (s.exportScope === 'selected' && chosen.length !== res.combos.length) {
    sum.appendChild(h('div', { class: 'hint' }, '在「组合」页可以勾选要导出的图，或点「全选」恢复导出全部。'));
  }
  if (s.exportScope === 'all' && res.rejected.length > 0) {
    sum.appendChild(h('div', { class: 'notice warn' }, `其中 ${chosen.length - res.combos.length} 张违反了「规则」页的互斥 / 排除规则，也会一起导出。`));
  }
  root.appendChild(sum);

  root.appendChild(
    h(
      'button',
      {
        class: 'btn primary big-btn',
        style: 'width:100%',
        disabled: chosen.length === 0 || s.exporting,
        onclick: () => void startExport(),
      },
      s.exporting ? '导出中…' : `导出 ${chosen.length} 张${st.exportMode === 'zip' ? '为 ZIP' : '到文件夹'}`,
    ),
  );

  // configuration files
  const cfg = h('div', { class: 'card col', style: 'gap:6px' });
  cfg.appendChild(h('div', { class: 'section-title', style: 'margin:0' }, '配置文件'));
  cfg.appendChild(
    h(
      'div',
      { class: 'hint' },
      '把选项组、规则、导出设置、显示/隐藏改动、整体组、组合勾选保存成一个 .json。模板画完后：导入新的 PSD → 导入配置 → 一键导出。图层按「组/图层」名字对应，改了名字的图层会提示。',
    ),
  );
  cfg.appendChild(
    h(
      'div',
      { class: 'row wrap', style: 'gap:6px' },
      h(
        'button',
        {
          class: 'btn small',
          onclick: async () => {
            try {
              const where = await saveTextFile(`${p.name.replace(/\.[^.]+$/, '')}-导出配置.json`, store.exportConfigText());
              if (where !== null) store.toast(where ? `配置已保存：${where}` : '配置已保存', 'ok');
            } catch (err) {
              store.toast(`保存配置失败：${(err as Error).message}`, 'bad');
            }
          },
        },
        '导出配置',
      ),
      h(
        'button',
        {
          class: 'btn small',
          onclick: async () => {
            try {
              const file = await openTextFile('.json');
              if (file) store.importConfigText(file.text);
            } catch (err) {
              store.toast(`导入配置失败：${(err as Error).message}`, 'bad');
            }
          },
        },
        '导入配置',
      ),
    ),
  );
  cfg.appendChild(
    h(
      'div',
      { class: 'row wrap', style: 'gap:6px;align-items:center;margin-top:4px' },
      h('button', { class: 'btn small danger', title: '清除这个文件的全部设置，回到刚导入的状态', onclick: () => store.startFresh(true) }, '全部重置'),
      h(
        'label',
        { class: 'row', style: 'gap:4px;font-size:12px' },
        h('input', { type: 'checkbox', checked: s.autoRestore, onchange: (e: Event) => store.setAutoRestore((e.target as HTMLInputElement).checked) }),
        '再次导入同一个文件时自动恢复设置',
      ),
    ),
  );
  root.appendChild(cfg);

  if (s.exportResult) {
    const r = s.exportResult;
    root.appendChild(
      h(
        'div',
        { class: 'notice ok' },
        h('div', null, h('b', null, '导出完成　'), r.summary),
        h('div', { class: 'hint' }, `${r.entries} 张，${fmtBytes(r.archiveBytes)}，用时 ${fmtDuration(r.elapsedMs / 1000)}（平均每张 ${(r.elapsedMs / 1000 / Math.max(1, r.entries)).toFixed(2)} 秒）`),
      ),
    );
  }
  return root;
}

function field(label: string, ...children: (HTMLElement | null)[]): HTMLElement {
  return h('div', { class: 'field' }, h('label', null, label), ...(children.filter(Boolean) as HTMLElement[]));
}

export async function startExport(): Promise<void> {
  const s = store.state;
  const p = s.project;
  const combos = store.selectedCombos();
  if (!p || s.exporting || !combos.length) return;
  if (s.prefs.confirmBig && combos.length > 300 && !confirm(`将导出 ${combos.length} 张原尺寸图片，可能需要较长时间。继续？`)) return;

  s.exporting = true;
  s.exportResult = null;
  cancelRequested = false;
  store.notify();
  const started = Date.now();
  let last: ExportProgress | null = null;
  // the elapsed time keeps counting between pictures
  const show = () => {
    if (cancelRequested || !last) return;
    const prog = last;
    const elapsed = (Date.now() - started) / 1000;
    const eta = prog.done > 0 ? (elapsed / prog.done) * (prog.total - prog.done) : 0;
    const what = s.prefs.progressNames ? `：${prog.current}` : '';
    store.setBusy(
      `正在导出第 ${Math.min(prog.total, prog.done + 1)} / ${prog.total} 张${what}\n已用 ${fmtDuration(elapsed)}` +
        (prog.done > 0 ? `，预计还需 ${fmtDuration(eta)}，已写入 ${fmtBytes(prog.bytes)}` : ''),
      prog.total ? prog.done / prog.total : 0,
      true,
    );
  };
  const ticker = setInterval(show, 1000);
  try {
    const target = await createTarget(p.settings.exportMode);
    const result = await runExport({
      project: p,
      combos,
      target,
      shouldCancel: () => cancelRequested,
      onProgress: (prog) => {
        last = prog;
        show();
      },
    });
    if (!result.cancelled) s.exportResult = result;
    store.toast(result.cancelled ? result.summary : `导出完成，用时 ${fmtDuration(result.elapsedMs / 1000)}`, result.cancelled ? 'info' : 'ok');
    if (!result.cancelled && s.prefs.notifyDone && result.elapsedMs > 5000) remind();
  } catch (err) {
    const msg = (err as Error).message;
    store.toast(/取消/.test(msg) ? msg : `导出失败：${msg}`, /取消/.test(msg) ? 'info' : 'bad');
  } finally {
    clearInterval(ticker);
    s.exporting = false;
    store.setBusy(null);
  }
}
