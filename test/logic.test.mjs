/**
 * Node-side tests for the pure logic (no DOM): tag parsing, visibility,
 * option-group kinds, both kinds of mutual exclusion, dependencies,
 * cartesian enumeration and file naming. Run with `npm test`.
 */

import { parseTags, stripTags } from '../src/core/tags';
import {
  suggestRules,
  ruleFromGroupChildren,
  ruleFromLayers,
  computeVisibility,
  defaultSelection,
  enumerate,
  findViolations,
  toggleOption,
  normalizeSelection,
  comboFileName,
  sanitizeFileName,
  uniqueNames,
} from '../src/core/rules';
import { defaultSettings } from '../src/core/model';
import { buildConfig, parseConfig, applyConfig, detectAtomicGroups } from '../src/core/config';
import { suggestGroups, suggestionProduct } from '../src/core/suggest';

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Tiny tree builder: [name, {hidden, kids:[...]}] ; children listed top-first like Photoshop. */
function project(spec) {
  const layers = [];
  let n = 0;
  const make = (items, parentId, depth) =>
    // PSD order is bottom -> top
    [...items].reverse().map(([name, opts = {}], index) => {
      const id = `L${n++}`;
      const node = {
        id,
        name,
        cleanName: stripTags(name) || name,
        kind: opts.kids ? 'group' : 'layer',
        parentId,
        index,
        depth,
        authoredVisible: !opts.hidden,
        opacity: 1,
        fill: 1,
        blendMode: 'normal',
        clipping: false,
        hasMask: false,
        effects: [],
        unsupported: [],
        tags: parseTags(name),
        children: [],
        bbox: opts.kids ? null : [0, 0, 10, 10],
      };
      layers.push(node);
      if (opts.kids) node.children = make(opts.kids, id, depth + 1);
      return node;
    });
  make(spec, null, 0);
  return {
    id: 'p',
    name: 'test',
    width: 10,
    height: 10,
    layers,
    layerIndex: Object.fromEntries(layers.map((l) => [l.id, l])),
    rules: [],
    constraints: [],
    settings: defaultSettings(),
    createdAt: 0,
    updatedAt: 0,
    fileSize: 0,
  };
}
const id = (p, name) => p.layers.find((l) => l.cleanName === name || l.name === name).id;
const names = (p, set) => [...set].map((i) => p.layerIndex[i].cleanName).sort();

console.log('\n# tags (CLI compatible)');
{
  const t = parseTags('scene [1][jp@text] [#censor 50] [+logo] [2:4]');
  check('primary tag', t[0].name === '1' && t[0].group === null);
  check('secondary tag with group', t[1].name === 'jp' && t[1].group === 'text');
  check('ignored filter tag with args', t[2].ignore && eq(t[2].args, ['50']));
  check('fixed tag', t[3].fixed && t[3].name === 'logo');
  check('range expands', eq(t.slice(4).map((x) => x.name), ['2', '3', '4']));
  check('stripTags', stripTags('scene [1] [a@b]') === 'scene');
}

console.log('\n# visibility');
{
  const p = project([
    ['文字', { kids: [['中文'], ['英文', { hidden: true }]] }],
    ['长发', { hidden: true, kids: [['发尾'], ['发根']] }],
    ['角色', { kids: [['A'], ['B', { hidden: true }]] }],
    ['背景'],
  ]);
  let vis = computeVisibility(p, {});
  check('untouched layers keep PSD visibility', eq(names(p, vis.drawn), ['A', '中文', '背景'].sort()), names(p, vis.drawn));

  const hair = ruleFromLayers(p, [id(p, '长发')], 'optional');
  p.rules = [hair];
  vis = computeVisibility(p, { [hair.id]: [hair.options[0].id] });
  check('choosing a hidden group shows its visible children', vis.drawn.has(id(p, '发尾')) && vis.drawn.has(id(p, '发根')));
  vis = computeVisibility(p, {});
  check('unchosen option stays hidden', !vis.drawn.has(id(p, '发尾')));

  const role = ruleFromGroupChildren(p, id(p, '角色'), 'exclusive');
  p.rules = [role];
  check('group children become options, top first', eq(role.options.map((o) => o.name), ['A', 'B']));
  vis = computeVisibility(p, { [role.id]: [role.options[1].id] });
  check('exclusive pick shows B and hides A', vis.drawn.has(id(p, 'B')) && !vis.drawn.has(id(p, 'A')));
  check('default selection follows PSD visibility', eq(defaultSelection(p)[role.id], [role.options[0].id]));
}

console.log('\n# option-group kinds and 组内互斥');
{
  const p = project([['hat'], ['glasses'], ['A'], ['B'], ['C'], ['bg']]);
  const role = ruleFromLayers(p, ['A', 'B', 'C'].map((n) => id(p, n)), 'exclusive', '角色');
  const acc = ruleFromLayers(p, ['hat', 'glasses'].map((n) => id(p, n)), 'optional', '配饰');
  const fixed = ruleFromLayers(p, [id(p, 'bg')], 'fixed', '背景');
  p.rules = [role, acc, fixed];
  let sel = { [role.id]: [role.options[0].id] };
  sel = toggleOption(p, sel, role.id, role.options[2].id);
  check('exclusive replaces the pick (组内互斥)', eq(sel[role.id], [role.options[2].id]));
  sel = toggleOption(p, sel, acc.id, acc.options[0].id);
  sel = toggleOption(p, sel, acc.id, acc.options[1].id);
  check('optional replaces the pick', eq(sel[acc.id], [acc.options[1].id]));
  sel = toggleOption(p, sel, acc.id, acc.options[1].id);
  check('optional can be cleared', eq(sel[acc.id], []));
  const r = enumerate(p);
  check('cartesian: 3 roles × (none + 2 accessories) = 9', r.combos.length === 9 && r.rawCount === 9, r.combos.length);
  check('fixed layer present in every combo', r.combos.every((c) => c.drawn.has(id(p, 'bg'))));
  check('labels in rule order', eq(r.combos[1].labels, ['A', 'hat']), r.combos[1].labels);

  acc.kind = 'multi';
  check('multi enumerates every subset', enumerate(p).combos.length === 12);
  role.enabled = false;
  const frozen = enumerate(p, { base: { [role.id]: [role.options[1].id] } });
  check('a group not in the product keeps the current pick', frozen.combos.length === 4 && frozen.combos.every((c) => c.drawn.has(id(p, 'B'))));
  role.kind = 'optional';
  role.enabled = true;
  check('normalizeSelection trims to one for optional', normalizeSelection(p, { [role.id]: role.options.map((o) => o.id) })[role.id].length === 1);
}

console.log('\n# 跨组互斥 / 条件排除 / 完全排除 / 依赖');
{
  const p = project([['cn'], ['en'], ['A'], ['B'], ['clothC'], ['clothD'], ['lash'], ['liner']]);
  const cn = ruleFromLayers(p, [id(p, 'cn')], 'optional', '中文');
  const en = ruleFromLayers(p, [id(p, 'en')], 'optional', '英文');
  const role = ruleFromLayers(p, [id(p, 'A'), id(p, 'B')], 'exclusive', '角色');
  const cloth = ruleFromLayers(p, [id(p, 'clothC'), id(p, 'clothD')], 'exclusive', '服装');
  p.rules = [cn, en, role, cloth];
  const base = enumerate(p).combos.length;
  check('baseline 2×2×2×2 = 16', base === 16, base);

  p.constraints = [{ id: 'c1', kind: 'mutex', enabled: true, a: { kind: 'rule', ruleId: cn.id }, b: { kind: 'rule', ruleId: en.id } }];
  let r = enumerate(p);
  check('跨组互斥 removes cn+en together', r.combos.length === 12 && r.perConstraint.c1 === 4, [r.combos.length, r.perConstraint]);
  check('rejected combos carry a reason', r.rejected.every((x) => x.reason.includes('不能同时出现')));

  p.constraints = [{ id: 'c2', kind: 'mutex', enabled: true, a: { kind: 'option', optionId: role.options[0].id }, b: { kind: 'option', optionId: cloth.options[0].id } }];
  r = enumerate(p);
  check('条件排除: A may not wear C', r.combos.length === 12 && !r.combos.some((c) => c.drawn.has(id(p, 'A')) && c.drawn.has(id(p, 'clothC'))));

  p.constraints = [{ id: 'c3', kind: 'mutex', enabled: true, a: { kind: 'layer', layerId: id(p, 'B') }, b: { kind: 'layer', layerId: id(p, 'clothD') } }];
  r = enumerate(p);
  check('完全排除: two layers never together', !r.combos.some((c) => c.drawn.has(id(p, 'B')) && c.drawn.has(id(p, 'clothD'))) && r.combos.length === 12);

  p.constraints = [{ id: 'c4', kind: 'mutex', enabled: false, a: { kind: 'rule', ruleId: cn.id }, b: { kind: 'rule', ruleId: en.id } }];
  check('disabled rule has no effect', enumerate(p).combos.length === 16);

  const lash = ruleFromLayers(p, [id(p, 'lash')], 'optional', '睫毛');
  const liner = ruleFromLayers(p, [id(p, 'liner')], 'optional', '眼线');
  p.rules = [lash, liner];
  p.constraints = [{ id: 'c5', kind: 'require', enabled: true, a: { kind: 'option', optionId: lash.options[0].id }, b: { kind: 'option', optionId: liner.options[0].id } }];
  r = enumerate(p);
  check('依赖: lash requires liner (3 of 4 remain)', r.combos.length === 3, r.combos.map((c) => c.labels));
  const v = findViolations(p, { [lash.id]: [lash.options[0].id] });
  check('violation message explains the dependency', v.length === 1 && v[0].message.includes('必须'));
}

console.log('\n# de-duplication and empty pictures');
{
  const p = project([['x', { hidden: true }], ['y']]);
  const g1 = ruleFromLayers(p, [id(p, 'x')], 'optional', 'g1');
  const g2 = ruleFromLayers(p, [id(p, 'x')], 'optional', 'g2');
  p.rules = [g1, g2];
  const r = enumerate(p);
  check('identical pictures are exported once', r.combos.length === 2 && r.rejected.some((x) => x.kind === 'duplicate'), r.combos.map((c) => c.labels));
}

console.log('\n# CLI tags -> rules');
{
  const p = project([['jp [jp@text]'], ['en [en@text]'], ['logo [+logo]'], ['s1 [1]'], ['s2 [2]']]);
  p.rules = suggestRules(p);
  const kinds = Object.fromEntries(p.rules.map((r) => [r.name, r.kind]));
  check('primary tags -> exclusive group', kinds['主标签'] === 'exclusive');
  check('@group -> optional group', kinds.text === 'optional');
  check('[+name] -> fixed', kinds['固定显示'] === 'fixed');
  check('tagged layers hidden unless chosen', !computeVisibility(p, {}).drawn.has(id(p, 'jp [jp@text]')));
  const r = enumerate(p);
  check('CLI product: 2 primaries × (none, jp, en) = 6', r.combos.length === 6, r.combos.length);
}

console.log('\n# naming');
{
  const p = project([['A'], ['B']]);
  const role = ruleFromLayers(p, [id(p, 'A'), id(p, 'B')], 'exclusive', '角色');
  p.rules = [role];
  const r = enumerate(p);
  check('default template', comboFileName(p, r.combos[0], 0) === 'test-A.png', comboFileName(p, r.combos[0], 0));
  p.settings.template = '{index}_{primary}/{combo}';
  check('slashes are sanitised', !comboFileName(p, r.combos[0], 0).includes('/'), comboFileName(p, r.combos[0], 0));
  p.settings.layout = 'primary';
  check('sub folder per first group', comboFileName(p, r.combos[1], 1).startsWith('B/'));
  check('duplicate names get a suffix', eq(uniqueNames(['a.png', 'a.png', 'b.png']), ['a.png', 'a (2).png', 'b.png']));

  // Zero-width format characters from PSD layer names must not become ZIP
  // entry names: several Android/QQ ZIP previewers cannot open those entries.
  const problematic = '服饰\u200b\u200c\u200d\u2060身体\u202e选项 2';
  const safe = sanitizeFileName(problematic);
  check('file names remove invisible Unicode format characters', safe === '服饰身体选项 2', safe);
  check('file names stay within a portable UTF-8 component size', new TextEncoder().encode(safe).length <= 120, safe.length);
  const longUnicode = sanitizeFileName('海蜇'.repeat(100) + '.png');
  check('file names truncate by UTF-8 bytes without splitting characters', new TextEncoder().encode(longUnicode).length <= 120 && !longUnicode.includes('\ufffd'), new TextEncoder().encode(longUnicode).length);
}

console.log('\n# N-way mutex, visibility overrides, config files');
{
  const spec = () => [
    ['尾巴', { kids: [['尾A'], ['尾B'], ['尾C']] }],
    ['饰品', { kids: [['角'], ['光环']] }],
    ['身体', { kids: [['线稿'], ['底色'], ['高光']] }],
    ['背景'],
  ];
  const p = project(spec());
  const tails = ruleFromLayers(p, [id(p, '尾A'), id(p, '尾B')], 'multi', '尾巴组');
  const acc = ruleFromLayers(p, [id(p, '角'), id(p, '光环'), id(p, '尾C')], 'multi', '饰品组');
  p.rules = [tails, acc];
  const raw = enumerate(p).combos.length; // 4 × 8 = 32
  check('product without rules = 32', raw === 32, raw);
  const L = (n) => ({ kind: 'layer', layerId: id(p, n) });
  p.constraints = [{ id: 'c1', kind: 'mutex', a: L('尾A'), b: L('尾B'), more: [L('尾C')], enabled: true, preset: 'multiMutex' }];
  const r = enumerate(p);
  const ok = r.combos.every((c) => ['尾A', '尾B', '尾C'].filter((n) => computeVisibility(p, c.selection).drawn.has(id(p, n))).length <= 1);
  check('3-way mutex: no combo shows two tails', ok);
  // tails ∅ × acc(8) + tail A × acc without C (4) + tail B × acc without C (4)
  check('3-way mutex count = 16', r.combos.length === 16, r.combos.length);
  check('ignoreConstraints gives everything', enumerate(p, { ignoreConstraints: true }).combos.length === 32);
  const unset = { ...p, constraints: [{ ...p.constraints[0], more: [{ kind: 'layer' }] }] };
  check('unset extra target ignored (A/B only) = 24', enumerate(unset).combos.length === 24, enumerate(unset).combos.length);

  p.visibility = { [id(p, '背景')]: false };
  check('visibility override hides layer', !computeVisibility(p, {}).drawn.has(id(p, '背景')));
  check('atomic detection: 身体 (线稿/底色/高光)', eq(detectAtomicGroups(p).map((g) => p.layerIndex[g].cleanName), ['身体']));
  p.atomic = detectAtomicGroups(p);

  const sel = { [tails.id]: [tails.options[0].id] };
  const cfg = parseConfig(JSON.stringify(buildConfig(p, sel, [['尾A', '角']])));
  // a fresh copy of the "same" document has different internal ids
  const q = project(spec());
  for (const l of q.layers) {
    l.id = 'X' + l.id;
    if (l.parentId) l.parentId = 'X' + l.parentId;
  }
  q.layerIndex = Object.fromEntries(q.layers.map((l) => [l.id, l]));
  const res = applyConfig(q, cfg);
  check('config: all layers matched', res.missing.length === 0, res.missing);
  check('config: rules restored', eq(q.rules.map((x) => [x.name, x.kind, x.options.length]), [['尾巴组', 'multi', 2], ['饰品组', 'multi', 3]]));
  check('config: 3-way mutex restored', q.constraints[0].more.length === 1 && q.constraints[0].more[0].layerId === id(q, '尾C'));
  check('config: visibility restored', q.visibility[id(q, '背景')] === false);
  check('config: atomic restored', eq(q.atomic, [id(q, '身体')]));
  check('config: selection restored', eq(res.selection[q.rules[0].id], [q.rules[0].options[0].id]));
  check('config: excluded labels kept', eq(res.excludedLabels, [['尾A', '角']]));
  check('config: same enumeration', enumerate(q).combos.length === 16, enumerate(q).combos.length);
  // a renamed layer is reported; a moved layer with a unique name still matches
  const z = project([['尾巴', { kids: [['尾A'], ['尾B2'], ['尾C']] }], ['其它', { kids: [['角'], ['光环']] }], ['身体', { kids: [['线稿'], ['底色'], ['高光']] }], ['背景']]);
  const zr = applyConfig(z, cfg);
  check('config: renamed layer reported', zr.missing.includes('尾巴/尾B'), zr.missing);
  check('config: moved layer found by unique name', z.rules[1].options[0].layerIds[0] === id(z, '角'));
  let threw = false;
  try {
    parseConfig('{"format":"other"}');
  } catch {
    threw = true;
  }
  check('config: foreign json rejected', threw);
}

console.log('\n# structure recognition (modelled on 影子牌捆绑.psd)');
{
  const parts = (...n) => n.map((x) => [x]);
  const p = project([
    ['水印'],
    ['绳子', { kids: parts('右绳勾线', '右绳底色') }],
    ['触手产卵', { hidden: true, kids: [['触手（青）', { hidden: true }], ['触手（紫）', { hidden: true }]] }],
    ['手', { hidden: true, kids: parts('图层72', '图层73', '图层13') }],
    ['角', { hidden: true, kids: [['脸下角', { hidden: true, kids: parts('图层 16', '图层 15') }], ['双角', { hidden: true, kids: parts('图层 12', '图层 11') }]] }],
    ['头发', { kids: [['短发', { kids: parts('图层61', '图层62') }], ['头发阴影'], ['长发', { hidden: true, kids: parts('图层68', '图层69') }]] }],
    ['表情', { kids: [['表情3', { hidden: true, kids: parts('图层77', '图层17') }], ['表情1', { kids: parts('图层51', '表情1') }], ['表情2', { hidden: true, kids: parts('表情2', '图层78') }]] }],
    [
      'R18配件',
      {
        kids: [
          ['产卵', { hidden: true, kids: parts('卵', '卵阴影(开正片叠底)') }],
          ['项圈', { hidden: true, kids: parts('图层29', '图层27') }],
          ['牛子（小，有液）', { hidden: true, kids: parts('图层20', '图层19') }],
          ['牛子（大）', { hidden: true, kids: parts('图层118', '图层113') }],
          ['龟甲', { hidden: true, kids: parts('图层6', '图层5') }],
          ['小穴（闭1）', { hidden: true, kids: parts('图层26', '图层25') }],
          ['小穴（开）', { hidden: true, kids: parts('图层110', '图层110') }],
        ],
      },
    ],
    ['眼罩', { hidden: true, kids: parts('眼罩', '眼罩阴影(开正片叠底)') }],
    ['身体', { kids: parts('反光', '图层33', '阴影', '肉垫底色', '底色') }],
    ['翅膀', { hidden: true, kids: parts('图层 4', '图层 3') }],
    ['尾巴', { kids: [['龙尾', { kids: parts('图层79(2)', '图层88') }], ['鱼尾', { hidden: true, kids: parts('图层79', '图层84') }], ['狐尾', { hidden: true, kids: parts('图层35', '图层36') }]] }],
    ['背景'],
  ]);
  for (const l of p.layers) if (l.kind === 'layer') l.bbox = [0, 0, 10, 10];
  const atomicNames = detectAtomicGroups(p).map((g) => p.layerIndex[g].cleanName).sort();
  for (const n of ['绳子', '手', '脸下角', '短发', '表情1', '表情2', '产卵', '牛子（大）', '小穴（开）', '眼罩', '身体', '翅膀', '龙尾', '狐尾'])
    check(`part group: ${n}`, atomicNames.includes(n), atomicNames);
  for (const n of ['触手产卵', '头发', '尾巴', 'R18配件', '角']) check(`not a part group: ${n}`, !atomicNames.includes(n));
  p.atomic = detectAtomicGroups(p);

  const sg = suggestGroups(p);
  const by = Object.fromEntries(sg.map((x) => [x.name, x]));
  check('suggest: 尾巴 = 必选一项 龙尾/鱼尾/狐尾', by['尾巴']?.kind === 'exclusive' && eq(by['尾巴'].optionNames, ['龙尾', '鱼尾', '狐尾']) && by['尾巴'].recommended, by['尾巴']);
  check('suggest: 头发 options skip shared 头发阴影', eq(by['头发']?.optionNames, ['短发', '长发']) && eq(by['头发'].shared, ['头发阴影']), by['头发']);
  check('suggest: 表情 is one category', eq(by['表情']?.optionNames, ['表情3', '表情1', '表情2']) && by['表情'].kind === 'exclusive', by['表情']);
  check('suggest: hidden 角 = 可选一项', by['角']?.kind === 'optional', by['角']);
  check('suggest: 牛子 cluster with short names', eq(by['牛子']?.optionNames, ['小，有液', '大']) && !by['牛子'].recommended, by['牛子']);
  check('suggest: 小穴 cluster', eq(by['小穴']?.optionNames, ['闭1', '开']), by['小穴']);
  check('suggest: R18 rest = 可多选 accessories', by['R18配件（其它）']?.kind === 'multi' && eq(by['R18配件（其它）'].optionNames, ['产卵', '项圈', '龟甲']), by['R18配件（其它）']);
  check('suggest: 触手 leaf cluster', eq(by['触手']?.optionNames, ['青', '紫']), by['触手']);
  check('suggest: top-level hidden accessories', eq(by['配件']?.optionNames, ['手', '眼罩', '翅膀']), by['配件']);
  check('suggest: no option offered twice', new Set(sg.flatMap((x) => x.layerIds)).size === sg.flatMap((x) => x.layerIds).length);
  check('suggest: recommended product = 3×2×3×3 = 54', suggestionProduct(sg.filter((x) => x.recommended)) === 54, suggestionProduct(sg.filter((x) => x.recommended)));
  // a group already turned into options is not suggested again
  p.rules = [ruleFromGroupChildren(p, id(p, '头发'), 'exclusive')];
  check('group children skip shared leaves', eq(p.rules[0].options.map((o) => o.name), ['短发', '长发']), p.rules[0].options.map((o) => o.name));
  check('suggest: used groups disappear', !suggestGroups(p).some((x) => x.name === '头发'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
