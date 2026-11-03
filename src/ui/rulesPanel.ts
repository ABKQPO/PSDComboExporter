/**
 * Step 2 — option groups. Each group decides how its options combine:
 * Required / optional / multi-select / fixed groups; intra-group exclusivity
 */

import type { Rule, RuleKind } from '../core/model';
import { choiceCount, MULTI_LIMIT } from '../core/rules';
import * as store from './store';
import { h } from './dom';

export const KIND_INFO: Record<RuleKind, { label: string; hint: string; example: string }> = {
  exclusive: {
    label: '必选一项',
    hint: '组内互斥：每张图必须且只能出现其中一个选项。',
    example: '角色 A / B / C',
  },
  optional: {
    label: '可选一项',
    hint: '组内互斥，但也可以一个都不选（相当于多一个「无」）。',
    example: '帽子 / 眼镜 / 无',
  },
  multi: {
    label: '可多选',
    hint: '选项之间不互斥，每个选项单独开/关，所有子集都会参与组合。',
    example: '装饰 A、B 可同时出现',
  },
  fixed: {
    label: '固定显示',
    hint: '所有选项始终显示，不参与组合（即使它们在 PSD 里是隐藏的）。',
    example: '背景、Logo',
  },
};

/** "Settings of this file were restored" notice with a one-click fresh start. */
export function renderRestoreNotice(): HTMLElement | null {
  const s = store.state;
  const info = s.restoredInfo;
  if (!info) return null;
  return h(
    'div',
    { class: 'notice info restore' },
    h('div', null, h('b', null, '已恢复上次对这个文件的设置'), `：${info.rules} 个选项组、${info.constraints} 条规则，以及显示改动和导出设置。`),
    h(
      'div',
      { class: 'row wrap', style: 'gap:6px;margin-top:6px' },
      h('button', { class: 'btn small', onclick: () => store.startFresh(false) }, '不要，重新开始'),
      h('button', { class: 'btn small ghost', onclick: () => store.dismissRestored() }, '保留'),
      h(
        'label',
        { class: 'row', style: 'gap:4px;font-size:12px' },
        h('input', { type: 'checkbox', checked: !s.autoRestore, onchange: (e: Event) => store.setAutoRestore(!(e.target as HTMLInputElement).checked) }),
        '以后导入时不自动恢复',
      ),
    ),
  );
}

export function renderRulesPanel(): HTMLElement {
  const s = store.state;
  const p = s.project!;
  const root = h('div', { class: 'col' });
  const restoreNotice = renderRestoreNotice();
  if (restoreNotice) root.appendChild(restoreNotice);

  root.appendChild(
    h(
      'div',
      { class: 'guide' },
      h('b', null, '第 2 步：设置每个选项组的规则。'),
      ' 点击选项可以在预览区实时查看；勾选「参与组合」的组会做笛卡尔积（角色 × 服装 × 表情），不参与的组在所有导出图里固定使用当前选中的选项。',
    ),
  );

  // product summary: 3 × 2 × 4 = 24
  const live = p.rules.filter((r) => r.enabled && r.kind !== 'fixed' && r.options.length);
  const factors = live.map((r) => `${r.name}${store.ruleFactor(r).n}`);
  const res = s.result;
  const head = h('div', { class: 'row wrap', style: 'gap:6px;margin-bottom:8px' });
  head.appendChild(
    h(
      'span',
      { class: 'pill' },
      factors.length ? `组合数 ${factors.join(' × ')} = ${res?.rawCount ?? 0}` : '还没有参与组合的选项组',
    ),
  );
  if (res) head.appendChild(h('span', { class: res.combos.length ? 'pill ok' : 'pill bad' }, `有效 ${res.combos.length}`));
  head.appendChild(h('span', { class: 'spacer' }));
  head.appendChild(h('button', { class: 'btn small', onclick: () => store.setNodeEditor(true), title: '像 Blender 节点一样连线：选项组 → 组合 × → 导出，拖线设置互斥' }, '节点视图'));
  head.appendChild(h('button', { class: 'btn small', onclick: () => store.resetSelection(), title: '每组回到默认选项' }, '重置选择'));
  head.appendChild(h('button', { class: 'btn small', onclick: () => store.addEmptyRule() }, '+ 空选项组'));
  if (p.rules.length) head.appendChild(h('button', { class: 'btn small danger', onclick: () => store.clearRules(), title: '删除全部选项组（和引用它们的规则）' }, '清空全部'));
  root.appendChild(head);

  const v = store.currentViolations();
  if (v.length) {
    root.appendChild(
      h('div', { class: 'notice bad' }, `当前预览的组合违反规则：${v[0]}。它不会被导出。`),
    );
  }

  if (p.rules.length === 0) {
    root.appendChild(
      h(
        'div',
        { class: 'empty' },
        h('div', { class: 'big' }, '还没有选项组'),
        h('div', { class: 'hint' }, '到「图层」页勾选图层，或在图层组上点「⇢ 子项作选项」。图层名里带 [标签] 的 PSD 会自动生成选项组。'),
        h('button', { class: 'btn primary', onclick: () => store.setTab('layers') }, '去选择图层'),
      ),
    );
  }

  p.rules.forEach((rule, i) => root.appendChild(renderRule(rule, i, p.rules.length)));

  if (p.layers.some((l) => l.tags.length)) {
    root.appendChild(
      h(
        'div',
        { class: 'row', style: 'margin-top:8px' },
        h(
          'button',
          {
            class: 'btn ghost small',
            onclick: () => {
              if (confirm('按图层名中的 [标签] 重新生成选项组？当前的选项组和互斥规则会被替换。')) store.rebuildFromTags();
            },
          },
          '按 [标签] 重新生成',
        ),
      ),
    );
  }
  return root;
}

function renderRule(rule: Rule, i: number, total: number): HTMLElement {
  const s = store.state;
  const selected = s.selection[rule.id] ?? [];
  const card = h('div', { class: 'rule' + (rule.enabled || rule.kind === 'fixed' ? '' : ' frozen') });

  const head = h('div', { class: 'rule-head' });
  head.appendChild(
    h(
      'div',
      { class: 'updown' },
      h('button', { class: 'btn ghost tiny', disabled: i === 0, title: '上移（影响文件名顺序）', onclick: () => store.moveRule(rule.id, -1) }, '▲'),
      h('button', { class: 'btn ghost tiny', disabled: i === total - 1, title: '下移', onclick: () => store.moveRule(rule.id, 1) }, '▼'),
    ),
  );
  head.appendChild(
    h('input', {
      class: 'rule-title',
      value: rule.name,
      title: '点击重命名（会出现在导出文件名里）',
      onchange: (e: Event) => store.renameRule(rule.id, (e.target as HTMLInputElement).value),
    }),
  );
  head.appendChild(
    h(
      'button',
      {
        class: 'btn ghost small danger',
        title: '删除这个选项组（图层本身不受影响）',
        onclick: () => {
          if (confirm(`删除选项组「${rule.name}」？相关的互斥规则也会一起删除。`)) store.deleteRule(rule.id);
        },
      },
      '删除',
    ),
  );
  card.appendChild(head);

  const seg = h('div', { class: 'seg' });
  for (const k of Object.keys(KIND_INFO) as RuleKind[]) {
    seg.appendChild(
      h(
        'button',
        { class: rule.kind === k ? 'on' : '', title: `${KIND_INFO[k].hint}（例：${KIND_INFO[k].example}）`, onclick: () => store.setRuleKind(rule.id, k) },
        KIND_INFO[k].label,
      ),
    );
  }
  card.appendChild(seg);
  card.appendChild(h('div', { class: 'hint rule-hint' }, `${KIND_INFO[rule.kind].hint} 例：${KIND_INFO[rule.kind].example}`));
  if (rule.kind !== 'fixed') {
    const f = store.ruleFactor(rule);
    card.appendChild(h('div', { class: 'hint' + (f.n > 16 ? ' warn-text' : '') }, `组合数 ×${f.n}：${f.why}${rule.enabled ? '' : '（不参与组合，不乘）'}`));
  }
  const warn = store.ruleWarning(rule);
  if (warn) {
    const box = h('div', { class: 'notice warn col', style: 'gap:6px' }, h('div', null, warn.text));
    for (const fx of warn.fixes) box.appendChild(h('button', { class: 'btn small', style: 'align-self:flex-start;white-space:normal;text-align:left', onclick: fx.run }, fx.label));
    card.appendChild(box);
  }

  if (rule.kind !== 'fixed') {
    const n = choiceCount({ ...rule, enabled: true });
    card.appendChild(
      h(
        'label',
        { class: 'switch-row' },
        h('input', {
          type: 'checkbox',
          checked: rule.enabled,
          onchange: (e: Event) => store.setRuleEnabled(rule.id, (e.target as HTMLInputElement).checked),
        }),
        rule.enabled
          ? h('span', null, `参与组合（笛卡尔积）：提供 ${n} 种取值`)
          : h('span', null, '不参与组合：所有导出图固定使用下面选中的选项'),
      ),
    );
  }
  if (rule.kind === 'multi' && rule.options.length > MULTI_LIMIT) {
    card.appendChild(h('div', { class: 'notice warn' }, `可多选最多枚举前 ${MULTI_LIMIT} 个选项（${2 ** MULTI_LIMIT} 种子集），其余选项不参与组合。`));
  }

  const opts = h('div', { class: 'rule-options' });
  for (const opt of rule.options) {
    const on = rule.kind === 'fixed' || selected.includes(opt.id);
    const conflict = !on && rule.kind !== 'fixed' ? store.optionConflict(rule.id, opt.id) : null;
    const empty = opt.layerIds.length === 0;
    const chip = h(
      'div',
      {
        class: 'opt' + (on ? ' on' : '') + (conflict ? ' blocked' : '') + (empty ? ' empty' : '') + (rule.kind === 'fixed' ? ' locked' : ''),
        title: empty ? '这个选项还没有关联图层，点 ✎ 选择图层' : conflict ? `选它会冲突：${conflict}` : `${opt.layerIds.length} 个图层`,
        onclick: () => {
          if (rule.kind !== 'fixed') store.clickOption(rule.id, opt.id);
        },
      },
      h('span', { class: 'dot' + (rule.kind === 'multi' ? ' sq' : '') }),
      h('span', { class: 'opt-name' }, opt.name),
      opt.layerIds.length > 1 ? h('span', { class: 'count' }, `${opt.layerIds.length}层`) : null,
      empty ? h('span', { class: 'count warn' }, '无图层') : null,
      h(
        'button',
        {
          class: 'opt-act',
          title: '重命名 / 选择图层',
          onclick: (e: Event) => {
            e.stopPropagation();
            s.editingOption = { ruleId: rule.id, optionId: opt.id };
            store.notify();
          },
        },
        '✎',
      ),
      h(
        'button',
        {
          class: 'opt-act',
          title: '删除选项',
          onclick: (e: Event) => {
            e.stopPropagation();
            store.deleteOption(rule.id, opt.id);
          },
        },
        '×',
      ),
    );
    opts.appendChild(chip);
  }
  if (rule.kind === 'optional') {
    opts.appendChild(
      h(
        'div',
        {
          class: 'opt none' + (selected.length === 0 ? ' on' : ''),
          title: '一个都不选',
          onclick: () => {
            if (selected.length) store.clickOption(rule.id, selected[0]);
          },
        },
        h('span', { class: 'dot' }),
        h('span', { class: 'opt-name' }, '无'),
      ),
    );
  }
  opts.appendChild(h('button', { class: 'btn ghost small', onclick: () => store.addOption(rule.id) }, '+ 选项'));
  card.appendChild(opts);
  return card;
}
