/**
 * Step 3: cross-group rules (mutual exclusion and requirements).
 * Intra-group exclusivity is a property of the option group itself; see rulesPanel.
 */

import type { Constraint, LayerNode, Target } from '../core/model';
import { rootsTopFirst } from '../core/project';
import * as store from './store';
import { h } from './dom';

interface Preset {
  key: NonNullable<Constraint['preset']>;
  label: string;
  kind: Constraint['kind'];
  target: Target['kind'];
  hint: string;
}

const PRESETS: Preset[] = [
  {
    key: 'crossGroupMutex',
    label: '跨组互斥',
    kind: 'mutex',
    target: 'rule',
    hint: '两个选项组不能同时有选中项。例：「中文字幕」组与「英文字幕」组只能出现一个。',
  },
  {
    key: 'multiMutex',
    label: '多项互斥',
    kind: 'mutex',
    target: 'option',
    hint: 'A、B、C…最多只出现一个，可以无限追加，不用拆成多个组。例：三种尾巴分散在不同组里，但只能出现一种。',
  },
  {
    key: 'conditionalExclude',
    label: '条件排除',
    kind: 'mutex',
    target: 'option',
    hint: '某个选项不能搭配另一个选项。例：角色 A 不允许搭配服装 C。',
  },
  {
    key: 'absoluteExclude',
    label: '完全排除',
    kind: 'mutex',
    target: 'layer',
    hint: '指定两个图层永远不能同时显示，不管它们是怎么被打开的。',
  },
  {
    key: 'requires',
    label: '依赖',
    kind: 'require',
    target: 'option',
    hint: '选了 A 就必须同时有 B，否则这个组合不导出。例：选了「睫毛」必须有「眼线」。',
  },
];

const presetOf = (c: Constraint) =>
  PRESETS.find((p) => p.key === c.preset) ?? PRESETS.find((p) => p.kind === c.kind && p.target === c.a.kind) ?? PRESETS[0];

export function renderConstraintsPanel(): HTMLElement {
  const s = store.state;
  const p = s.project!;
  const root = h('div', { class: 'col' });

  root.appendChild(
    h(
      'div',
      { class: 'guide' },
      h('b', null, '第 3 步（可选）：设置跨组规则。'),
      h(
        'div',
        { class: 'two-kinds' },
        h('div', null, h('b', null, '组内互斥'), '：同一个选项组里只能选一个——由选项组的「必选一项 / 可选一项」决定，不用在这里设置。'),
        h('div', null, h('b', null, '跨组互斥'), '：不同选项组之间的冲突，在这里添加。违反规则的组合不会被导出，会在「组合」页列出原因。'),
      ),
    ),
  );

  const add = h('div', { class: 'preset-grid' });
  for (const pr of PRESETS) {
    add.appendChild(
      h(
        'button',
        { class: 'preset', onclick: () => store.addConstraint(pr.kind, pr.target, pr.key) },
        h('b', null, `+ ${pr.label}`),
        h('span', null, pr.hint),
      ),
    );
  }
  root.appendChild(add);

  if (p.rules.length === 0) {
    root.appendChild(h('div', { class: 'notice info' }, '先在「选项组」页创建选项组，才能设置跨组规则。'));
  }

  if (p.constraints.length) {
    root.appendChild(h('div', { class: 'section-title' }, `已设置 ${p.constraints.length} 条规则`));
    for (const c of p.constraints) root.appendChild(renderConstraint(c));
  }
  return root;
}

function targetValue(t: Target): string {
  return `${t.kind}:${(t.kind === 'rule' ? t.ruleId : t.kind === 'option' ? t.optionId : t.layerId) ?? ''}`;
}

function parseTarget(v: string): Target {
  const [kind, id] = v.split(':') as [Target['kind'], string];
  if (kind === 'rule') return { kind, ruleId: id || undefined };
  if (kind === 'option') return { kind, optionId: id || undefined };
  return { kind: 'layer', layerId: id || undefined };
}

function layerOptions(list: LayerNode[], depth: number, out: HTMLElement[], cur: string): void {
  for (const l of list) {
    const v = `layer:${l.id}`;
    out.push(h('option', { value: v, selected: v === cur }, `${'  '.repeat(depth)}${l.kind === 'group' ? '📁 ' : ''}${l.cleanName}`));
    if (l.kind === 'group') layerOptions([...l.children].reverse(), depth + 1, out, cur);
  }
}

const targetsOf = (c: Constraint): Target[] => [c.a, c.b, ...(c.more ?? [])];
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const letter = (i: number) => (i < 26 ? LETTERS[i] : `#${i + 1}`);

function targetPicker(c: Constraint, i: number): HTMLElement {
  const p = store.state.project!;
  const t = targetsOf(c)[i];
  const cur = targetValue(t);
  const box = h('div', { class: 'target' });

  box.appendChild(
    h(
      'select',
      {
        class: 'gran',
        title: '粒度',
        onchange: (e: Event) => store.setConstraintTarget(c.id, i, { kind: (e.target as HTMLSelectElement).value as Target['kind'] }),
      },
      h('option', { value: 'rule', selected: t.kind === 'rule' }, '整组'),
      h('option', { value: 'option', selected: t.kind === 'option' }, '选项'),
      h('option', { value: 'layer', selected: t.kind === 'layer' }, '图层'),
    ),
  );

  const opts: HTMLElement[] = [h('option', { value: `${t.kind}:` }, '— 请选择 —')];
  if (t.kind === 'rule') {
    for (const r of p.rules) opts.push(h('option', { value: `rule:${r.id}`, selected: cur === `rule:${r.id}` }, r.name));
  } else if (t.kind === 'option') {
    for (const r of p.rules) {
      const g = h('optgroup', { label: r.name });
      for (const o of r.options) g.appendChild(h('option', { value: `option:${o.id}`, selected: cur === `option:${o.id}` }, o.name));
      opts.push(g);
    }
  } else {
    layerOptions(rootsTopFirst(p), 0, opts, cur);
  }
  box.appendChild(
    h(
      'select',
      {
        class: 'tgt',
        onchange: (e: Event) => store.setConstraintTarget(c.id, i, parseTarget((e.target as HTMLSelectElement).value)),
      },
      ...opts,
    ),
  );
  return box;
}

function renderConstraint(c: Constraint): HTMLElement {
  const s = store.state;
  const pr = presetOf(c);
  const removed = s.result?.perConstraint[c.id] ?? 0;
  const all = targetsOf(c);
  const multi = c.kind === 'mutex' && all.length > 2;
  const unset = all.filter((t) => !targetValue(t).split(':')[1]).length;
  const incomplete = multi ? all.length - unset < 2 : unset > 0;
  const card = h('div', { class: 'con' + (c.enabled ? '' : ' off') });

  card.appendChild(
    h(
      'div',
      { class: 'row', style: 'gap:6px' },
      h('input', {
        type: 'checkbox',
        checked: c.enabled,
        title: '启用 / 停用',
        onchange: (e: Event) => store.updateConstraint(c.id, { enabled: (e.target as HTMLInputElement).checked }),
      }),
      h('b', null, multi ? '多项互斥' : pr.label),
      h(
        'select',
        {
          class: 'small-select',
          onchange: (e: Event) => store.updateConstraint(c.id, { kind: (e.target as HTMLSelectElement).value as Constraint['kind'] }),
        },
        h('option', { value: 'mutex', selected: c.kind === 'mutex' }, multi ? '最多出现一个' : '不能同时出现'),
        h('option', { value: 'require', selected: c.kind === 'require' }, 'A 需要 B'),
      ),
      h('span', { class: 'spacer' }),
      incomplete
        ? h('span', { class: 'pill warn' }, '未设置完整')
        : h('span', { class: removed ? 'pill warn' : 'pill' }, removed ? `排除了 ${removed} 个组合` : '暂未排除任何组合'),
      h('button', { class: 'btn ghost small danger', title: '删除规则', onclick: () => store.deleteConstraint(c.id) }, '删除'),
    ),
  );
  if (c.kind === 'mutex') {
    const body = h('div', { class: 'con-body multi' });
    all.forEach((_t, i) => {
      body.appendChild(
        h(
          'div',
          { class: 'con-item' },
          h('span', { class: 'side' }, letter(i)),
          targetPicker(c, i),
          all.length > 2
            ? h('button', { class: 'btn ghost small danger', title: '移除这一项', onclick: () => store.removeConstraintTarget(c.id, i) }, '✕')
            : null,
        ),
      );
    });
    body.appendChild(
      h(
        'div',
        { class: 'row', style: 'gap:6px' },
        h('button', { class: 'btn small', title: '再加一项，它们之间最多出现一个', onclick: () => store.addConstraintTarget(c.id) }, '+ 再加一项'),
        h('span', { class: 'hint' }, all.length > 2 ? `这 ${all.length} 项中最多只能出现一个（未选的项会被忽略）` : 'A 与 B 不能同时出现；点「再加一项」变成多项互斥'),
      ),
    );
    card.appendChild(body);
  } else {
    card.appendChild(
      h(
        'div',
        { class: 'con-body' },
        h('span', { class: 'side' }, 'A'),
        targetPicker(c, 0),
        h('span', { class: 'rel' }, '→ 必须有'),
        h('span', { class: 'side' }, 'B'),
        targetPicker(c, 1),
      ),
    );
    if (c.more?.length) card.appendChild(h('div', { class: 'hint' }, '「A 需要 B」只使用前两项，其余项被忽略。'));
  }
  if (s.result && !incomplete && c.enabled && removed >= s.result.rawCount) {
    card.appendChild(
      h('div', { class: 'notice bad' }, '这条规则排除了全部组合。如果 A、B 都是「必选一项」的整组，它们总会同时出现——改成选项粒度，或把其中一组改为「可选一项」。'),
    );
  }
  return card;
}
