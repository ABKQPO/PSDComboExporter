/**
 * Structure recognition for untagged documents: proposes option groups from
 * the way the artist organised the layers:
 *
 *   a folder holding several sibling variants   -> exclusive (one is shown)
 *   the same folder, all children hidden        -> optional (none is fine)
 *   children sharing a name prefix              -> one group from that cluster
 *   hidden top-level elements ("accessories")   -> multi-select
 *
 * Leaf layers next to variant groups (e.g. a shadow beside two hair variants)
 * are kept as shared parts, not offered as options.
 */

import type { LayerNode, Project, RuleKind } from './model';

export interface Suggestion {
  /** stable key for the UI */
  key: string;
  name: string;
  kind: RuleKind;
  /** layer ids, top-most first */
  layerIds: string[];
  optionNames: string[];
  /** ticked by default */
  recommended: boolean;
  /** human explanation */
  why: string;
  /** leaf layers kept as shared parts */
  shared: string[];
}

const GENERIC = /^(图层|圖層|layer|组|組|group|新建图层|新增圖層|新規レイヤー|レイヤー)\s*\d*(\s*[(（]\d+[)）])?(\s*(副本|拷贝|拷貝|copy)\s*\d*)?$/i;

const ACCESSORY = /配件|饰品|飾品|装饰|裝飾|道具|小物|accessor|item|prop/i;

export const isGenericName = (name: string) => GENERIC.test(name.trim());

/** "name（variant）" -> ["name", "variant"], "face2" -> ["face", "2"] */
export function splitVariantName(name: string): [string, string] | null {
  const n = name.trim();
  let m = /^(.+?)\s*[（(]\s*(.+?)\s*[)）]\s*$/.exec(n);
  if (m) return [m[1], m[2]];
  m = /^(.*?\D)\s*(\d+)$/.exec(n);
  if (m && m[1].trim()) return [m[1].trim(), m[2]];
  return null;
}

const topFirst = (list: LayerNode[]) => [...list].reverse();
const nonEmpty = (l: LayerNode): boolean => (l.kind === 'group' ? l.children.some(nonEmpty) : !!l.bbox);

function kindFor(options: LayerNode[]): RuleKind {
  const shown = options.filter((o) => o.authoredVisible).length;
  return shown === 1 ? 'exclusive' : 'optional';
}

/** Groups of siblings sharing a name prefix (2+ members, non-generic prefix). */
function clusters(list: LayerNode[]): Map<string, LayerNode[]> {
  const out = new Map<string, LayerNode[]>();
  for (const l of list) {
    if (isGenericName(l.cleanName)) continue;
    const sp = splitVariantName(l.cleanName);
    if (!sp || isGenericName(sp[0])) continue;
    const arr = out.get(sp[0]) ?? [];
    arr.push(l);
    out.set(sp[0], arr);
  }
  for (const [k, v] of out) if (v.length < 2) out.delete(k);
  return out;
}

export function suggestGroups(p: Project, atomic: Set<string> = new Set(p.atomic ?? [])): Suggestion[] {
  const used = new Set(p.rules.flatMap((r) => r.options.flatMap((o) => o.layerIds)));
  const out: Suggestion[] = [];
  const taken = new Set<string>();
  const free = (ls: LayerNode[]) => ls.every((l) => !used.has(l.id) && !taken.has(l.id));
  const push = (s: Suggestion, members: LayerNode[]) => {
    if (s.layerIds.length < 2 || !free(members)) return;
    for (const m of members) taken.add(m.id);
    out.push(s);
  };

  const visit = (g: LayerNode, depth: number) => {
    if (g.kind !== 'group' || atomic.has(g.id)) return;
    const kids = topFirst(g.children).filter(nonEmpty);
    const groups = kids.filter((c) => c.kind === 'group');
    const leaves = kids.filter((c) => c.kind === 'layer');
    const cl = clusters(kids);
    const clusterCoversAll = cl.size === 1 && [...cl.values()][0].length === groups.length && groups.length === kids.length;

    if (groups.length >= 2 && (cl.size === 0 || clusterCoversAll)) {
      // category: every sub-group is one variant; accessories combine freely
      const accessory = ACCESSORY.test(g.cleanName) && groups.length <= 6;
      const kind: RuleKind = accessory ? 'multi' : kindFor(groups);
      push(
        {
          key: `cat:${g.id}`,
          name: g.cleanName || g.name,
          kind,
          layerIds: groups.map((x) => x.id),
          optionNames: groups.map((x) => x.cleanName || x.name),
          recommended: depth <= 1 && !accessory,
          why: accessory
            ? `「${g.cleanName}」里的 ${groups.length} 个部件可以任意搭配（每个都可开可关）`
            : kind === 'exclusive'
              ? `「${g.cleanName}」下有 ${groups.length} 个变体组，文件里显示着其中一个`
              : `「${g.cleanName}」下有 ${groups.length} 个变体组，文件里都没显示（可以不选）`,
          shared: leaves.map((x) => x.cleanName),
        },
        groups,
      );
    } else {
      // same-prefix clusters: "name（a）" / "name（b）" ...
      for (const [prefix, members] of cl) {
        push(
          {
            key: `pre:${g.id}:${prefix}`,
            name: prefix,
            kind: kindFor(members),
            layerIds: members.map((x) => x.id),
            optionNames: members.map((x) => splitVariantName(x.cleanName)![1]),
            recommended: false,
            why: `「${g.cleanName}」里名字都以「${prefix}」开头的 ${members.length} 项，一般只出现一个`,
            shared: [],
          },
          members,
        );
      }
      // the rest of a group made of independent elements: accessories
      const rest = groups.filter((x) => !taken.has(x.id) && !used.has(x.id) && ![...cl.values()].some((v) => v.includes(x)));
      if (rest.length >= 2 && rest.every((x) => !x.authoredVisible) && rest.length <= 8) {
        push(
          {
            key: `acc:${g.id}`,
            name: `${g.cleanName}（其它）`,
            kind: 'multi',
            layerIds: rest.map((x) => x.id),
            optionNames: rest.map((x) => x.cleanName),
            recommended: false,
            why: `「${g.cleanName}」里其余 ${rest.length} 个默认隐藏的部件，可以任意搭配`,
            shared: [],
          },
          rest,
        );
      }
    }
    for (const c of groups) visit(c, depth + 1);
  };
  const roots = topFirst(p.layers.filter((l) => !l.parentId));
  for (const r of roots) visit(r, 0);

  // hidden top-level elements (hands, wings, gag …): on/off accessories
  const acc = roots.filter((l) => !l.authoredVisible && nonEmpty(l) && !used.has(l.id) && !taken.has(l.id) && !hasOptionsInside(l, taken));
  if (acc.length >= 2 && acc.length <= 8) {
    out.push({
      key: 'acc:root',
      name: '配件',
      kind: 'multi',
      layerIds: acc.map((x) => x.id),
      optionNames: acc.map((x) => x.cleanName),
      recommended: false,
      why: `顶层 ${acc.length} 个默认隐藏的部件，可以任意搭配（每个都可开可关）`,
      shared: [],
    });
  }
  // flat documents (no variant structure at all): offer the named top-level
  // groups as parts that can be switched on and off
  if (!out.length) {
    const named = roots.filter((l) => l.kind === 'group' && nonEmpty(l) && !isGenericName(l.cleanName) && !used.has(l.id));
    if (named.length >= 2 && named.length <= 8) {
      out.push({
        key: 'acc:flat',
        name: '部件开关',
        kind: 'multi',
        layerIds: named.map((x) => x.id),
        optionNames: named.map((x) => x.cleanName),
        recommended: false,
        why: `文件里没有「分类 → 变体」的分组；这 ${named.length} 个顶层组看起来是可以单独开关的部件`,
        shared: [],
      });
    }
  }
  return out;
}

function hasOptionsInside(l: LayerNode, taken: Set<string>): boolean {
  return l.kind === 'group' && l.children.some((c) => taken.has(c.id) || hasOptionsInside(c, taken));
}

/** Number of pictures the given suggestions multiply to (on top of `base`). */
export function suggestionProduct(list: Suggestion[], base = 1): number {
  let n = base;
  for (const s of list) {
    const k = s.layerIds.length;
    n *= s.kind === 'exclusive' ? k : s.kind === 'optional' ? k + 1 : s.kind === 'multi' ? 2 ** k : 1;
  }
  return n;
}
