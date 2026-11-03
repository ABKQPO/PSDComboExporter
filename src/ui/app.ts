/** App shell: top bar, preview stage, step tabs, overlays, toasts. */

import * as store from './store';
import { h, clear } from './dom';
import { renderLayersPanel, patchLayersPanel } from './layersPanel';
import { renderRulesPanel } from './rulesPanel';
import { renderConstraintsPanel } from './constraintsPanel';
import { renderCombosPanel, resetCombosPaging } from './combosPanel';
import { renderExportPanel, cancelExport, startExport } from './exportPanel';
import { renderSettingsPanel } from './settingsPanel';
import { renderDropZone, pickFile, importFile, PSD_EXT } from './importPanel';
import { renderHome } from './home';
import { renderHelp, renderOptionEditor } from './modals';
import { createViewer, type Viewer } from './viewer';
import { syncNodeEditor } from './nodeEditor';
import { loadRecent } from './recent';

let root: HTMLElement;
let previewCanvas: HTMLCanvasElement;
let stageHost: HTMLElement;
let sidebarHost: HTMLElement;
let overlayHost: HTMLElement;
let tabbarHost: HTMLElement;
let titleHost: HTMLElement;
let viewer: Viewer | null = null;
let stageBar: HTMLElement | null = null;
let stageFoot: HTMLElement | null = null;
let zoomBtn: HTMLElement | null = null;
let stageProject = '';

/** undefined: keep current scroll; null: reset to top */
let pendingScrollTop: number | null | undefined;

/**
 * Close the open document and show the home screen again. The document's
 * option groups stay saved, so re-opening the same file restores them.
 */
export function closeToHome(): void {
  if (store.state.exporting) {
    if (!confirm('正在导出，确定要关闭当前文件吗？')) return;
    cancelExport();
  }
  viewer = null;
  stageProject = '';
  store.state.homeDismissed = false;
  store.closeProject();
  store.state.recent = loadRecent();
  store.notify();
}

const TABS: { id: store.TabId; label: string; short: string }[] = [
  { id: 'layers', label: '1 图层', short: '图层' },
  { id: 'rules', label: '2 选项组', short: '选项组' },
  { id: 'constraints', label: '3 规则', short: '规则' },
  { id: 'combos', label: '4 组合', short: '组合' },
  { id: 'export', label: '5 导出', short: '导出' },
  { id: 'settings', label: '设置', short: '设置' },
];

export function mount(el: HTMLElement): void {
  root = el;
  root.className = 'app';
  previewCanvas = h('canvas', { class: 'preview' });
  build();
  store.subscribe(render);
  store.setDocumentChangeHook(() => {
    pendingScrollTop = null;
    resetCombosPaging();
  });
  document.body.dataset.platform = store.state.platform;
  render();
}

function build(): void {
  clear(root);
  const topbar = h('div', { class: 'topbar' });
  topbar.appendChild(
    h(
      'button',
      {
        class: 'brand home-back',
        title: '关闭当前文件，返回主界面',
        onclick: () => closeToHome(),
      },
      h('span', { class: 'logo' }, '◩'),
      'PSD 组合导出',
    ),
  );
  titleHost = h('div', { class: 'doc-title' });
  topbar.appendChild(titleHost);
  topbar.appendChild(h('span', { class: 'spacer' }));
  topbar.appendChild(h('button', { class: 'btn small', onclick: () => pickFile(), title: '导入 PSD / IPV（Ctrl+O）' }, '导入'));
  quickExportHost = h('span', { class: 'quick-export' });
  topbar.appendChild(quickExportHost);
  topbar.appendChild(
    h(
      'button',
      {
        class: 'btn small ghost',
        title: '显示 / 隐藏各页顶部的蓝色说明',
        onclick: () => {
          const st = store.state;
          st.guidesHidden = !st.guidesHidden;
          try {
            localStorage.setItem('psd-export:guides-hidden', st.guidesHidden ? '1' : '0');
          } catch {
            /* ignore */
          }
          store.notify(true);
        },
      },
      '说明',
    ),
  );
  topbar.appendChild(
    h('button', { class: 'btn small ghost', title: '使用说明', onclick: () => ((store.state.helpOpen = true), store.notify()) }, '?'),
  );
  root.appendChild(topbar);

  const body = h('div', { class: 'body' });
  stageHost = h('div', { class: 'stage' });
  body.appendChild(stageHost);
  sidebarHost = h('div', { class: 'sidebar' });
  // a rebuild skipped while typing happens when the field is left; only then
  // (rebuilding on every focus change looped on Android, where removing a
  // focused element fires focusout)
  sidebarHost.addEventListener('focusout', () => {
    if (!deferredRebuild) return;
    setTimeout(() => {
      if (deferredRebuild && !editingInSidebar()) store.notify();
    }, 0);
  });
  // phone keyboard: while typing, the panel takes the full height instead of
  // being squeezed (and re-laid out) by the keyboard
  sidebarHost.addEventListener('focusin', (e) => sidebarHost.classList.toggle('typing', isTextField(e.target)));
  sidebarHost.addEventListener('focusout', () => setTimeout(() => sidebarHost.classList.toggle('typing', editingInSidebar()), 0));
  body.appendChild(sidebarHost);
  root.appendChild(body);

  tabbarHost = h('div', { class: 'tabbar' });
  root.appendChild(tabbarHost);
  overlayHost = h('div', null);
  root.appendChild(overlayHost);

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      pickFile();
    }
    if (e.key === 'Escape' && (store.state.editingOption || store.state.helpOpen)) {
      store.state.editingOption = null;
      store.state.helpOpen = false;
      store.notify();
    }
  });
}

function renderStage(): void {
  const s = store.state;
  if (!s.project) {
    stageBar = null;
    clear(stageHost);
    // The home screen lists recent files; the bare drop zone is only used
    // when the user explicitly starts a new import.
    stageHost.appendChild(s.homeDismissed ? renderDropZone() : renderHome());
    return;
  }
  const p = s.project;
  if (!viewer) {
    viewer = createViewer(previewCanvas);
    viewer.onChange = () => {
      if (zoomBtn && store.state.project) zoomBtn.textContent = `${Math.round(viewer!.docZoom(store.state.project.width) * 100)}%`;
    };
  }
  // the viewer stays in the DOM: rebuilding it would cancel a pinch in progress
  if (!stageBar || stageBar.parentElement !== stageHost) {
    clear(stageHost);
    stageBar = h('div', { class: 'stage-bar' });
    stageFoot = h('div', { class: 'stage-foot hint' });
    stageHost.append(stageBar, viewer.el, stageFoot);
  }
  if (stageProject !== p.id) {
    stageProject = p.id;
    viewer.reset();
  }
  const bar = stageBar;
  clear(bar);
  const combo = s.focusCombo >= 0 ? s.result?.combos[s.focusCombo] : null;
  const labels = p.rules
    .filter((r) => r.kind !== 'fixed')
    .map((r) => {
      const ids = s.selection[r.id] ?? [];
      const names = r.options.filter((o) => ids.includes(o.id)).map((o) => o.name);
      return `${r.name}：${names.join('+') || '无'}`;
    });
  bar.appendChild(
    h(
      'div',
      { class: 'stage-caption' },
      combo ? h('span', { class: 'pill ok' }, `组合 #${s.focusCombo + 1}`) : h('span', { class: 'pill' }, '当前选择'),
      h('span', { class: 'caption-text', title: labels.join('　') }, labels.join('　') || '没有选项组，显示 PSD 原样'),
    ),
  );
  const v = store.currentViolations();
  if (v.length) bar.appendChild(h('span', { class: 'pill bad', title: v.join('\n') }, '违反规则，不会导出'));
  if (s.previewBusy) bar.appendChild(h('span', { class: 'spinner', title: '渲染中' }));
  const vw = viewer;
  bar.appendChild(
    h(
      'div',
      { class: 'view-tools' },
      h('button', { class: 'btn ghost small', title: '向左旋转 90°', onclick: () => vw.rotate(-90) }, '⟲'),
      h('button', { class: 'btn ghost small', title: '向右旋转 90°', onclick: () => vw.rotate(90) }, '⟳'),
      (zoomBtn = h('button', { class: 'btn ghost small zoom', title: '复位：适应窗口、取消旋转（也可双击画面）', onclick: () => vw.reset() }, '')),
    ),
  );
  stageFoot!.textContent = `预览为缩小的近似图，导出按原始尺寸 ${p.width}×${p.height} 精确合成。拖动平移 · 双指/滚轮缩放 · 双指或 Shift+滚轮旋转 · 双击复位`;
  previewCanvas.style.visibility = s.previewSize ? 'visible' : 'hidden';
  viewer.apply();
  store.setPreviewCanvas(previewCanvas);
  store.schedulePreview(0);
}

let deferredRebuild = false;

function isTextField(t: EventTarget | null): boolean {
  const a = t as HTMLInputElement | null;
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && !['checkbox', 'radio', 'range', 'button'].includes(a.type);
}

function editingInSidebar(): boolean {
  const a = document.activeElement as HTMLElement | null;
  return !!a && sidebarHost.contains(a) && isTextField(a);
}

function patchTabBadges(): void {
  const s = store.state;
  if (!s.project) return;
  for (const el of sidebarHost.querySelectorAll<HTMLElement>('.tab-badge[data-tab]')) {
    const t = el.dataset.tab;
    const n = t === 'rules' ? s.project.rules.length : t === 'constraints' ? s.project.constraints.length : t === 'combos' ? s.result?.combos.length ?? 0 : 0;
    el.textContent = String(n);
    el.style.display = n ? '' : 'none';
  }
}

/** Light refresh of the combination grid: swap in thumbnails that just arrived. */
function patchComboThumbs(): void {
  for (const cell of sidebarHost.querySelectorAll<HTMLElement>('.cell[data-sig]')) {
    const ph = cell.querySelector('.ph');
    const url = ph && store.state.comboThumbs.get(cell.dataset.sig!);
    if (ph && url) ph.replaceWith(h('img', { src: url, alt: '' }));
  }
}

let lastSidebarTab = '';
function renderSidebar(force: boolean): void {
  const s = store.state;
  // preview / toast / busy updates don't touch the panel: no rebuild
  const patch = store.takePatch();
  if (!force && lastSidebarTab === s.tab && sidebarHost.childElementCount) {
    sidebarHost.classList.toggle('open', s.sheetOpen);
    sidebarHost.classList.toggle('tall', s.sheetTall);
    if (s.tab === 'combos') patchComboThumbs();
    if (patch) {
      if (s.tab === 'layers') patchLayersPanel();
      patchTabBadges();
    }
    return;
  }
  // never rebuild under the user's caret; re-render once the field loses focus
  if (s.project && editingInSidebar()) {
    deferredRebuild = true;
    if (patch && s.tab === 'layers') patchLayersPanel();
    return;
  }
  deferredRebuild = false;
  lastSidebarTab = s.tab;
  const active = document.activeElement as HTMLInputElement | null;
  const searchFocus = active?.classList.contains('search') ? { start: active.selectionStart, end: active.selectionEnd } : null;
  const prev = sidebarHost.querySelector('.tab-panel') as HTMLElement | null;
  const prevScroll = prev ? prev.scrollTop : 0;
  const prevTab = sidebarHost.dataset.tab;
  clear(sidebarHost);
  if (!s.project) {
    sidebarHost.classList.remove('open');
    return;
  }
  const tabs = h('div', { class: 'tabs' });
  for (const t of TABS) {
    const badge =
      t.id === 'rules' ? s.project.rules.length : t.id === 'constraints' ? s.project.constraints.length : t.id === 'combos' ? s.result?.combos.length ?? 0 : null;
    tabs.appendChild(
      h(
        'button',
        { class: 'tab' + (s.tab === t.id ? ' active' : ''), onclick: () => store.setTab(t.id) },
        t.label,
        h('span', { class: 'tab-badge', 'data-tab': t.id, style: badge ? '' : 'display:none' }, String(badge ?? '')),
      ),
    );
  }
  tabs.appendChild(
    h(
      'button',
      { class: 'sheet-size', title: '面板高度', onclick: () => ((s.sheetTall = !s.sheetTall), store.notify(true)) },
      s.sheetTall ? '缩小面板' : '展开面板',
    ),
  );
  tabs.appendChild(h('button', { class: 'sheet-close', onclick: () => ((s.sheetOpen = false), store.notify(true)) }, '收起'));
  sidebarHost.appendChild(tabs);

  const panel = h('div', { class: 'tab-panel' });
  switch (s.tab) {
    case 'layers':
      panel.appendChild(renderLayersPanel());
      break;
    case 'rules':
      panel.appendChild(renderRulesPanel());
      break;
    case 'constraints':
      panel.appendChild(renderConstraintsPanel());
      break;
    case 'combos':
      panel.appendChild(renderCombosPanel());
      break;
    case 'export':
      panel.appendChild(renderExportPanel());
      break;
    case 'settings':
      panel.appendChild(renderSettingsPanel());
      break;
  }
  const next = TABS.findIndex((t) => t.id === s.tab) + 1;
  if (next < TABS.length && TABS[next].id !== 'settings') {
    panel.appendChild(
      h('button', { class: 'btn next-step', onclick: () => store.setTab(TABS[next].id) }, `下一步：${TABS[next].short} →`),
    );
  }
  sidebarHost.appendChild(panel);
  const sameTab = prevTab === s.tab;
  panel.scrollTop = pendingScrollTop === null || !sameTab ? 0 : prevScroll;
  pendingScrollTop = undefined;
  sidebarHost.dataset.tab = s.tab;
  sidebarHost.classList.toggle('open', s.sheetOpen);
  sidebarHost.classList.toggle('tall', s.sheetTall);

  // back to top
  const top = h('button', { class: 'to-top', title: '回到顶部', onclick: () => panel.scrollTo({ top: 0, behavior: 'smooth' }) }, '↑');
  const syncTop = () => top.classList.toggle('show', panel.scrollTop > 400);
  panel.addEventListener('scroll', syncTop, { passive: true });
  syncTop();
  sidebarHost.appendChild(top);

  if (searchFocus) {
    const box = panel.querySelector<HTMLInputElement>('.search');
    if (box) {
      box.focus();
      box.setSelectionRange(searchFocus.start, searchFocus.end);
    }
  }
}

let quickExportHost: HTMLElement;

function render(): void {
  const s = store.state;
  clear(titleHost);
  if (s.project) titleHost.appendChild(h('span', { title: s.project.name }, s.project.name));
  // no document: the home screen spans the whole stage, the side panel hides
  document.body.classList.toggle('home-mode', !s.project);
  // one-click export from anywhere once a file is open
  clear(quickExportHost);
  if (s.project && s.result) {
    const n = store.selectedCombos().length;
    quickExportHost.appendChild(
      h(
        'button',
        { class: 'btn small' + (s.nodeEditorOpen ? ' on' : ''), title: '节点工作流：像 Blender 节点一样连线设置组合与互斥', onclick: () => store.setNodeEditor(!s.nodeEditorOpen) },
        '节点',
      ),
    );
    quickExportHost.appendChild(
      h(
        'button',
        { class: 'btn small primary', disabled: !n || s.exporting, title: '按当前设置把要导出的组合打包成 ZIP', onclick: () => void startExport() },
        `一键导出 ${n} 张`,
      ),
    );
  }
  renderStage();
  const dirty = store.takeSidebarDirty();
  renderSidebar(dirty);
  syncNodeEditor(dirty);
  document.body.classList.toggle('guides-hidden', s.guidesHidden);

  clear(tabbarHost);
  if (s.project) {
    for (const t of TABS) {
      tabbarHost.appendChild(
        h(
          'button',
          {
            class: s.tab === t.id && s.sheetOpen ? 'active' : '',
            onclick: () => {
              if (s.tab === t.id && s.sheetOpen) s.sheetOpen = false;
              else store.setTab(t.id);
              store.notify();
            },
          },
          t.short,
        ),
      );
    }
  }

  clear(overlayHost);
  const editor = renderOptionEditor();
  if (editor) overlayHost.appendChild(editor);
  const help = renderHelp();
  if (help) overlayHost.appendChild(help);
  if (s.busy) overlayHost.appendChild(renderBusy(s.busy, s.busyProgress));
  if (s.toasts.length) {
    const wrap = h('div', { class: 'toasts' });
    for (const t of s.toasts) wrap.appendChild(h('div', { class: `toast ${t.tone}` }, t.text));
    overlayHost.appendChild(wrap);
  }
}

function renderBusy(label: string, progress: number): HTMLElement {
  const modal = h('div', { class: 'modal' });
  modal.appendChild(h('h2', null, store.state.exporting ? '导出中' : '请稍候'));
  modal.appendChild(h('div', { class: 'busy-label' }, label));
  modal.appendChild(h('div', { class: 'progress' }, h('i', { style: `width:${Math.round(progress * 100)}%` })));
  modal.appendChild(h('div', { class: 'hint', style: 'text-align:right' }, `${Math.round(progress * 100)}%`));
  if (store.state.cancellable) {
    modal.appendChild(h('button', { class: 'btn', style: 'width:100%', onclick: () => cancelExport() }, '取消导出'));
  }
  return h('div', { class: 'overlay' }, modal);
}

export function installGlobalDrop(): void {
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f && PSD_EXT.test(f.name)) await importFile(f);
    else if (f) store.toast('请拖入 .psd / .psb / .ipv 文件', 'bad');
  });
}
