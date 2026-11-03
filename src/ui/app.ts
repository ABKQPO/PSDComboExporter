/** App shell: top bar, preview stage, step tabs, overlays, toasts. */

import * as store from './store';
import { t } from '../i18n';
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
    if (!confirm(t('app.closeConfirm'))) return;
    cancelExport();
  }
  viewer = null;
  stageProject = '';
  store.state.homeDismissed = false;
  store.closeProject();
  store.state.recent = loadRecent();
  store.notify();
}

function tabDefs(): { id: store.TabId; label: string; short: string }[] {
  return [
    { id: 'layers', label: '1 ' + t('tab.layers'), short: t('tab.layers') },
    { id: 'rules', label: '2 ' + t('tab.rules'), short: t('tab.rules') },
    { id: 'constraints', label: '3 ' + t('tab.constraints'), short: t('tab.constraints') },
    { id: 'combos', label: '4 ' + t('tab.combos'), short: t('tab.combos') },
    { id: 'export', label: '5 ' + t('tab.export'), short: t('tab.export') },
    { id: 'settings', label: t('tab.settings'), short: t('tab.settings') },
  ];
}

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
        title: t('app.backHome'),
        onclick: () => closeToHome(),
      },
      h('span', { class: 'logo' }, '◩'),
      t('app.name'),
    ),
  );
  titleHost = h('div', { class: 'doc-title' });
  topbar.appendChild(titleHost);
  topbar.appendChild(h('span', { class: 'spacer' }));
  topbar.appendChild(h('button', { class: 'btn small', onclick: () => pickFile(), title: t('app.importTitle') }, t('app.import')));
  quickExportHost = h('span', { class: 'quick-export' });
  topbar.appendChild(quickExportHost);
  topbar.appendChild(
    h(
      'button',
      {
        class: 'btn small ghost',
        title: t('app.guidesTitle'),
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
      t('app.guides'),
    ),
  );
  topbar.appendChild(
    h('button', { class: 'btn small ghost', title: t('app.helpTitle'), onclick: () => ((store.state.helpOpen = true), store.notify()) }, '?'),
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
      return `${r.name}: ${names.join('+') || t('common.none')}`;
    });
  bar.appendChild(
    h(
      'div',
      { class: 'stage-caption' },
      combo ? h('span', { class: 'pill ok' }, `#${s.focusCombo + 1}`) : h('span', { class: 'pill' }, t('app.currentSelection')),
      h('span', { class: 'caption-text', title: labels.join('　') }, labels.join('　') || t('app.noGroups')),
    ),
  );
  const v = store.currentViolations();
  if (v.length) bar.appendChild(h('span', { class: 'pill bad', title: v.join('\n') }, t('app.ruleViolation')));
  if (s.previewBusy) bar.appendChild(h('span', { class: 'spinner', title: t('app.rendering') }));
  const vw = viewer;
  bar.appendChild(
    h(
      'div',
      { class: 'view-tools' },
      h('button', { class: 'btn ghost small', title: t('app.rotateLeft'), onclick: () => vw.rotate(-90) }, '⟲'),
      h('button', { class: 'btn ghost small', title: t('app.rotateRight'), onclick: () => vw.rotate(90) }, '⟳'),
      (zoomBtn = h('button', { class: 'btn ghost small zoom', title: t('app.resetView'), onclick: () => vw.reset() }, '')),
    ),
  );
  stageFoot!.textContent = t('app.previewHint', { w: p.width, h: p.height });
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
  for (const def of tabDefs()) {
    const badge =
      def.id === 'rules'
        ? s.project.rules.length
        : def.id === 'constraints'
          ? s.project.constraints.length
          : def.id === 'combos'
            ? (s.result?.combos.length ?? 0)
            : null;
    tabs.appendChild(
      h(
        'button',
        { class: 'tab' + (s.tab === def.id ? ' active' : ''), onclick: () => store.setTab(def.id) },
        def.label,
        h('span', { class: 'tab-badge', 'data-tab': def.id, style: badge ? '' : 'display:none' }, String(badge ?? '')),
      ),
    );
  }
  tabs.appendChild(
    h(
      'button',
      { class: 'sheet-size', title: t('app.panelHeight'), onclick: () => ((s.sheetTall = !s.sheetTall), store.notify(true)) },
      s.sheetTall ? t('app.collapsePanel') : t('app.expandPanel'),
    ),
  );
  tabs.appendChild(h('button', { class: 'sheet-close', onclick: () => ((s.sheetOpen = false), store.notify(true)) }, t('app.collapse')));
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
  const next = tabDefs().findIndex((t) => t.id === s.tab) + 1;
  if (next < tabDefs().length && tabDefs()[next].id !== 'settings') {
    panel.appendChild(
      h('button', { class: 'btn next-step', onclick: () => store.setTab(tabDefs()[next].id) }, t('app.nextStep', { step: tabDefs()[next].short })),
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
  const top = h('button', { class: 'to-top', title: t('app.backTop'), onclick: () => panel.scrollTo({ top: 0, behavior: 'smooth' }) }, '↑');
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
        { class: 'btn small' + (s.nodeEditorOpen ? ' on' : ''), title: t('app.nodeTitleShort'), onclick: () => store.setNodeEditor(!s.nodeEditorOpen) },
        t('app.node'),
      ),
    );
    quickExportHost.appendChild(
      h(
        'button',
        { class: 'btn small primary', disabled: !n || s.exporting, title: t('app.nodeExportTitle'), onclick: () => void startExport() },
        t('app.oneClickExport', { n }),
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
    for (const def of tabDefs()) {
      tabbarHost.appendChild(
        h(
          'button',
          {
            class: s.tab === def.id && s.sheetOpen ? 'active' : '',
            onclick: () => {
              if (s.tab === def.id && s.sheetOpen) s.sheetOpen = false;
              else store.setTab(def.id);
              store.notify();
            },
          },
          def.short,
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
  modal.appendChild(h('h2', null, store.state.exporting ? t('export.exporting') : t('app.working')));
  modal.appendChild(h('div', { class: 'busy-label' }, label));
  modal.appendChild(h('div', { class: 'progress' }, h('i', { style: `width:${Math.round(progress * 100)}%` })));
  modal.appendChild(h('div', { class: 'hint', style: 'text-align:right' }, `${Math.round(progress * 100)}%`));
  if (store.state.cancellable) {
    modal.appendChild(h('button', { class: 'btn', style: 'width:100%', onclick: () => cancelExport() }, t('app.cancelExport')));
  }
  return h('div', { class: 'overlay' }, modal);
}

export function installGlobalDrop(): void {
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f && PSD_EXT.test(f.name)) await importFile(f);
    else if (f) store.toast(t('app.dropFileError'), 'bad');
  });
}
