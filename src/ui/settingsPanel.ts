/** Settings: preferences that are not part of one file's combination setup. */

import * as store from './store';
import { h } from './dom';
import { engine } from '../engine/client';

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
  root.appendChild(h('div', { class: 'guide' }, h('b', null, '设置。'), ' 这里的选项对所有文件生效（标了「当前文件」的除外），会自动保存。'));

  // ---------------------------------------------------------------- export
  const ex = section(root, '导出');
  if (p) {
    ex.appendChild(
      row(
        '导出方式（当前文件）',
        h(
          'select',
          {
            onchange: (e: Event) => {
              p.settings.exportMode = (e.target as HTMLSelectElement).value as typeof p.settings.exportMode;
              store.refresh({ keepFocus: true });
            },
          },
          h('option', { value: 'zip', selected: p.settings.exportMode === 'zip' }, 'ZIP 压缩导出'),
          h('option', { value: 'folder', selected: p.settings.exportMode === 'folder' }, '直接选择文件夹导出'),
        ),
      ),
    );
    ex.appendChild(h('div', { class: 'hint' }, 'ZIP 适合发送和归档；文件夹模式会把每张图片直接写入你选择的文件夹。'));
    const mode = nameMode(p.settings.template);
    ex.appendChild(
      row(
        '文件名（当前文件）',
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
          h('option', { value: 'names', selected: mode === 'names' }, '文件名 + 选项名（默认）'),
          h('option', { value: 'n', selected: mode === 'n' }, '只用序号：1、2、3…'),
          h('option', { value: 'index', selected: mode === 'index' }, '只用序号：001、002、003…'),
          h('option', { value: 'custom', selected: mode === 'custom' }, mode === 'custom' ? `自定义：${p.settings.template}` : '自定义…（在「导出」页填写）'),
        ),
      ),
    );
    ex.appendChild(h('div', { class: 'hint' }, '只用序号时，序号就是导出顺序（「组合」页从上到下）。'));
  }
  ex.appendChild(
    check('导出时进度里显示文件名', '关掉后只显示「第几张 / 共几张」', pr.progressNames, (v) => store.setPref('progressNames', v)),
  );
  ex.appendChild(check('超过 300 张时先确认', '避免误点导出几千张', pr.confirmBig, (v) => store.setPref('confirmBig', v)));
  ex.appendChild(
    check('导出完成时提醒', s.platform === 'android' ? '震动一下并发出提示音' : '发出提示音', pr.notifyDone, (v) => store.setPref('notifyDone', v)),
  );

  // ---------------------------------------------------------------- speed
  const sp = section(root, '速度');
  const encAuto = store.autoEncoders();
  sp.appendChild(
    row(
      '压缩线程',
      h(
        'select',
        {
          onchange: (e: Event) => {
            store.setPref('encoders', Number((e.target as HTMLSelectElement).value));
            engine.setEncoders(store.encoderCount());
          },
        },
        h('option', { value: '0', selected: pr.encoders === 0 }, `自动（${encAuto} 个）`),
        ...[1, 2, 3, 4, 5, 6].map((n) => h('option', { value: String(n), selected: pr.encoders === n }, `${n} 个`)),
      ),
    ),
  );
  sp.appendChild(
    h(
      'div',
      { class: 'hint' },
      `PNG 压缩比合成慢一倍左右，多开压缩线程能让合成线程不用等。现在：${engine.workerCount || 1} 个合成 + ${engine.encoderCount} 个压缩线程。` +
        (s.platform === 'android' ? '手机内存有限，压缩线程太多可能导出失败，失败时改小。' : ''),
    ),
  );
  if (s.platform !== 'android') {
    const wAuto = store.autoWorkers();
    sp.appendChild(
      row(
        '合成线程',
        h(
          'select',
          { onchange: (e: Event) => store.setPref('workers', Number((e.target as HTMLSelectElement).value)) },
          h('option', { value: '0', selected: pr.workers === 0 }, `自动（${wAuto} 个）`),
          ...[1, 2, 3, 4, 6, 8].map((n) => h('option', { value: String(n), selected: pr.workers === n }, `${n} 个`)),
        ),
      ),
    );
    sp.appendChild(h('div', { class: 'hint' }, '每个合成线程都存一份图层，占内存；下次打开文件时生效。'));
  }
  sp.appendChild(
    check('预览先显示低清图', '点得很快时先出一张小图，再换成清晰的', pr.quickPreview, (v) => store.setPref('quickPreview', v)),
  );

  // ---------------------------------------------------------------- interface
  const ui = section(root, '界面');
  ui.appendChild(
    check('显示各页顶部的蓝色说明', '', !s.guidesHidden, (v) => {
      s.guidesHidden = !v;
      try {
        localStorage.setItem('psd-export:guides-hidden', v ? '0' : '1');
      } catch {
        /* ignore */
      }
      store.notify();
    }),
  );
  ui.appendChild(check('再次导入同一个文件时自动恢复设置', '', s.autoRestore, (v) => store.setAutoRestore(v)));
  ui.appendChild(check('节点视图显示左下角小预览', '', pr.miniPreview, (v) => store.setPref('miniPreview', v)));
  const recentRow = h('div', { class: 'field' });
  recentRow.appendChild(h('label', null, '主界面显示历史文件数量'));
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
  const da = section(root, '数据');
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
            if (!n) return store.toast('没有保存的文件设置', 'info');
            if (confirm(`删除 ${n} 个文件保存的选项组 / 规则设置？当前打开的文件不受影响，下次导入时从头开始。`)) store.clearSavedFiles();
          },
        },
        `清除保存的文件设置（${store.savedFileCount()} 个）`,
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
        '这一页恢复默认',
      ),
    ),
  );
  return root;
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
