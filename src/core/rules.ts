/**
 * Rule engine: option groups, visibility, constraint validation and
 * cartesian enumeration.
 *
 * Visibility model (per node, layers *and* groups):
 *   - a node referenced by an option is shown iff one of its options is chosen
 *     (options of a fixed group are always chosen); choosing it also turns on
 *     its parent groups so a pick is never silently invisible
 *   - a node carrying export `[tags]` but no option is hidden (CLI semantics)
 *   - every other node keeps the visibility saved in the PSD
 * A node is drawn when it and all its ancestors are on.
 */

import type { Constraint, LayerNode, Project, Rule, RuleKind, RuleOption, Selection, Target } from './model';
import { uid } from './model';

export const MULTI_LIMIT = 10;

export interface RuleIndex {
  rules: Map<string, Rule>;
  options: Map<string, RuleOption & { ruleId: string }>;
  /** node id -> option ids that contain it */
  layerOptions: Map<string, string[]>;
}

export function buildIndex(project: Project): RuleIndex {
  const rules = new Map<string, Rule>();
  const options = new Map<string, RuleOption & { ruleId: string }>();
  const layerOptions = new Map<string, string[]>();
  for (const r of project.rules) {
    rules.set(r.id, r);
    for (const o of r.options) {
      options.set(o.id, { ...o, ruleId: r.id });
      for (const lid of o.layerIds) {
        const list = layerOptions.get(lid) ?? [];
        list.push(o.id);
        layerOptions.set(lid, list);
      }
    }
  }
  return { rules, options, layerOptions };
}

/* Rule creation */

export function layerLabel(project: Project, layerId?: string): string {
  if (!layerId) return '';
  const l = project.layerIndex[layerId];
  return l ? l.cleanName || l.name : '';
}

/** Rules implied by `[tags]` in layer names (compatible with the CLI). */
export function suggestRules(project: Project): Rule[] {
  const rules: Rule[] = [];
  const primary = new Map<string, string[]>();
  const secondary = new Map<string, Map<string, string[]>>();
  const fixedLayers: string[] = [];

  for (const layer of project.layers) {
    for (const tag of layer.tags) {
      if (tag.ignore || !tag.name) continue;
      if (tag.fixed) {
        if (!fixedLayers.includes(layer.id)) fixedLayers.push(layer.id);
        continue;
      }
      if (tag.group === null) {
        const list = primary.get(tag.name) ?? [];
        if (!list.includes(layer.id)) list.push(layer.id);
        primary.set(tag.name, list);
      } else {
        // `[a@]` and `[b@]` share the empty group, exactly like the CLI
        const groupName = tag.group || '(无组名)';
        const group = secondary.get(groupName) ?? new Map<string, string[]>();
        const list = group.get(tag.name) ?? [];
        if (!list.includes(layer.id)) list.push(layer.id);
        group.set(tag.name, list);
        secondary.set(groupName, group);
      }
    }
  }

  const mkOptions = (m: Map<string, string[]>): RuleOption[] =>
    [...m.entries()].map(([name, layerIds]) => ({
      id: uid('opt'),
      name,
      layerIds,
      source: layerLabel(project, layerIds[0]),
    }));

  if (primary.size > 0) {
    rules.push({
      id: uid('rule'),
      name: '主标签',
      kind: 'exclusive',
      options: mkOptions(primary),
      enabled: true,
      source: 'primary tags',
    });
  }
  for (const [groupName, tags] of [...secondary.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    rules.push({
      id: uid('rule'),
      name: groupName,
      kind: 'optional',
      options: mkOptions(tags),
      enabled: true,
      source: `@${groupName === '(无组名)' ? '' : groupName}`,
    });
  }
  if (fixedLayers.length > 0) {
    rules.push({
      id: uid('rule'),
      name: '固定显示',
      kind: 'fixed',
      options: fixedLayers.map((id) => ({ id: uid('opt'), name: layerLabel(project, id), layerIds: [id], source: '' })),
      enabled: true,
      source: 'fixed tags',
    });
  }
  return rules;
}

/** One option per given layer/group. */
export function ruleFromLayers(project: Project, layerIds: string[], kind: RuleKind, name?: string): Rule {
  return {
    id: uid('rule'),
    name: name || (layerIds.length === 1 ? layerLabel(project, layerIds[0]) : `选项组 ${project.rules.length + 1}`),
    kind,
    options: layerIds.map((id) => ({ id: uid('opt'), name: layerLabel(project, id), layerIds: [id], source: '' })),
    enabled: true,
    source: 'manual',
  };
}

/** "Children of this group become the options", the most common workflow. */
export function ruleFromGroupChildren(project: Project, groupId: string, kind: RuleKind): Rule | null {
  const g = project.layerIndex[groupId];
  if (!g || g.kind !== 'group' || g.children.length === 0) return null;
  // top-most child first, like the Photoshop layer panel
  let kids = [...g.children].reverse();
  // When a group mixes sub-groups with loose layers (e.g. two hair variants
  // plus a shared "hair shadow"), only the sub-groups are the options; the
  // loose layers are shared parts and stay as they are.
  const groups = kids.filter((c) => c.kind === 'group');
  if (groups.length >= 2 && groups.length < kids.length) kids = groups;
  return ruleFromLayers(project, kids.map((c) => c.id), kind, g.cleanName || g.name);
}

/* Selection helpers */

function readSel(sel: Selection, ruleId: string): string[] {
  return sel[ruleId] ?? [];
}

export function isSelected(sel: Selection, ruleId: string, optionId: string): boolean {
  return readSel(sel, ruleId).includes(optionId);
}

/** Default pick for a rule: the option whose layers are visible in the PSD, else the first. */
export function defaultChoice(project: Project, rule: Rule): string[] {
  if (rule.kind === 'fixed') return rule.options.map((o) => o.id);
  const shown = rule.options.filter((o) => o.layerIds.some((id) => project.layerIndex[id]?.authoredVisible && !hasExportTags(project.layerIndex[id])));
  if (rule.kind === 'multi') return shown.map((o) => o.id);
  if (shown.length) return [shown[0].id];
  if (rule.kind === 'exclusive' && rule.options.length) return [rule.options[0].id];
  return [];
}

export function defaultSelection(project: Project): Selection {
  const sel: Selection = {};
  for (const r of project.rules) {
    const ids = defaultChoice(project, r);
    if (ids.length) sel[r.id] = ids;
  }
  return sel;
}

/** Apply a click on an option, applying radio semantics for exclusive groups. */
export function toggleOption(project: Project, sel: Selection, ruleId: string, optionId: string): Selection {
  const rule = project.rules.find((r) => r.id === ruleId);
  if (!rule) return sel;
  const next: Selection = { ...sel };
  const current = readSel(sel, ruleId);
  switch (rule.kind) {
    case 'fixed':
      return sel;
    case 'exclusive':
      next[ruleId] = [optionId];
      return next;
    case 'optional':
      next[ruleId] = current.includes(optionId) ? [] : [optionId];
      return next;
    case 'multi':
      next[ruleId] = current.includes(optionId) ? current.filter((id) => id !== optionId) : [...current, optionId];
      return next;
  }
}

/** Keep a selection consistent after a rule changed kind or lost options. */
export function normalizeSelection(project: Project, sel: Selection): Selection {
  const out: Selection = {};
  for (const r of project.rules) {
    const valid = readSel(sel, r.id).filter((id) => r.options.some((o) => o.id === id));
    let ids = valid;
    if (r.kind === 'fixed') ids = r.options.map((o) => o.id);
    else if (r.kind === 'exclusive') ids = valid.length ? [valid[0]] : r.options.length ? [r.options[0].id] : [];
    else if (r.kind === 'optional') ids = valid.slice(0, 1);
    if (ids.length) out[r.id] = ids;
  }
  return out;
}

/* Visibility */

export function hasExportTags(layer: LayerNode | undefined): boolean {
  return !!layer && layer.tags.some((t) => !t.ignore && !t.fixed && t.name);
}

export interface Visibility {
  /** own visibility of every node that is on */
  on: Set<string>;
  /** leaves that are actually drawn (on, with every ancestor on) */
  drawn: Set<string>;
}

function selectedOption(idx: RuleIndex, sel: Selection, oid: string): boolean {
  const meta = idx.options.get(oid);
  if (!meta) return false;
  const rule = idx.rules.get(meta.ruleId);
  if (rule?.kind === 'fixed') return true;
  return readSel(sel, meta.ruleId).includes(oid);
}

export function computeVisibility(project: Project, sel: Selection, idx = buildIndex(project)): Visibility {
  const on = new Set<string>();
  const forced: string[] = [];
  for (const layer of project.layers) {
    const opts = idx.layerOptions.get(layer.id);
    if (opts && opts.length) {
      if (opts.some((oid) => selectedOption(idx, sel, oid))) {
        on.add(layer.id);
        forced.push(layer.id);
      }
    } else if (!hasExportTags(layer) && (project.visibility?.[layer.id] ?? layer.authoredVisible)) {
      on.add(layer.id);
    }
  }
  // an explicitly chosen node turns its parent groups on
  for (const id of forced) {
    let p = project.layerIndex[id]?.parentId;
    while (p) {
      if (idx.layerOptions.get(p)?.length && !on.has(p)) break; // parent itself is an unchosen option
      on.add(p);
      p = project.layerIndex[p]?.parentId ?? null;
    }
  }
  const drawn = new Set<string>();
  const walk = (list: LayerNode[]) => {
    for (const n of list) {
      if (!on.has(n.id)) continue;
      if (n.kind === 'group') walk(n.children);
      else if (n.bbox) drawn.add(n.id);
    }
  };
  walk(project.layers.filter((l) => l.parentId === null));
  return { on, drawn };
}

/** Is this node actually on screen (itself and all ancestors on)? */
export function isDrawn(project: Project, vis: Visibility, id: string): boolean {
  let cur: string | null = id;
  while (cur) {
    if (!vis.on.has(cur)) return false;
    cur = project.layerIndex[cur]?.parentId ?? null;
  }
  return true;
}

/* Constraint evaluation */

function targetActive(project: Project, idx: RuleIndex, sel: Selection, vis: Visibility, t: Target): boolean {
  switch (t.kind) {
    case 'rule': {
      if (!t.ruleId) return false;
      const rule = idx.rules.get(t.ruleId);
      if (rule?.kind === 'fixed') return rule.options.length > 0;
      return readSel(sel, t.ruleId).length > 0;
    }
    case 'option':
      return t.optionId ? selectedOption(idx, sel, t.optionId) : false;
    case 'layer':
      return t.layerId ? isDrawn(project, vis, t.layerId) : false;
  }
}

export interface Violation {
  constraint: Constraint;
  message: string;
}

export function describeTarget(project: Project, idx: RuleIndex, t: Target): string {
  if (t.kind === 'option' && t.optionId) {
    const meta = idx.options.get(t.optionId);
    const rule = meta ? idx.rules.get(meta.ruleId) : undefined;
    return rule ? `${rule.name}：${meta!.name}` : '（已删除的选项）';
  }
  if (t.kind === 'rule' && t.ruleId) return idx.rules.get(t.ruleId)?.name ?? '（已删除的组）';
  if (t.kind === 'layer' && t.layerId) return `图层 ${layerLabel(project, t.layerId) || '（已删除）'}`;
  return '（未设置）';
}

export function targetIsSet(t: Target): boolean {
  return !!(t.kind === 'rule' ? t.ruleId : t.kind === 'option' ? t.optionId : t.layerId);
}

/** All targets of a constraint (mutex rules can list more than two). */
export function constraintTargets(c: Constraint): Target[] {
  return [c.a, c.b, ...(c.kind === 'mutex' ? c.more ?? [] : [])];
}

export function findViolations(
  project: Project,
  sel: Selection,
  idx = buildIndex(project),
  vis = computeVisibility(project, sel, idx),
): Violation[] {
  const out: Violation[] = [];
  for (const c of project.constraints) {
    if (!c.enabled) continue;
    if (c.kind === 'mutex') {
      // N-way exclusion: at most one of the listed targets may be active
      const targets = constraintTargets(c).filter(targetIsSet);
      if (targets.length < 2) continue;
      const active = targets.filter((t) => targetActive(project, idx, sel, vis, t));
      if (active.length > 1) {
        const names = active.map((t) => `「${describeTarget(project, idx, t)}」`);
        out.push({
          constraint: c,
          message: targets.length === 2 ? `${names[0]}与${names[1]}不能同时出现` : `${names.join('、')}最多只能出现一个`,
        });
      }
      continue;
    }
    if (!targetIsSet(c.a) || !targetIsSet(c.b)) continue;
    const a = targetActive(project, idx, sel, vis, c.a);
    const b = targetActive(project, idx, sel, vis, c.b);
    const an = describeTarget(project, idx, c.a);
    const bn = describeTarget(project, idx, c.b);
    if (a && !b) {
      out.push({ constraint: c, message: `选了「${an}」就必须同时有「${bn}」` });
    }
  }
  return out;
}

/* Cartesian enumeration */

/** Short stable id of a picture (64-bit FNV-1a of its drawn layers). */
export function sigHash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

export interface Combo {
  selection: Selection;
  /** own-visibility set handed to the renderer */
  on: Set<string>;
  /** drawn leaves, used for de-duplication */
  drawn: Set<string>;
  /** option names in rule order, used for file naming */
  labels: string[];
  /** label of the first enumerated group (for {primary} / sub folders) */
  primaryLabel: string;
  signature: string;
}

export interface RejectedCombo {
  labels: string[];
  reason: string;
  constraintId: string;
  kind: 'mutex' | 'require' | 'duplicate' | 'empty';
}

export interface EnumerateResult {
  combos: Combo[];
  rejected: RejectedCombo[];
  /** product size before constraint filtering */
  rawCount: number;
  truncated: boolean;
  /** constraint id -> number of combinations it removed */
  perConstraint: Record<string, number>;
  /** rules whose multi-select option count was capped */
  cappedRules: string[];
}

export interface EnumerateOptions {
  limit?: number;
  /** current UI selection: groups that do not take part keep this pick */
  base?: Selection;
  /** enumerate every possibility, ignoring cross-group rules (still de-duplicated) */
  ignoreConstraints?: boolean;
}

interface Choice {
  ids: string[];
  labels: string[];
}

function ruleChoices(rule: Rule): Choice[] {
  const opts = rule.options.map((o) => ({ ids: [o.id], labels: [o.name] }));
  switch (rule.kind) {
    case 'exclusive':
      return opts;
    case 'optional':
      return [{ ids: [], labels: [] }, ...opts];
    case 'multi': {
      const n = Math.min(rule.options.length, MULTI_LIMIT);
      const list: Choice[] = [];
      for (let mask = 0; mask < 1 << n; mask++) {
        const ids: string[] = [];
        const labels: string[] = [];
        for (let i = 0; i < n; i++) {
          if (mask & (1 << i)) {
            ids.push(rule.options[i].id);
            labels.push(rule.options[i].name);
          }
        }
        list.push({ ids, labels });
      }
      return list.sort((a, b) => a.ids.length - b.ids.length);
    }
    case 'fixed':
      return [{ ids: rule.options.map((o) => o.id), labels: [] }];
  }
}

export function choiceCount(rule: Rule): number {
  if (!rule.enabled || rule.kind === 'fixed') return 1;
  return ruleChoices(rule).length;
}

export function enumerate(project: Project, opts: EnumerateOptions = {}): EnumerateResult {
  const limit = opts.limit ?? 5000;
  const idx = buildIndex(project);
  const base = opts.base ?? {};
  const dims: { rule: Rule; choices: Choice[] }[] = [];
  const frozen: Selection = {};
  const cappedRules: string[] = [];

  for (const rule of project.rules) {
    if (rule.kind === 'fixed') {
      frozen[rule.id] = rule.options.map((o) => o.id);
      continue;
    }
    if (!rule.enabled) {
      const ids = readSel(base, rule.id);
      if (ids.length) frozen[rule.id] = ids;
      continue;
    }
    if (rule.options.length === 0) continue;
    if (rule.kind === 'multi' && rule.options.length > MULTI_LIMIT) cappedRules.push(rule.id);
    dims.push({ rule, choices: ruleChoices(rule) });
  }

  const rawCount = dims.reduce((acc, d) => acc * d.choices.length, 1);
  const combos: Combo[] = [];
  const rejected: RejectedCombo[] = [];
  const perConstraint: Record<string, number> = {};
  const seen = new Set<string>();
  let truncated = false;
  let visited = 0;
  const hardStop = Math.max(limit * 20, 200000);

  const walk = (depth: number, sel: Selection, labels: string[], primaryLabel: string): void => {
    if (truncated) return;
    if (depth === dims.length) {
      if (++visited > hardStop) {
        truncated = true;
        return;
      }
      const full: Selection = { ...frozen, ...sel };
      const vis = computeVisibility(project, full, idx);
      const violations = opts.ignoreConstraints ? [] : findViolations(project, full, idx, vis);
      if (violations.length > 0) {
        for (const v of violations) perConstraint[v.constraint.id] = (perConstraint[v.constraint.id] ?? 0) + 1;
        const v = violations[0];
        rejected.push({ labels, reason: v.message, constraintId: v.constraint.id, kind: v.constraint.kind });
        return;
      }
      if (vis.drawn.size === 0) {
        rejected.push({ labels, reason: '空白画面：没有任何可见图层', constraintId: '', kind: 'empty' });
        return;
      }
      const signature = [...vis.drawn].sort().join(',');
      if (seen.has(signature)) {
        rejected.push({ labels, reason: '与前面某个组合的画面完全相同，已去重', constraintId: '', kind: 'duplicate' });
        return;
      }
      seen.add(signature);
      if (combos.length >= limit) {
        truncated = true;
        return;
      }
      combos.push({ selection: full, on: vis.on, drawn: vis.drawn, labels, primaryLabel, signature: sigHash(signature) });
      return;
    }
    const dim = dims[depth];
    for (const choice of dim.choices) {
      if (truncated) return;
      const next: Selection = { ...sel };
      if (choice.ids.length) next[dim.rule.id] = choice.ids;
      else delete next[dim.rule.id];
      const nextLabels = choice.labels.length ? [...labels, ...choice.labels] : labels;
      const nextPrimary = depth === 0 ? choice.labels.join('+') : primaryLabel;
      walk(depth + 1, next, nextLabels, nextPrimary);
    }
  };

  walk(0, {}, [], '');
  return { combos, rejected, rawCount, truncated, perConstraint, cappedRules };
}

export function estimateCount(project: Project): number {
  let n = 1;
  for (const rule of project.rules) {
    n *= choiceCount(rule);
    if (n > 1e12) return Infinity;
  }
  return n;
}

/* File naming */

const FILE_NAME_BYTES = 120;
const UTF8 = new TextEncoder();

function truncateUtf8(name: string, maxBytes: number): string {
  let out = '';
  let bytes = 0;
  for (const ch of name) {
    const n = UTF8.encode(ch).length;
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return out;
}

export function sanitizeFileName(name: string): string {
  return truncateUtf8(
    name
      .normalize('NFKC')
      // Unicode format characters include zero-width spaces/joiners, bidi
      // controls and BOMs. They are legal in ZIP names but break some mobile
      // extractors and preview providers, so they must not cross the export
      // boundary.
      .replace(/[\p{Cf}\p{Cs}]/gu, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    ,
    FILE_NAME_BYTES,
  );
}

export function comboFileName(project: Project, combo: Combo, index: number): string {
  const t = project.settings.template || '{psd}-{combo}';
  const ext = project.settings.format === 'jpeg' ? 'jpg' : project.settings.format;
  const comboName = combo.labels.join('-') || '默认';
  let stem = t
    .replace(/\{psd\}/g, project.name)
    .replace(/\{primary\}/g, combo.primaryLabel || '默认')
    .replace(/\{combo\}/g, comboName)
    .replace(/\{index\}/g, String(index + 1).padStart(3, '0'))
    .replace(/\{n\}/g, String(index + 1));
  stem = sanitizeFileName(stem).replace(/^[-_ ]+|[-_ ]+$/g, '');
  if (!stem) stem = `variant-${index + 1}`;
  const dir =
    project.settings.layout === 'primary' && combo.primaryLabel ? `${sanitizeFileName(combo.primaryLabel)}/` : '';
  return `${dir}${stem}.${ext}`;
}

/** Make every name in the archive unique ("a.png", "a (2).png", ...). */
export function uniqueNames(names: string[]): string[] {
  const used = new Map<string, number>();
  return names.map((n) => {
    const key = n.toLowerCase();
    const count = used.get(key) ?? 0;
    used.set(key, count + 1);
    if (count === 0) return n;
    const dot = n.lastIndexOf('.');
    return `${n.slice(0, dot)} (${count + 1})${n.slice(dot)}`;
  });
}
