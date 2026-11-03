/** Step 4 — every combination that will be exported, as a thumbnail grid. */

import * as store from './store';
import { h } from './dom';
import { exportNames } from '../core/exporter';
import { sanitizeFileName } from '../core/rules';
import { buildManifestCsv } from '../core/manifest';
import { saveTextFile } from '../core/platform';
import { t } from '../i18n';

let shown = 60;
let observer: IntersectionObserver | null = null;

export function resetCombosPaging(): void {
  shown = 60;
}

export function renderCombosPanel(): HTMLElement {
  const s = store.state;
  const p = s.project!;
  const res = s.result!;
  const root = h('div', { class: 'col' });

  root.appendChild(
    h(
      'div',
      { class: 'guide' },
      h('b', null, t('combos.step')),
      ` ${t('combos.guide')}`,
    ),
  );

  const dup = res.rejected.filter((r) => r.kind === 'duplicate').length;
  const empty = res.rejected.filter((r) => r.kind === 'empty').length;
  const byRule = res.rejected.length - dup - empty;
  const funnel = h('div', { class: 'funnel' });
  funnel.appendChild(h('div', null, h('b', null, String(res.rawCount)), h('span', null, t('combos.raw'))));
  if (byRule) funnel.appendChild(h('div', { class: 'neg' }, h('b', null, `−${byRule}`), h('span', null, t('combos.excluded'))));
  if (dup) funnel.appendChild(h('div', { class: 'neg' }, h('b', null, `−${dup}`), h('span', null, t('combos.duplicates'))));
  if (empty) funnel.appendChild(h('div', { class: 'neg' }, h('b', null, `−${empty}`), h('span', null, t('combos.empty'))));
  funnel.appendChild(h('div', { class: 'res' }, h('b', null, String(res.combos.length)), h('span', null, t('combos.willExport'))));
  root.appendChild(funnel);

  if (res.truncated) {
    root.appendChild(h('div', { class: 'notice warn' }, t('combos.tooMany', { n: res.combos.length })));
  }
  if (res.combos.length === 0) {
    root.appendChild(h('div', { class: 'notice bad' }, t('combos.none')));
  }

  // export selection: tick boxes on every card, plus select all / none / invert
  const picked = store.selectedCombos().length;
  const exportCombos = store.selectedCombos();
  root.appendChild(
    h(
      'div',
      { class: 'row wrap select-bar' },
      h('span', { class: picked ? 'pill ok' : 'pill bad' }, t('combos.selected', { picked, total: res.combos.length })),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => store.selectAllCombos('all') }, t('combos.selectAll')),
      h('button', { class: 'btn small', onclick: () => store.selectAllCombos('none') }, t('combos.selectNone')),
      h('button', { class: 'btn small', onclick: () => store.selectAllCombos('invert') }, t('combos.invert')),
      h('button', {
        class: 'btn small',
        disabled: exportCombos.length === 0,
        title: t('combos.manifestTitle'),
        onclick: () => void saveManifest(p.name, exportCombos),
      }, t('combos.manifest')),
    ),
  );
  root.appendChild(h('div', { class: 'hint' }, t('combos.hint')));

  const names = exportNames(p, res.combos);
  observer?.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const i = Number((e.target as HTMLElement).dataset.index);
        const combo = res.combos[i];
        if (combo) store.requestComboThumb(combo);
      }
    },
    { rootMargin: '200px' },
  );
  store.clearThumbQueue();

  const grid = h('div', { class: 'grid' });
  const n = Math.min(shown, res.combos.length);
  for (let i = 0; i < n; i++) {
    const combo = res.combos[i];
    const url = s.comboThumbs.get(combo.signature);
    const on = !s.excludedCombos.has(combo.signature);
    const cell = h(
      'div',
      { class: 'cell' + (s.focusCombo === i ? ' focus' : '') + (on ? '' : ' off'), dataset: { index: String(i), sig: combo.signature }, title: names[i], onclick: () => store.showCombo(i) },
      h('input', {
        type: 'checkbox',
        class: 'pick',
        checked: on,
        title: t('combos.exportOne'),
        onclick: (e: Event) => e.stopPropagation(),
        onchange: () => store.toggleComboExport(combo.signature),
      }),
      url ? h('img', { src: url, alt: '' }) : h('div', { class: 'ph' }, '…'),
      h('div', { class: 'cap' }, h('span', { class: 'num' }, String(i + 1)), combo.labels.join(' · ') || t('combos.default')),
    );
    grid.appendChild(cell);
    queueMicrotask(() => observer?.observe(cell));
  }
  root.appendChild(grid);
  if (res.combos.length > n) {
    root.appendChild(
      h(
        'button',
        { class: 'btn', style: 'width:100%;margin-top:8px', onclick: () => ((shown += 120), store.notify()) },
        t('combos.showMore', { n: Math.min(120, res.combos.length - n), total: res.combos.length }),
      ),
    );
  }

  if (res.rejected.length) {
    const det = h('details', { class: 'rejected' });
    det.appendChild(h('summary', null, t('combos.rejected', { n: res.rejected.length })));
    const list = h('div', { class: 'list' });
    for (const r of res.rejected.slice(0, 300)) {
      list.appendChild(
        h('div', { class: 'list-item' }, h('span', { class: 'mono' }, r.labels.join(' · ') || t('combos.default')), h('span', { class: 'why' }, r.reason)),
      );
    }
    if (res.rejected.length > 300) list.appendChild(h('div', { class: 'hint' }, t('combos.moreRejected', { n: res.rejected.length - 300 })));
    det.appendChild(list);
    root.appendChild(det);
  }
  return root;
}

async function saveManifest(projectName: string, combos: ReturnType<typeof store.selectedCombos>): Promise<void> {
  try {
    const filenames = exportNames(store.state.project!, combos);
    const csv = buildManifestCsv(
      [t('combos.manifestIndex'), t('combos.manifestFilename'), t('combos.manifestOptions')],
      combos.map((combo, index) => [String(index + 1), filenames[index], combo.labels.join(' | ') || t('combos.default')]),
    );
    const name = t('combos.manifestFile', { name: sanitizeFileName(projectName) });
    const where = await saveTextFile(name, csv, 'text/csv;charset=utf-8');
    if (where !== null) store.toast(t('combos.manifestSaved', { where }), 'ok');
  } catch (err) {
    store.toast(t('combos.manifestFailed', { msg: (err as Error).message }), 'bad');
  }
}
