/** Step 5 — export every combination into one ZIP. */

import * as store from './store';
import { exportConfigText, importConfigText } from './configIO';
import { h, fmtBytes } from './dom';
import { t } from '../i18n';
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
  store.setBusy(t('export.cancelPending'), store.state.busyProgress);
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
      h('b', null, t('export.step5')),
      st.exportMode === 'zip' ? t('export.step5Zip') : t('export.step5Folder'),
    ),
  );

  const card = h('div', { class: 'card' });
  card.appendChild(
    field(
      t('export.format'),
      h(
        'select',
        {
          onchange: (e: Event) => {
            st.format = (e.target as HTMLSelectElement).value as typeof st.format;
            store.refresh({ keepFocus: true });
          },
        },
        h('option', { value: 'png', selected: st.format === 'png' }, t('export.png')),
        h('option', { value: 'jpeg', selected: st.format === 'jpeg' }, t('export.jpeg')),
        h('option', { value: 'webp', selected: st.format === 'webp' }, t('export.webp')),
      ),
    ),
  );
  if (st.format !== 'png') {
    const val = h('span', { class: 'pill' }, String(st.quality));
    card.appendChild(
      field(
        t('export.quality'),
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
    card.appendChild(h('div', { class: 'notice warn' }, t('export.lossyHint')));
  }
  card.appendChild(
    field(
      t('export.size'),
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
            v === 1 ? t('export.originalSize', { w: p.width, h: p.height }) : `${v * 100}%：${Math.round(p.width * v)}×${Math.round(p.height * v)}`,
          ),
        ),
      ),
    ),
  );
  card.appendChild(
    field(
      t('export.fileName'),
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
      t('export.tokens'),
    ),
  );
  card.appendChild(
    field(
      st.exportMode === 'zip' ? t('export.inZip') : t('export.inFolder'),
      h(
        'select',
        {
          onchange: (e: Event) => {
            st.layout = (e.target as HTMLSelectElement).value as typeof st.layout;
            store.refresh({ keepFocus: true });
          },
        },
        h('option', { value: 'flat', selected: st.layout === 'flat' }, t('export.allTogether')),
        h('option', { value: 'primary', selected: st.layout === 'primary' }, t('export.byPrimaryFolder', { name: p.rules.find((r) => r.enabled && r.kind !== 'fixed')?.name ?? '—' })),
      ),
    ),
  );
  root.appendChild(card);

  // what to export
  const ticked = res.combos.filter((c) => !s.excludedCombos.has(c.signature)).length;
  const allN = s.exportScope === 'all' || res.rejected.length > 0 ? store.allPossibleResult()?.combos.length ?? 0 : res.combos.length;
  const scope = h('div', { class: 'card col', style: 'gap:6px' });
  scope.appendChild(h('div', { class: 'section-title', style: 'margin:0' }, t('export.scope')));
  const scopes: [typeof s.exportScope, string, string][] = [
    ['selected', t('export.scopeTicked', { n: ticked }), t('export.scopeTickedHint')],
    ['valid', t('export.scopeValid', { n: res.combos.length }), t('export.scopeValidHint')],
    ['all', t('export.scopeAll', { n: allN }), t('export.scopeAllHint')],
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
      h('span', { class: chosen.length ? 'pill ok' : 'pill bad' }, t('export.images', { n: chosen.length })),
      h('span', { class: 'pill' }, st.format.toUpperCase()),
      h('span', { class: 'pill' }, `${Math.round(p.width * st.scale)}×${Math.round(p.height * st.scale)}`),
      h(
        'span',
        { class: 'pill', title: t('export.threads') },
        t('export.threadsDetail', { workers: Math.max(1, engine.workerCount), encoders: engine.encoderCount }),
      ),
    ),
  );
  const preview = h('div', { class: 'names mono' });
  for (const n of names.slice(0, 5)) preview.appendChild(h('div', null, n));
  if (names.length > 5) preview.appendChild(h('div', { class: 'hint' }, t('export.moreFiles', { n: names.length })));
  sum.appendChild(preview);
  sum.appendChild(
    h(
      'div',
      { class: 'hint' },
      st.exportMode === 'folder'
        ? s.platform === 'android'
          ? t('export.folderAndroid')
          : s.platform === 'electron'
          ? t('export.folderDesktop')
          : t('export.folderWeb')
        : s.platform === 'android'
        ? t('export.zipAndroid')
        : s.platform === 'electron'
        ? t('export.hintDesktop')
        : t('export.hintWeb'),
    ),
  );
  if (s.exportScope === 'selected' && chosen.length !== res.combos.length) {
    sum.appendChild(h('div', { class: 'hint' }, t('export.tickHint')));
  }
  if (s.exportScope === 'all' && res.rejected.length > 0) {
    sum.appendChild(h('div', { class: 'notice warn' }, t('export.violationNote', { n: chosen.length - res.combos.length })));
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
      s.exporting ? t('export.exporting') : t('export.startButton', { n: chosen.length, mode: st.exportMode === 'zip' ? t('export.toZip') : t('export.toFolder') }),
    ),
  );

  // configuration files
  const cfg = h('div', { class: 'card col', style: 'gap:6px' });
  cfg.appendChild(h('div', { class: 'section-title', style: 'margin:0' }, t('export.config')));
  cfg.appendChild(
    h(
      'div',
      { class: 'hint' },
      t('export.configHint'),
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
              const where = await saveTextFile(t('export.configFileName', { name: p.name.replace(/\.[^.]+$/, '') }), exportConfigText());
              if (where !== null) store.toast(where ? t('export.configSaved', { where }) : t('export.configSavedShort'), 'ok');
            } catch (err) {
              store.toast(t('export.configSaveFailed', { msg: (err as Error).message }), 'bad');
            }
          },
        },
        t('export.exportConfig'),
      ),
      h(
        'button',
        {
          class: 'btn small',
          onclick: async () => {
            try {
              const file = await openTextFile('.json');
              if (file) importConfigText(file.text);
            } catch (err) {
              store.toast(t('export.configImportFailed', { msg: (err as Error).message }), 'bad');
            }
          },
        },
        t('export.importConfig'),
      ),
    ),
  );
  cfg.appendChild(
    h(
      'div',
      { class: 'row wrap', style: 'gap:6px;align-items:center;margin-top:4px' },
      h('button', { class: 'btn small danger', title: t('export.resetAll'), onclick: () => store.startFresh(true) }, t('export.reset')),
      h(
        'label',
        { class: 'row', style: 'gap:4px;font-size:12px' },
        h('input', { type: 'checkbox', checked: s.autoRestore, onchange: (e: Event) => store.setAutoRestore((e.target as HTMLInputElement).checked) }),
        t('export.autoRestore'),
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
        h('div', null, h('b', null, t('export.doneTitle')), r.summary),
        h('div', { class: 'hint' }, t('export.doneDetail', { n: r.entries, size: fmtBytes(r.archiveBytes), time: fmtDuration(r.elapsedMs / 1000), avg: (r.elapsedMs / 1000 / Math.max(1, r.entries)).toFixed(2) })),
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
  if (s.prefs.confirmBig && combos.length > 300 && !confirm(t('export.confirmBig', { n: combos.length }))) return;

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
    const what = s.prefs.progressNames ? `: ${prog.current}` : '';
    store.setBusy(
      t('export.progressLine', { current: Math.min(prog.total, prog.done + 1), total: prog.total, what, elapsed: fmtDuration(elapsed) }) +
        (prog.done > 0 ? t('export.progressRemaining', { eta: fmtDuration(eta), bytes: fmtBytes(prog.bytes) }) : ''),
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
    store.toast(result.cancelled ? result.summary : t('export.doneToast', { time: fmtDuration(result.elapsedMs / 1000) }), result.cancelled ? 'info' : 'ok');
    if (!result.cancelled && s.prefs.notifyDone && result.elapsedMs > 5000) remind();
  } catch (err) {
    const msg = (err as Error).message;
    store.toast(/取消/.test(msg) ? msg : t('export.failed', { msg }), /取消/.test(msg) ? 'info' : 'bad');
  } finally {
    clearInterval(ticker);
    s.exporting = false;
    store.setBusy(null);
  }
}
