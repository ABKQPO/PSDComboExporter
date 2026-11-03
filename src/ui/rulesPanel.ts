/**
 * Step 2 — option groups. Each group decides how its options combine:
 * Required / optional / multi-select / fixed groups; intra-group exclusivity
 */

import type { Rule, RuleKind } from '../core/model';
import { choiceCount, MULTI_LIMIT } from '../core/rules';
import * as store from './store';
import { t } from '../i18n';
import { h } from './dom';

export const KIND_INFO = new Proxy({} as Record<RuleKind, { label: string; hint: string; example: string }>, {
  get: (_target, kind: RuleKind) => ({
    label: t(`rules.${kind === 'exclusive' ? 'required' : kind}`),
    hint: t(`rules.${kind === 'exclusive' ? 'required' : kind}Hint`),
    example: t(`rules.${kind === 'exclusive' ? 'required' : kind}Example`),
  }),
});

/** "Settings of this file were restored" notice with a one-click fresh start. */
export function renderRestoreNotice(): HTMLElement | null {
  const s = store.state;
  const info = s.restoredInfo;
  if (!info) return null;
  return h(
    'div',
    { class: 'notice info restore' },
    h('div', null, h('b', null, t('rules.restored')), t('rules.restoredDetail', { rules: info.rules, constraints: info.constraints })),
    h(
      'div',
      { class: 'row wrap', style: 'gap:6px;margin-top:6px' },
      h('button', { class: 'btn small', onclick: () => store.startFresh(false) }, t('rules.restoreNo')),
      h('button', { class: 'btn small ghost', onclick: () => store.dismissRestored() }, t('rules.restoreKeep')),
      h(
        'label',
        { class: 'row', style: 'gap:4px;font-size:12px' },
        h('input', { type: 'checkbox', checked: !s.autoRestore, onchange: (e: Event) => store.setAutoRestore(!(e.target as HTMLInputElement).checked) }),
        t('rules.restoreNever'),
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
      h('b', null, t('rules.step3')),
      t('rules.step3Detail'),
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
      factors.length ? t('rules.factors', { expr: factors.join(' × '), n: res?.rawCount ?? 0 }) : t('rules.noFactors'),
    ),
  );
  if (res) head.appendChild(h('span', { class: res.combos.length ? 'pill ok' : 'pill bad' }, t('rules.valid', { n: res.combos.length })));
  head.appendChild(h('span', { class: 'spacer' }));
  head.appendChild(h('button', { class: 'btn small', onclick: () => store.setNodeEditor(true), title: t('rules.nodeHint') }, t('rules.nodeView')));
  head.appendChild(h('button', { class: 'btn small', onclick: () => store.resetSelection(), title: t('rules.resetSelection') }, t('rules.reset')));
  head.appendChild(h('button', { class: 'btn small', onclick: () => store.addEmptyRule() }, t('rules.addEmpty')));
  if (p.rules.length) head.appendChild(h('button', { class: 'btn small danger', onclick: () => store.clearRules(), title: t('rules.clearAll') }, t('rules.clear')));
  root.appendChild(head);

  const v = store.currentViolations();
  if (v.length) {
    root.appendChild(
      h('div', { class: 'notice bad' }, t('rules.violation', { why: v[0] })),
    );
  }

  if (p.rules.length === 0) {
    root.appendChild(
      h(
        'div',
        { class: 'empty' },
        h('div', { class: 'big' }, t('rules.empty')),
        h('div', { class: 'hint' }, t('rules.emptyHint')),
        h('button', { class: 'btn primary', onclick: () => store.setTab('layers') }, t('rules.goLayers')),
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
              if (confirm(t('rules.rebuildConfirm'))) store.rebuildFromTags();
            },
          },
          t('rules.rebuild'),
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
      h('button', { class: 'btn ghost tiny', disabled: i === 0, title: t('rules.moveUp'), onclick: () => store.moveRule(rule.id, -1) }, '▲'),
      h('button', { class: 'btn ghost tiny', disabled: i === total - 1, title: t('rules.moveDown'), onclick: () => store.moveRule(rule.id, 1) }, '▼'),
    ),
  );
  head.appendChild(
    h('input', {
      class: 'rule-title',
      value: rule.name,
      title: t('rules.rename'),
      onchange: (e: Event) => store.renameRule(rule.id, (e.target as HTMLInputElement).value),
    }),
  );
  head.appendChild(
    h(
      'button',
      {
        class: 'btn ghost small danger',
        title: t('rules.deleteGroup'),
        onclick: () => {
          if (confirm(t('rules.deleteConfirm', { name: rule.name }))) store.deleteRule(rule.id);
        },
      },
      t('rules.delete'),
    ),
  );
  card.appendChild(head);

  const seg = h('div', { class: 'seg' });
  for (const k of Object.keys(KIND_INFO) as RuleKind[]) {
    seg.appendChild(
      h(
        'button',
        { class: rule.kind === k ? 'on' : '', title: t('rules.kindHint', { hint: KIND_INFO[k].hint, example: KIND_INFO[k].example }), onclick: () => store.setRuleKind(rule.id, k) },
        KIND_INFO[k].label,
      ),
    );
  }
  card.appendChild(seg);
  card.appendChild(h('div', { class: 'hint rule-hint' }, t('rules.kindHint', { hint: KIND_INFO[rule.kind].hint, example: KIND_INFO[rule.kind].example })));
  if (rule.kind !== 'fixed') {
    const f = store.ruleFactor(rule);
    card.appendChild(h('div', { class: 'hint' + (f.n > 16 ? ' warn-text' : '') }, t('rules.comboCount', { n: f.n, why: f.why, note: rule.enabled ? '' : t('rules.notInProduct') })));
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
          ? h('span', null, t('rules.inProduct', { n }))
          : h('span', null, t('rules.outProduct')),
      ),
    );
  }
  if (rule.kind === 'multi' && rule.options.length > MULTI_LIMIT) {
    card.appendChild(h('div', { class: 'notice warn' }, t('rules.multiLimit', { n: MULTI_LIMIT, subsets: 2 ** MULTI_LIMIT })));
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
        title: empty ? '这个选项还没有关联图层，点 ✎ 选择图层' : conflict ? t('rules.optionConflict', { why: conflict }) : t('rules.layers', { n: opt.layerIds.length }),
        onclick: () => {
          if (rule.kind !== 'fixed') store.clickOption(rule.id, opt.id);
        },
      },
      h('span', { class: 'dot' + (rule.kind === 'multi' ? ' sq' : '') }),
      h('span', { class: 'opt-name' }, opt.name),
      opt.layerIds.length > 1 ? h('span', { class: 'count' }, t('rules.layersShort', { n: opt.layerIds.length })) : null,
      empty ? h('span', { class: 'count warn' }, t('rules.noLayers')) : null,
      h(
        'button',
        {
          class: 'opt-act',
          title: t('rules.editOption'),
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
          title: t('rules.deleteOption'),
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
          title: t('rules.selectNone'),
          onclick: () => {
            if (selected.length) store.clickOption(rule.id, selected[0]);
          },
        },
        h('span', { class: 'dot' }),
        h('span', { class: 'opt-name' }, '无'),
      ),
    );
  }
  opts.appendChild(h('button', { class: 'btn ghost small', onclick: () => store.addOption(rule.id) }, t('rules.addOption')));
  card.appendChild(opts);
  return card;
}
