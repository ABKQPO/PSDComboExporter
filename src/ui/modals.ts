/** Dialogs: option editor (pick the layers of one option) and the help sheet. */

import type { LayerNode } from '../core/model';
import { rootsTopFirst } from '../core/project';
import * as store from './store';
import { h } from './dom';
import { KIND_INFO } from './rulesPanel';
import { t } from '../i18n';

function close(): void {
  store.state.editingOption = null;
  store.state.helpOpen = false;
  store.notify();
}

function shell(title: string, body: HTMLElement, footer?: HTMLElement): HTMLElement {
  const modal = h('div', { class: 'modal wide', onclick: (e: Event) => e.stopPropagation() });
  modal.appendChild(
    h('div', { class: 'modal-head' }, h('h2', null, title), h('span', { class: 'spacer' }), h('button', { class: 'btn ghost small', onclick: close }, t('common.close'))),
  );
  modal.appendChild(h('div', { class: 'modal-body' }, body));
  if (footer) modal.appendChild(footer);
  return h('div', { class: 'overlay', onclick: close }, modal);
}

export function renderOptionEditor(): HTMLElement | null {
  const s = store.state;
  const ed = s.editingOption;
  const p = s.project;
  if (!ed || !p) return null;
  const rule = p.rules.find((r) => r.id === ed.ruleId);
  const opt = rule?.options.find((o) => o.id === ed.optionId);
  if (!rule || !opt) return null;

  const body = h('div', { class: 'col' });
  body.appendChild(
    h(
      'div',
      { class: 'field' },
      h('label', null, t('modal.optionName')),
      h('input', {
        value: opt.name,
        onchange: (e: Event) => store.renameOption(rule.id, opt.id, (e.target as HTMLInputElement).value),
      }),
    ),
  );
  body.appendChild(
    h('div', { class: 'hint' }, t('modal.optionHint', { count: opt.layerIds.length })),
  );
  const tree = h('div', { class: 'tree picker' });
  const walk = (list: LayerNode[], depth: number) => {
    for (const l of list) {
      const on = opt.layerIds.includes(l.id);
      const thumb = s.thumbs.get(l.id);
      tree.appendChild(
        h(
          'label',
          { class: 'tree-row' + (on ? ' checked' : ''), style: `padding-left:${4 + depth * 14}px` },
          h('input', { type: 'checkbox', class: 'chk', checked: on, onchange: () => store.toggleLayerInOption(rule.id, opt.id, l.id) }),
          l.kind === 'group' ? h('span', { class: 'thumb folder' }, '📁') : thumb ? h('img', { class: 'thumb', src: thumb }) : h('span', { class: 'thumb empty' }),
          h('span', { class: 'name' }, l.cleanName),
          h('span', { class: 'badges' }, ...store.optionsOfLayer(l.id).map((t) => h('span', { class: 'optchip' }, t))),
        ),
      );
      if (l.kind === 'group') walk([...l.children].reverse(), depth + 1);
    }
  };
  walk(rootsTopFirst(p), 0);
  body.appendChild(tree);
  return shell(t('modal.editOption', { rule: rule.name, option: opt.name }), body, h('div', { class: 'modal-foot' }, h('button', { class: 'btn primary', onclick: close }, t('common.done'))));
}

export function renderHelp(): HTMLElement | null {
  if (!store.state.helpOpen) return null;
  const body = h('div', { class: 'help' });
  body.innerHTML = t('modal.helpHtml', {
    fixedLabel: KIND_INFO.fixed.label,
    fixedExample: KIND_INFO.fixed.example,
    exclusiveLabel: KIND_INFO.exclusive.label,
    exclusiveExample: KIND_INFO.exclusive.example,
    optionalLabel: KIND_INFO.optional.label,
    optionalExample: KIND_INFO.optional.example,
  });
  return shell(t('app.help'), body);
}
