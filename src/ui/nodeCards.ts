import * as store from './store';
import { h } from './dom';
import { KIND_INFO } from './rulesPanel';
import { ports } from './nodePorts';
import type { Constraint, NodeBundle, NodeNote, Project, Rule, RuleKind, Target } from '../core/model';
import { startExport } from './exportPanel';
import { t as tr } from '../i18n';

export function node(cls: string, id: string, target: string): HTMLElement {
  return h('div', { class: `ne-node ${cls}`, 'data-node': id, 'data-target': target });
}

export function port(key: string, side: 'in' | 'out', extra = ''): HTMLElement {
  const el = h('span', { class: `ne-port ${side} ${extra}`, 'data-port': key });
  ports.set(key, el);
  return el;
}

function titleBlock(category: string, title: HTMLElement | string): HTMLElement {
  const name = typeof title === 'string' ? h('span', null, title) : title;
  name.classList.add('ne-name');
  return h('span', { class: 'ne-title-block' }, h('span', { class: 'ne-eyebrow' }, category), name);
}

export function groupNode(r: Rule): HTMLElement {
  const s = store.state;
  const sel = s.selection[r.id] ?? [];
  const f = store.ruleFactor(r);
  const el = node('group' + (r.enabled && r.kind !== 'fixed' ? ' live' : ''), r.id, `rule:${r.id}`);
  const bundled = new Set((s.project!.nodeBundles ?? []).filter((b) => b.ruleId === r.id).map((b) => b.optionId));
  const head = h('div', { class: 'ne-head' });
  head.appendChild(port(`gin:${r.id}`, 'in', 'gin'));
  head.appendChild(h('span', { class: 'ne-grip', title: tr('node.drag') }, '⠿'));
  head.appendChild(
    titleBlock(
      tr('node.optionGroup'),
      h('span', { 'data-rename': r.id, title: tr('node.renameTitle') }, r.name),
    ),
  );
  head.appendChild(
    h(
      'select',
      { class: 'ne-kind', title: KIND_INFO[r.kind].hint, onchange: (e: Event) => store.setRuleKind(r.id, (e.target as HTMLSelectElement).value as RuleKind) },
      ...(['exclusive', 'optional', 'multi', 'fixed'] as RuleKind[]).map((k) => h('option', { value: k, selected: k === r.kind }, KIND_INFO[k].label)),
    ),
  );
  head.appendChild(
    h('button', { class: 'ne-x', title: tr('rules.deleteGroup'), onclick: () => confirm(tr('rules.deleteConfirm', { name: r.name })) && store.deleteRule(r.id) }, '✕'),
  );
  if (r.kind !== 'fixed') head.appendChild(port(`rule:${r.id}`, 'out', r.enabled ? 'on' : ''));
  el.appendChild(head);
  if (r.kind !== 'fixed') el.appendChild(h('div', { class: 'ne-sub' + (f.n > 16 ? ' warn' : '') }, `×${f.n}：${f.why}`));

  const warn = store.ruleWarning(r);
  if (warn) {
    const box = h('div', { class: 'ne-warn' }, warn.text);
    for (const fx of warn.fixes) box.appendChild(h('button', { class: 'btn small', onclick: fx.run }, fx.label));
    el.appendChild(box);
  }

  if (r.kind === 'optional') {
    el.appendChild(
      h(
        'div',
        { class: 'ne-row' + (sel.length ? '' : ' on'), onclick: () => sel.length && store.clickOption(r.id, sel[0]) },
        h('span', { class: 'ne-thumb none' }, '∅'),
        h('span', { class: 'ne-label' }, tr('rules.none')),
      ),
    );
  }
  for (const o of r.options) {
    const first = o.layerIds.length ? s.project!.layerIndex[o.layerIds[0]] : undefined;
    const thumb = first?.kind === 'layer' ? s.thumbs.get(first.id) : undefined;
    el.appendChild(
      h(
        'div',
        {
          class: 'ne-row' + (sel.includes(o.id) ? ' on' : ''),
          'data-target': `opt:${o.id}`,
          title: tr('node.optionPreview', { name: o.name, suffix: o.layerIds.length > 1 ? tr('node.layersTogether', { n: o.layerIds.length }) : '' }),
          onclick: () => r.kind !== 'fixed' && store.clickOption(r.id, o.id),
        },
        thumb ? h('img', { class: 'ne-thumb', src: thumb, alt: '' }) : h('span', { class: 'ne-thumb' }, first?.kind === 'group' ? '📁' : ''),
        h('span', { class: 'ne-label' }, o.name),
        bundled.has(o.id) ? h('span', { class: 'ne-tag pack', title: tr('node.fromBundle') }, tr('node.bundleShort')) : null,
        h(
          'button',
          {
            class: 'ne-x',
            title: tr('rules.deleteOption'),
            onclick: (e: Event) => {
              e.stopPropagation();
              store.deleteOption(r.id, o.id);
            },
          },
          '✕',
        ),
        port(`opt:${o.id}`, 'out', 'small'),
      ),
    );
  }
  if (!r.options.length) el.appendChild(h('div', { class: 'ne-empty' }, tr('node.dropLayersToGroup')));
  return el;
}

export function targetName(t: Target): string {
  const p = store.state.project!;
  if (t.kind === 'rule') return t.ruleId ? p.rules.find((r) => r.id === t.ruleId)?.name ?? '?' : '';
  if (t.kind === 'option') {
    for (const r of p.rules) {
      const o = r.options.find((x) => x.id === t.optionId);
      if (o) return `${r.name}：${o.name}`;
    }
    return '';
  }
  return t.layerId ? `${tr('node.layer')}: ${p.layerIndex[t.layerId]?.cleanName ?? '?'}` : '';
}

export function constraintNode(c: Constraint): HTMLElement {
  const all = [c.a, c.b, ...(c.more ?? [])];
  const removed = store.state.result?.perConstraint[c.id] ?? 0;
  const el = node(`con ${c.kind}` + (c.enabled ? '' : ' off'), c.id, `con:${c.id}`);
  el.title = tr('node.addTargetToRule');
  const head = h('div', { class: 'ne-head' });
  head.appendChild(h('span', { class: 'ne-grip', title: tr('node.drag') }, '⠿'));
  head.appendChild(
    h('input', {
      type: 'checkbox',
      checked: c.enabled,
      title: tr('constraints.toggle'),
      onchange: (e: Event) => store.updateConstraint(c.id, { enabled: (e.target as HTMLInputElement).checked }),
    }),
  );
  head.appendChild(titleBlock(tr('node.rule'), tr(c.kind === 'mutex' ? 'constraints.atMostOne' : 'constraints.aNeedsB')));
  head.appendChild(
    h(
      'select',
      { class: 'ne-kind wide', title: tr('node.changeRuleType'), onchange: (e: Event) => store.updateConstraint(c.id, { kind: (e.target as HTMLSelectElement).value as Constraint['kind'] }) },
      h('option', { value: 'mutex', selected: c.kind === 'mutex' }, tr('constraints.atMostOne')),
      h('option', { value: 'require', selected: c.kind === 'require' }, tr('constraints.aNeedsB')),
    ),
  );
  head.appendChild(h('button', { class: 'ne-x', title: tr('common.delete'), onclick: () => store.deleteConstraint(c.id) }, '✕'));
  el.appendChild(head);
  el.appendChild(
    h(
      'div',
      { class: 'ne-sub' },
      c.kind === 'mutex'
        ? tr('node.mutexHint')
        : tr('node.requireHint'),
    ),
  );
  all.forEach((t, i) => {
    const name = targetName(t);
    el.appendChild(
      h(
        'div',
        { class: 'ne-row slim' + (name ? '' : ' unset') },
        port(`cin:${c.id}:${i}`, 'in'),
        c.kind === 'require' && i < 2 ? h('span', { class: 'ne-tag' }, i ? 'B' : 'A') : null,
        h('span', { class: 'ne-label', title: name }, name || tr('node.emptyTarget')),
        name
          ? h(
              'button',
              { class: 'ne-x', title: tr('node.removeFromRule'), onclick: () => store.clearConstraintTarget(c.id, i) },
              '✕',
            )
          : null,
      ),
    );
  });
  el.appendChild(h('div', { class: 'ne-foot' }, removed ? tr('constraints.removed', { n: removed }) : tr('constraints.noneRemoved')));
  return el;
}

export function combineNode(p: Project): HTMLElement {
  const live = p.rules.filter((r) => r.enabled && r.kind !== 'fixed');
  const el = node('combine', 'combine', 'combine');
  el.appendChild(h('div', { class: 'ne-head' }, titleBlock(tr('node.matrix'), tr('node.combinations')), port('comb:out', 'out', 'on')));
  if (!live.length) el.appendChild(h('div', { class: 'ne-empty' }, tr('node.connectGroups')));
  for (const r of live) {
    const f = store.ruleFactor(r);
    el.appendChild(
      h(
        'div',
        { class: 'ne-row slim', title: f.why },
        port(`comb:${r.id}`, 'in'),
        h('span', { class: 'ne-label' }, r.name),
        h('span', { class: 'ne-count' + (f.n > 16 ? ' warn' : '') }, `×${f.n}`),
        h('button', { class: 'ne-x', title: tr('node.disconnectGroup'), onclick: () => store.setRuleEnabled(r.id, false) }, '✕'),
      ),
    );
  }
  const raw = store.state.result?.rawCount ?? 0;
  if (live.length) {
    el.appendChild(h('div', { class: 'ne-foot' }, `${live.map((r) => store.ruleFactor(r).n).join(' × ')} = ${raw}`));
    const big = live.map((r) => ({ r, f: store.ruleFactor(r) })).filter((x) => x.f.n > 16);
    if (big.length) {
      el.appendChild(
        h(
          'div',
          { class: 'ne-warn' },
          tr('node.manyCombinations', { groups: big.map((x) => `“${x.r.name}” ×${x.f.n} (${x.f.why})`).join(', '), hint: big.some((x) => x.r.kind === 'multi') ? tr('node.multiTip') : '' }),
        ),
      );
    }
  }
  return el;
}

export function noteNode(n: NodeNote): HTMLElement {
  const el = node(n.kind === 'note' ? 'note' : 'pv', n.id, `note:${n.id}`);
  el.appendChild(
    h(
      'div',
      { class: 'ne-head' },
      h('span', { class: 'ne-grip', title: tr('node.drag') }, '⠿'),
      titleBlock(tr('node.annotation'), n.kind === 'note' ? tr('node.note') : tr('node.preview')),
      h('button', { class: 'ne-x', title: tr('common.delete'), onclick: () => store.deleteNote(n.id) }, '✕'),
    ),
  );
  if (n.kind === 'note') {
    el.appendChild(
      h('textarea', {
        class: 'ne-note-text',
        placeholder: tr('node.notePlaceholder'),
        value: n.text ?? '',
        onchange: (e: Event) => store.setNoteText(n.id, (e.target as HTMLTextAreaElement).value),
      }),
    );
  } else {
    el.appendChild(h('canvas', { class: 'ne-pv-canvas', 'data-pv': n.id }));
    el.appendChild(h('div', { class: 'ne-foot' }, tr('node.livePreview')));
  }
  return el;
}

export function bundleNode(b: NodeBundle): HTMLElement {
  const p = store.state.project!;
  const el = node('bundle', b.id, `bun:${b.id}`);
  el.title = tr('node.bundleTitle');
  el.appendChild(
    h(
      'div',
      { class: 'ne-head' },
      h('span', { class: 'ne-grip', title: tr('node.drag') }, '⠿'),
      titleBlock(tr('node.layerBundle'), h('span', { 'data-rename': b.id, 'data-rename-kind': 'bundle', title: tr('node.renameTitle') }, b.name)),
      h('button', { class: 'ne-x', title: tr('node.deleteBundle'), onclick: () => store.deleteBundle(b.id) }, '✕'),
      port(`bun:${b.id}`, 'out', b.ruleId ? 'on' : ''),
    ),
  );
  for (const id of b.layerIds) {
    const l = p.layerIndex[id];
    if (!l) continue;
    const thumb = l.kind === 'layer' ? store.state.thumbs.get(id) : undefined;
    el.appendChild(
      h(
        'div',
        { class: 'ne-row slim' },
        thumb ? h('img', { class: 'ne-thumb', src: thumb, alt: '' }) : h('span', { class: 'ne-thumb' }, l.kind === 'group' ? '📁' : ''),
        h('span', { class: 'ne-label' }, l.cleanName),
        h('button', { class: 'ne-x', title: tr('node.removeBundleLayer'), onclick: () => store.bundleRemoveLayer(b.id, id) }, '✕'),
      ),
    );
  }
  if (!b.layerIds.length) el.appendChild(h('div', { class: 'ne-empty' }, tr('node.dropLayersToBundle')));
  const r = b.ruleId ? p.rules.find((x) => x.id === b.ruleId) : undefined;
  el.appendChild(
    h(
      'div',
      { class: 'ne-foot' },
      r ? tr('node.bundleOption', { group: r.name, n: b.layerIds.length }) : tr('node.connectBundle'),
    ),
  );
  return el;
}

export function exportNode(): HTMLElement {
  const el = node('export' + (store.state.exportScope === 'current' ? ' direct' : ''), 'export', 'export');
  el.appendChild(h('div', { class: 'ne-head' }, port('export:in', 'in'), titleBlock(tr('node.job'), tr('node.exportZip'))));
  el.appendChild(h('div', { class: 'ne-big', 'data-count': '1' }, ''));
  el.appendChild(h('div', { class: 'ne-foot', 'data-why': '1' }, ''));
  el.appendChild(h('button', { class: 'btn primary small ne-go', 'data-go': '1', onclick: () => void startExport() }, tr('tab.export')));
  return el;
}
