/**
 * Home screen: app icon and title on the left, recent files on the right.
 * Shown whenever no document is open.
 */

import { h } from './dom';
import * as store from './store';
import { clearRecent, relativeTime, removeRecent, MAX_LIMIT, MIN_LIMIT, type RecentEntry } from './recent';
import { pickFile } from './importPanel';

export function renderHome(): HTMLElement {
  const s = store.state;
  const list = s.recent.slice(0, recentLimit());

  const root = h('div', { class: 'home' });
  const inner = h('div', { class: 'home-inner' });

  // Left column: identity and the primary action.
  const brand = h('div', { class: 'home-brand' });
  brand.appendChild(h('img', { class: 'home-logo', src: 'icon.png', alt: '', draggable: 'false' }));
  brand.appendChild(h('h1', { class: 'home-title' }, 'PSD组合导出'));
  brand.appendChild(
    h('p', { class: 'home-sub' }, '按选项组组合图层，批量导出全部变体。'),
  );

  const actions = h('div', { class: 'home-actions' });
  actions.appendChild(
    h('button', { class: 'btn primary home-open', onclick: () => pickFile() }, '打开文件'),
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
      '使用说明',
    ),
  );
  brand.appendChild(actions);
  brand.appendChild(
    h(
      'div',
      { class: 'home-drop hint' },
      s.platform === 'android'
        ? '支持 .psd / .psb / .ipv'
        : '支持 .psd / .psb / .ipv，也可以把文件拖进窗口',
    ),
  );
  inner.appendChild(brand);

  const side = h('div', { class: 'home-recent' });
  const head = h('div', { class: 'home-recent-head' });
  head.appendChild(h('span', { class: 'home-recent-title' }, '最近打开'));
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
      h('div', { class: 'home-empty hint' }, '还没有打开过文件。打开一个 PSD 后，它会出现在这里。'),
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
            if (!confirm('清空最近打开的记录？（不影响已保存的选项组设置）')) return;
            store.state.recent = clearRecent();
            store.notify();
          },
        },
        '清空记录',
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
      '设置显示数量',
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
    title: `重新选择 ${entry.name} 打开`,
    onclick: () => {
      // Browsers cannot reopen a local file on their own, so ask for it again;
      // the saved option groups are matched by file name and restored.
      store.toast(`请选择 ${entry.name}，已保存的选项组会自动恢复`, 'info');
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
      `${entry.width}×${entry.height} · ${entry.layerCount} 个图层 · ${entry.ruleCount} 个选项组`,
    ),
  );
  meta.appendChild(h('div', { class: 'recent-when hint' }, relativeTime(entry.openedAt)));
  row.appendChild(meta);

  row.appendChild(
    h(
      'button',
      {
        class: 'recent-remove',
        title: '从列表移除',
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
