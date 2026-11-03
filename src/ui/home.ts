/**
 * Home screen: app icon and title on the left, recent files on the right.
 * Shown whenever no document is open.
 */

import { h } from './dom';
import * as store from './store';
import { clearRecent, relativeTime, removeRecent, MAX_LIMIT, MIN_LIMIT, type RecentEntry } from './recent';
import { pickFile } from './importPanel';
import { t } from '../i18n';

export function renderHome(): HTMLElement {
  const s = store.state;
  const list = s.recent.slice(0, recentLimit());

  const root = h('div', { class: 'home' });
  const inner = h('div', { class: 'home-inner' });

  // Left column: identity and the primary action.
  const brand = h('div', { class: 'home-brand' });
  brand.appendChild(h('img', { class: 'home-logo', src: 'icon.png', alt: '', draggable: 'false' }));
  brand.appendChild(h('h1', { class: 'home-title' }, t('app.name')));
  brand.appendChild(
    h('p', { class: 'home-sub' }, t('app.tagline')),
  );

  const actions = h('div', { class: 'home-actions' });
  actions.appendChild(
    h('button', { class: 'btn primary home-open', onclick: () => pickFile() }, t('app.open')),
  );
  actions.appendChild(
    h(
      'button',
      {
        class: 'btn ghost small',
        onclick: () => {
          store.state.helpOpen = true;
          store.notify();
        },
      },
      t('app.help'),
    ),
  );
  brand.appendChild(actions);
  brand.appendChild(
    h(
      'div',
      { class: 'home-drop hint' },
      s.platform === 'android' ? t('app.supported') : t('app.supportedDrop'),
    ),
  );
  inner.appendChild(brand);

  const side = h('div', { class: 'home-recent' });
  const head = h('div', { class: 'home-recent-head' });
  head.appendChild(h('span', { class: 'home-recent-title' }, t('home.recent')));
  head.appendChild(
    h(
      'span',
      { class: 'pill', title: '在设置里可以修改显示数量' },
      `${list.length} / ${recentLimit()}`,
    ),
  );
  side.appendChild(head);

  if (list.length === 0) {
    side.appendChild(
      h('div', { class: 'home-empty hint' }, t('home.empty')),
    );
  } else {
    const scroller = h('div', { class: 'home-list' });
    for (const entry of list) {
      scroller.appendChild(renderEntry(entry));
    }
    side.appendChild(scroller);
  }

  const foot = h('div', { class: 'home-recent-foot' });
  if (s.recent.length > 0) {
    foot.appendChild(
      h(
        'button',
        {
          class: 'btn ghost small',
          onclick: () => {
            if (!confirm(t('home.clearConfirm'))) return;
            store.state.recent = clearRecent();
            store.notify();
          },
        },
        t('home.clear'),
      ),
    );
  }
  foot.appendChild(
    h(
      'button',
      {
        class: 'btn ghost small',
        onclick: () => {
          store.state.tab = 'settings';
          store.state.helpOpen = false;
          store.setTab('settings');
        },
      },
      t('home.more'),
    ),
  );
  side.appendChild(foot);

  inner.appendChild(side);
  root.appendChild(inner);
  return root;
}

function recentLimit(): number {
  const n = store.state.prefs.recentCount;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Number.isFinite(n) ? n : 10));
}

function renderEntry(entry: RecentEntry): HTMLElement {
  const row = h('div', {
    class: 'recent-item',
    title: t('home.reopen', { name: entry.name }),
    onclick: () => {
      // Browsers cannot reopen a local file on their own, so ask for it again;
      // the saved option groups are matched by file name and restored.
      store.toast(t('home.reopenToast', { name: entry.name }), 'info');
      pickFile();
    },
  });

  const thumb = h('div', { class: 'recent-thumb' });
  if (entry.thumb) {
    thumb.appendChild(h('img', { src: entry.thumb, alt: '', draggable: 'false' }));
  } else {
    thumb.appendChild(h('span', { class: 'recent-thumb-mark' }, ext(entry.name)));
  }
  row.appendChild(thumb);

  const meta = h('div', { class: 'recent-meta' });
  meta.appendChild(h('div', { class: 'recent-name', title: entry.name }, entry.name));
  meta.appendChild(
    h(
      'div',
      { class: 'recent-detail hint' },
      t('home.detail', { w: entry.width, h: entry.height, layers: entry.layerCount, rules: entry.ruleCount }),
    ),
  );
  meta.appendChild(h('div', { class: 'recent-when hint' }, relativeTime(entry.openedAt)));
  row.appendChild(meta);

  row.appendChild(
    h(
      'button',
      {
        class: 'recent-remove',
        title: t('home.remove'),
        onclick: (e: Event) => {
          e.stopPropagation();
          store.state.recent = removeRecent(entry.key);
          store.notify();
        },
      },
      '×',
    ),
  );

  return row;
}

function ext(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toUpperCase() : 'PSD';
}
