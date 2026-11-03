/**
 * Export / import of a project's configuration (option groups, rules, export
 * settings, visibility changes, part groups, current picks).
 *
 * Layers are referenced by their *path* of names instead of internal ids, so
 * a config saved from a template still applies after the file was drawn on,
 * re-saved, or even re-exported from another app. On import, an exact path
 * match wins; otherwise a layer with the same name that is unique in the
 * document is used; anything else is reported.
 */

import type { Constraint, LayerNode, Project, Rule, RuleKind, Selection, Target, NodeNote } from './model';
import { uid } from './model';
import { isGenericName } from './suggest';

export const CONFIG_FORMAT = 'psd-combo-exporter-config';

type LayerRef = string[]; // names from the top level down

interface TargetRef {
  kind: Target['kind'];
  rule?: string;
  option?: [string, string];
  layer?: LayerRef;
}

export interface ConfigFile {
  format: typeof CONFIG_FORMAT;
  version: 1;
  savedAt: string;
  source: { name: string; width: number; height: number };
  rules: { name: string; kind: RuleKind; enabled: boolean; options: { name: string; layers: LayerRef[] }[] }[];
  constraints: { kind: Constraint['kind']; enabled: boolean; preset?: Constraint['preset']; targets: TargetRef[] }[];
  settings: Project['settings'];
  visibility: { layer: LayerRef; visible: boolean }[];
  atomic: LayerRef[];
  /** rule name -> picked option names */
  selection: Record<string, string[]>;
  /** combinations unticked for export, by their option labels */
  excluded: string[][];
  /** node editor: positions (r<i> = i-th group, c<i> = i-th rule, combine, export, note ids) and notes */
  nodes?: {
    layout: Record<string, { x: number; y: number }>;
    notes: NodeNote[];
    bundles?: { id: string; name: string; layers: LayerRef[]; rule: number; option: number }[];
  };
}

/** Path segment: the name, plus "#2", "#3"… when siblings above it share the name. */
function segment(p: Project, n: LayerNode): string {
  const sibs = n.parentId ? p.layerIndex[n.parentId]?.children ?? [] : p.layers.filter((l) => !l.parentId);
  // top-first order, like the layer panel
  let k = 0;
  for (let i = sibs.length - 1; i >= 0; i--) {
    if (sibs[i].name !== n.name) continue;
    k++;
    if (sibs[i].id === n.id) break;
  }
  return k > 1 ? `${n.name}#${k}` : n.name;
}

export function layerPath(p: Project, id: string): LayerRef {
  const out: string[] = [];
  for (let n: LayerNode | undefined = p.layerIndex[id]; n; n = n.parentId ? p.layerIndex[n.parentId] : undefined) out.unshift(segment(p, n));
  return out;
}

export function buildConfig(
  p: Project,
  selection: Selection,
  excludedLabels: string[][],
): ConfigFile {
  const ruleName = (id?: string) => p.rules.find((r) => r.id === id)?.name ?? '';
  const optionRef = (id?: string): [string, string] => {
    for (const r of p.rules) {
      const o = r.options.find((x) => x.id === id);
      if (o) return [r.name, o.name];
    }
    return ['', ''];
  };
  const tref = (t: Target): TargetRef =>
    t.kind === 'rule'
      ? { kind: 'rule', rule: ruleName(t.ruleId) }
      : t.kind === 'option'
      ? { kind: 'option', option: optionRef(t.optionId) }
      : { kind: 'layer', layer: t.layerId ? layerPath(p, t.layerId) : [] };
  return {
    format: CONFIG_FORMAT,
    version: 1,
    savedAt: new Date().toISOString(),
    source: { name: p.name, width: p.width, height: p.height },
    rules: p.rules.map((r) => ({
      name: r.name,
      kind: r.kind,
      enabled: r.enabled,
      options: r.options.map((o) => ({ name: o.name, layers: o.layerIds.map((id) => layerPath(p, id)) })),
    })),
    constraints: p.constraints.map((c) => ({
      kind: c.kind,
      enabled: c.enabled,
      preset: c.preset,
      targets: [c.a, c.b, ...(c.more ?? [])].map(tref),
    })),
    settings: { ...p.settings },
    visibility: Object.entries(p.visibility ?? {}).map(([id, visible]) => ({ layer: layerPath(p, id), visible })),
    atomic: (p.atomic ?? []).map((id) => layerPath(p, id)),
    selection: Object.fromEntries(
      p.rules.map((r) => [r.name, r.options.filter((o) => (selection[r.id] ?? []).includes(o.id)).map((o) => o.name)]),
    ),
    excluded: excludedLabels,
    nodes: {
      layout: Object.fromEntries(
        Object.entries(p.nodeLayout ?? {}).flatMap(([id, at]) => {
          const ri = p.rules.findIndex((r) => r.id === id);
          if (ri >= 0) return [[`r${ri}`, at]];
          const ci = p.constraints.findIndex((c) => c.id === id);
          if (ci >= 0) return [[`c${ci}`, at]];
          return [[id, at]];
        }),
      ),
      notes: p.nodeNotes ?? [],
      bundles: (p.nodeBundles ?? []).map((b) => {
        const rule = p.rules.findIndex((r) => r.id === b.ruleId);
        return {
          id: b.id,
          name: b.name,
          layers: b.layerIds.map((id) => layerPath(p, id)),
          rule,
          option: rule >= 0 ? p.rules[rule].options.findIndex((o) => o.id === b.optionId) : -1,
        };
      }),
    },
  };
}

export interface ApplyResult {
  selection: Selection;
  excludedLabels: string[][];
  /** references that could not be matched in this document */
  missing: string[];
  matched: number;
}

export function parseConfig(text: string): ConfigFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('不是有效的配置文件（JSON 解析失败）');
  }
  const cfg = data as ConfigFile;
  if (!cfg || cfg.format !== CONFIG_FORMAT || !Array.isArray(cfg.rules)) throw new Error('不是本软件导出的配置文件');
  return cfg;
}

/** Apply a config to a freshly loaded project (replaces its rules and settings). */
export function applyConfig(p: Project, cfg: ConfigFile): ApplyResult {
  const missing: string[] = [];
  let matched = 0;
  const byPath = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const l of p.layers) {
    byPath.set(layerPath(p, l.id).join('\u0000'), l.id);
    const list = byName.get(l.name) ?? [];
    list.push(l.id);
    byName.set(l.name, list);
  }
  const resolve = (ref: LayerRef): string | undefined => {
    const exact = byPath.get(ref.join('\u0000'));
    if (exact) {
      matched++;
      return exact;
    }
    const same = byName.get((ref[ref.length - 1] ?? '').replace(/#\d+$/, ''));
    if (same && same.length === 1) {
      matched++;
      return same[0];
    }
    missing.push(ref.join('/'));
    return undefined;
  };

  p.rules = cfg.rules.map(
    (r): Rule => ({
      id: uid('rule'),
      name: r.name,
      kind: r.kind,
      enabled: r.enabled,
      source: 'config',
      options: r.options.map((o) => ({
        id: uid('opt'),
        name: o.name,
        layerIds: o.layers.map(resolve).filter((x): x is string => !!x),
        source: '',
      })),
    }),
  );
  const ruleId = (name?: string) => p.rules.find((r) => r.name === name)?.id;
  const optionId = (ref?: [string, string]) => p.rules.find((r) => r.name === ref?.[0])?.options.find((o) => o.name === ref?.[1])?.id;
  const target = (t: TargetRef): Target =>
    t.kind === 'rule'
      ? { kind: 'rule', ruleId: ruleId(t.rule) }
      : t.kind === 'option'
      ? { kind: 'option', optionId: optionId(t.option) }
      : { kind: 'layer', layerId: t.layer && t.layer.length ? resolve(t.layer) : undefined };
  p.constraints = (cfg.constraints ?? []).map((c) => {
    const ts = c.targets.map(target);
    return { id: uid('con'), kind: c.kind, enabled: c.enabled, preset: c.preset, a: ts[0] ?? { kind: 'rule' }, b: ts[1] ?? { kind: 'rule' }, more: ts.slice(2) };
  });
  p.settings = { ...p.settings, ...(cfg.settings ?? {}) };
  p.visibility = {};
  for (const v of cfg.visibility ?? []) {
    const id = resolve(v.layer);
    if (id) p.visibility[id] = v.visible;
  }
  p.atomic = (cfg.atomic ?? []).map(resolve).filter((x): x is string => !!x);

  p.nodeNotes = Array.isArray(cfg.nodes?.notes) ? cfg.nodes!.notes.map((n) => ({ ...n })) : [];
  p.nodeBundles = (cfg.nodes?.bundles ?? []).map((b) => {
    const r = p.rules[b.rule];
    const o = r?.options[b.option];
    return { id: b.id, name: b.name, layerIds: (b.layers ?? []).map(resolve).filter((x): x is string => !!x), ruleId: o ? r.id : undefined, optionId: o?.id };
  });
  p.nodeLayout = {};
  for (const [key, at] of Object.entries(cfg.nodes?.layout ?? {})) {
    const m = /^([rc])(\d+)$/.exec(key);
    const id = m ? (m[1] === 'r' ? p.rules[+m[2]]?.id : p.constraints[+m[2]]?.id) : key;
    if (id && at && typeof at.x === 'number' && typeof at.y === 'number') p.nodeLayout[id] = { x: at.x, y: at.y };
  }

  const selection: Selection = {};
  for (const r of p.rules) {
    const names = cfg.selection?.[r.name] ?? [];
    const ids = r.options.filter((o) => names.includes(o.name)).map((o) => o.id);
    if (ids.length) selection[r.id] = ids;
  }
  return { selection, excludedLabels: cfg.excluded ?? [], missing: [...new Set(missing)], matched };
}

/**
 * Groups that draw ONE element out of several layers (line art + base colour +
 * shading + highlight ...): every child is a plain layer that is a "part" -
 * a generic name like "layer 61", a part name (base / highlight / shadow ...),
 * a clipped layer, or a name sharing the group's name ("eye patch" plus
 * "eye patch shadow"). A group whose children are meaningfully named
 * alternatives is not a part group.
 */
const PART_NAME = /线稿|勾线|描边|底色|固有色|上色|颜色|高光|阴影|暗部|光影|反光|亮部|阴|光|色|线|影|渐变|质感|纹理|line|color|colour|shadow|shade|light|base|flat/i;
export function detectAtomicGroups(p: Project): string[] {
  const out: string[] = [];
  for (const g of p.layers) {
    if (g.kind !== 'group' || g.children.length < 2) continue;
    const gn = g.cleanName.trim();
    const part = (c: LayerNode) =>
      c.kind === 'layer' &&
      (isGenericName(c.cleanName) ||
        PART_NAME.test(c.cleanName) ||
        c.clipping ||
        (!!gn && !!c.cleanName.trim() && (c.cleanName.includes(gn) || gn.includes(c.cleanName.trim()))));
    if (g.children.every(part)) out.push(g.id);
  }
  return out;
}

/** "a-b-c" labels of a combination, used to remember unticked combinations. */
export const labelKey = (labels: string[]) => labels.join('\u0000');
