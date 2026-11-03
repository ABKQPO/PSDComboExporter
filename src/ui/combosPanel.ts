/** Step 4 — every combination that will be exported, as a thumbnail grid. */

import * as store from './store';
import { h } from './dom';
import { exportNames } from '../core/exporter';

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
      h('b', null, '第 4 步：检查组合。'),
      ' 下面是将要导出的全部图片（缩略图为近似预览）。点击任意一张会在预览区显示大图，并把选项组切换到这个组合。',
    ),
  );

  const dup = res.rejected.filter((r) => r.kind === 'duplicate').length;
  const empty = res.rejected.filter((r) => r.kind === 'empty').length;
  const byRule = res.rejected.length - dup - empty;
  const funnel = h('div', { class: 'funnel' });
  funnel.appendChild(h('div', null, h('b', null, String(res.rawCount)), h('span', null, '原始组合')));
  if (byRule) funnel.appendChild(h('div', { class: 'neg' }, h('b', null, `−${byRule}`), h('span', null, '规则排除')));
  if (dup) funnel.appendChild(h('div', { class: 'neg' }, h('b', null, `−${dup}`), h('span', null, '画面重复')));
  if (empty) funnel.appendChild(h('div', { class: 'neg' }, h('b', null, `−${empty}`), h('span', null, '空白画面')));
  funnel.appendChild(h('div', { class: 'res' }, h('b', null, String(res.combos.length)), h('span', null, '将导出')));
  root.appendChild(funnel);

  if (res.truncated) {
    root.appendChild(h('div', { class: 'notice warn' }, `组合太多，只列出了前 ${res.combos.length} 个。请减少参与组合的选项组，或用互斥规则缩小范围。`));
  }
  if (res.combos.length === 0) {
    root.appendChild(h('div', { class: 'notice bad' }, '没有可导出的组合。请检查选项组和跨组规则。'));
  }

  // export selection: tick boxes on every card, plus select all / none / invert
  const picked = store.selectedCombos().length;
  root.appendChild(
    h(
      'div',
      { class: 'row wrap select-bar' },
      h('span', { class: picked ? 'pill ok' : 'pill bad' }, `已选 ${picked} / ${res.combos.length} 张导出`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => store.selectAllCombos('all') }, '全选'),
      h('button', { class: 'btn small', onclick: () => store.selectAllCombos('none') }, '全不选'),
      h('button', { class: 'btn small', onclick: () => store.selectAllCombos('invert') }, '反选'),
    ),
  );
  root.appendChild(h('div', { class: 'hint' }, '取消勾选的组合不会被导出；点图片本身是预览。'));

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
        title: '导出这一张',
        onclick: (e: Event) => e.stopPropagation(),
        onchange: () => store.toggleComboExport(combo.signature),
      }),
      url ? h('img', { src: url, alt: '' }) : h('div', { class: 'ph' }, '…'),
      h('div', { class: 'cap' }, h('span', { class: 'num' }, String(i + 1)), combo.labels.join(' · ') || '默认'),
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
        `再显示 ${Math.min(120, res.combos.length - n)} 个（共 ${res.combos.length} 个）`,
      ),
    );
  }

  if (res.rejected.length) {
    const det = h('details', { class: 'rejected' });
    det.appendChild(h('summary', null, `查看被排除的 ${res.rejected.length} 个组合及原因`));
    const list = h('div', { class: 'list' });
    for (const r of res.rejected.slice(0, 300)) {
      list.appendChild(
        h('div', { class: 'list-item' }, h('span', { class: 'mono' }, r.labels.join(' · ') || '默认'), h('span', { class: 'why' }, r.reason)),
      );
    }
    if (res.rejected.length > 300) list.appendChild(h('div', { class: 'hint' }, `…还有 ${res.rejected.length - 300} 个`));
    det.appendChild(list);
    root.appendChild(det);
  }
  return root;
}
