/** Settings: preferences that are not part of one file's combination setup. */

import * as store from './store';
import { h } from './dom';
import { engine } from '../engine/client';
import { LOCALES, setLocale, systemLocale, t, type Locale } from '../i18n';

type NameMode = 'names' | 'n' | 'index' | 'custom';

const NAME_TEMPLATES: Record<Exclude<NameMode, 'custom'>, string> = {
  names: '{psd}-{combo}',
  n: '{n}',
  index: '{index}',
};

function nameMode(template: string): NameMode {
  for (const [k, v] of Object.entries(NAME_TEMPLATES)) if (template === v) return k as NameMode;
  return 'custom';
}

export function renderSettingsPanel(): HTMLElement {
  const s = store.state;
  const p = s.project;
  const pr = s.prefs;
  const root = h('div', { class: 'col settings' });
  root.appendChild(h('div', { class: 'guide' }, t('settings.guide')));

  // ---------------------------------------------------------------- export
  const ex = section(root, t('settings.export'));
  if (p) {
    ex.appendChild(
      row(
      t('settings.exportMode'),
        h(
          'select',
          {
            onchange: (e: Event) => {
              p.settings.exportMode = (e.target as HTMLSelectElement).value as typeof p.settings.exportMode;
              store.refresh({ keepFocus: true });
            },
          },
          h('option', { value: 'zip', selected: p.settings.exportMode === 'zip' }, t('settings.zip')),
          h('option', { value: 'folder', selected: p.settings.exportMode === 'folder' }, t('settings.folder')),
        ),
      ),
    );
    ex.appendChild(h('div', { class: 'hint' }, t('settings.zipHint')));
    const mode = nameMode(p.settings.template);
    ex.appendChild(
      row(
        t('settings.fileName'),
        h(
          'select',
          {
            onchange: (e: Event) => {
              const v = (e.target as HTMLSelectElement).value as NameMode;
              if (v !== 'custom') p.settings.template = NAME_TEMPLATES[v];
              else store.setTab('export');
              store.refresh({ keepFocus: true });
            },
          },
          h('option', { value: 'names', selected: mode === 'names' }, t('settings.names')),
          h('option', { value: 'n', selected: mode === 'n' }, t('settings.number')),
          h('option', { value: 'index', selected: mode === 'index' }, t('settings.index')),
          h('option', { value: 'custom', selected: mode === 'custom' }, mode === 'custom' ? `${t('settings.custom')}: ${p.settings.template}` : t('settings.custom')),
        ),
      ),
    );
    ex.appendChild(h('div', { class: 'hint' }, t('settings.orderHint')));
  }
  ex.appendChild(
    check(t('settings.progressNames'), t('settings.progressNamesHint'), pr.progressNames, (v) => store.setPref('progressNames', v)),
  );
  ex.appendChild(check(t('settings.confirmBig'), t('settings.confirmBigHint'), pr.confirmBig, (v) => store.setPref('confirmBig', v)));
  ex.appendChild(
    check(t('settings.notifyDone'), '', pr.notifyDone, (v) => store.setPref('notifyDone', v)),
  );

  // ---------------------------------------------------------------- speed
  const sp = section(root, t('settings.speed'));
  const encAuto = store.autoEncoders();
  sp.appendChild(
    row(
      t('settings.encoders'),
      h(
        'select',
        {
          onchange: (e: Event) => {
            store.setPref('encoders', Number((e.target as HTMLSelectElement).value));
            engine.setEncoders(store.encoderCount());
          },
        },
        h('option', { value: '0', selected: pr.encoders === 0 }, t('settings.autoN', { n: encAuto })),
        ...[1, 2, 3, 4, 5, 6].map((n) => h('option', { value: String(n), selected: pr.encoders === n }, t('settings.threadN', { n }))),
      ),
    ),
  );
  sp.appendChild(
    h(
      'div',
      { class: 'hint' },
      t('settings.encoderHint', { workers: engine.workerCount || 1, encoders: engine.encoderCount }) +
        (s.platform === 'android' ? ` ${t('settings.androidMemory')}` : ''),
    ),
  );
  if (s.platform !== 'android') {
    const wAuto = store.autoWorkers();
    sp.appendChild(
      row(
      t('settings.workers'),
        h(
          'select',
          { onchange: (e: Event) => store.setPref('workers', Number((e.target as HTMLSelectElement).value)) },
          h('option', { value: '0', selected: pr.workers === 0 }, t('settings.autoN', { n: wAuto })),
          ...[1, 2, 3, 4, 6, 8].map((n) => h('option', { value: String(n), selected: pr.workers === n }, t('settings.threadN', { n }))),
        ),
      ),
    );
    sp.appendChild(h('div', { class: 'hint' }, t('settings.workerHint')));
  }
  sp.appendChild(
    check(t('settings.quickPreview'), t('settings.quickPreviewHint'), pr.quickPreview, (v) => store.setPref('quickPreview', v)),
  );

  // ---------------------------------------------------------------- interface
  const ui = section(root, t('settings.interface'));
  ui.appendChild(
    check(t('settings.showGuides'), '', !s.guidesHidden, (v) => {
      s.guidesHidden = !v;
      try {
        localStorage.setItem('psd-export:guides-hidden', v ? '0' : '1');
      } catch {
        /* ignore */
      }
      store.notify();
    }),
  );
  ui.appendChild(check(t('settings.autoRestore'), '', s.autoRestore, (v) => store.setAutoRestore(v)));
  ui.appendChild(check(t('settings.miniPreview'), '', pr.miniPreview, (v) => store.setPref('miniPreview', v)));
  ui.appendChild(check(t('settings.nodeDefault'), '', pr.nodeDefault, (v) => store.setPref('nodeDefault', v)));
  const langRow = h('div', { class: 'field' });
  langRow.appendChild(h('label', null, t('settings.language')));
  langRow.appendChild(
    h(
      'select',
      {
        onchange: (e: Event) => applyLocaleChoice((e.target as HTMLSelectElement).value),
      },
      h('option', { value: 'auto', selected: pr.locale === 'auto' }, t('settings.languageAuto')),
      ...LOCALES.map((l) => h('option', { value: l.id, selected: pr.locale === l.id }, l.label)),
    ),
  );
  ui.appendChild(langRow);
  const recentRow = h('div', { class: 'field' });
  recentRow.appendChild(h('label', null, t('settings.recentCount')));
  recentRow.appendChild(
    h('input', {
      type: 'range',
      min: '3',
      max: '50',
      step: '1',
      value: String(pr.recentCount),
      oninput: (e: Event) => {
        const n = Number((e.target as HTMLInputElement).value);
        store.setPref('recentCount', n);
        (e.target as HTMLInputElement).nextElementSibling!.textContent = String(n);
      },
    }),
  );
  recentRow.appendChild(h('span', { class: 'pill', style: 'flex:none;min-width:34px;text-align:center' }, String(pr.recentCount)));
  ui.appendChild(recentRow);

  // ---------------------------------------------------------------- data
  const da = section(root, t('settings.data'));
  da.appendChild(
    h(
      'div',
      { class: 'row wrap', style: 'gap:8px' },
      h(
        'button',
        {
          class: 'btn small',
          onclick: () => {
            const n = store.savedFileCount();
            if (!n) return store.toast(t('settings.noSaved'), 'info');
            if (confirm(t('settings.deleteSaved', { n }))) store.clearSavedFiles();
          },
        },
        t('settings.clearSaved', { n: store.savedFileCount() }),
      ),
      h(
        'button',
        {
          class: 'btn small ghost',
          onclick: () => {
            store.resetPrefs();
            engine.setEncoders(store.encoderCount());
          },
        },
        t('settings.reset'),
      ),
    ),
  );
  return root;
}

function applyLocaleChoice(value: string): void {
  store.setPref('locale', value as 'auto' | 'zh-CN' | 'en');
  setLocale(value === 'auto' ? systemLocale() : (value as Locale));
  store.notify();
}

function section(root: HTMLElement, title: string): HTMLElement {
  const c = h('div', { class: 'card col', style: 'gap:8px' });
  c.appendChild(h('div', { class: 'section-title', style: 'margin:0' }, title));
  root.appendChild(c);
  return c;
}

function row(label: string, control: HTMLElement): HTMLElement {
  return h('div', { class: 'field' }, h('label', null, label), control);
}

function check(label: string, hint: string, on: boolean, set: (v: boolean) => void): HTMLElement {
  return h(
    'label',
    { class: 'check-row' },
    h('input', { type: 'checkbox', checked: on, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) }),
    h('span', null, h('b', null, label), hint ? h('span', { class: 'hint' }, ' ' + hint) : null),
  );
}
