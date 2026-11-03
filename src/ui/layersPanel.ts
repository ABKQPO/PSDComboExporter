/**
 * Step 1 — layer tree. Tick layers/groups and turn them into option groups;
 * or turn a group's children into options with one click.
 */

import type { LayerNode, RuleKind } from '../core/model';
import { rootsTopFirst } from '../core/project';
import * as store from './store';
import { h } from './dom';
import { KIND_INFO, renderRestoreNotice } from './rulesPanel';

const BLEND_CN: Record<string, string> = {
  normal: '正常',
  multiply: '正片叠底',
  screen: '滤色',
  overlay: '叠加',
  'soft light': '柔光',
  'hard light': '强光',
  'vivid light': '亮光',
  'linear light': '线性光',
  'pin light': '点光',
  'hard mix': '实色混合',
  'color dodge': '颜色减淡',
  'color burn': '颜色加深',
  'linear dodge': '线性减淡（添加）',
  'linear burn': '线性加深',
  darken: '变暗',
  lighten: '变亮',
  'darker color': '深色',
  'lighter color': '浅色',
  difference: '差值',
  exclusion: '排除',
  subtract: '减去',
  divide: '划分',
  hue: '色相',
  saturation: '饱和度',
  color: '颜色',
  luminosity: '明度',
  'pass through': '穿透',
  dissolve: '溶解',
};

export function renderLayersPanel(): HTMLElement {
  const s = store.state;
  const p = s.project!;
  const root = h('div', { class: 'col' });

  root.appendChild(
    h(
      'div',
      { class: 'guide' },
      h('b', null, '第 1 步：选择参与组合的图层。'),
      ' 勾选图层或图层组，在下方把它们设为一个「选项组」；或点组旁边的 ',
      h('span', { class: 'kbd' }, '⇢ 子项作选项'),
      '，把组内每个子图层变成一个选项（如 发型：短发 / 长发）。没有加入任何选项组的图层，按 PSD 里保存的显示状态出现在每张导出图中；点图层左边的眼睛图标可以直接显示 / 隐藏它。',
    ),
  );

  if (s.warnings.length) {
    const w = h('div', { class: 'notice warn' });
    for (const t of s.warnings) w.appendChild(h('div', null, '⚠ ', t));
    root.appendChild(w);
  }

  const restoreNotice = renderRestoreNotice();
  if (restoreNotice) root.appendChild(restoreNotice);

  const sug = renderSuggestions();
  if (sug) root.appendChild(sug);

  root.appendChild(renderProfileCard());

  const head = h('div', { class: 'row wrap', style: 'gap:6px;margin:4px 0 8px' });
  head.appendChild(h('span', { class: 'pill' }, `${p.width}×${p.height}`));
  head.appendChild(h('span', { class: 'pill' }, `${p.layers.length} 个图层/组`));
  shownPill = h('span', { class: 'pill ok' }, `当前显示 ${s.vis?.drawn.size ?? 0} 个图层`);
  head.appendChild(shownPill);
  head.appendChild(h('span', { class: 'spacer' }));
  if (s.platform !== 'android') {
    head.appendChild(
      h(
        'button',
        { class: 'btn small', title: '按 PSD 保存时的显示状态渲染，与 PSD 内的合成图逐像素比较', onclick: () => void store.runCompare() },
        '校验渲染一致性',
      ),
    );
  }
  root.appendChild(head);

  if (s.compare) {
    const c = s.compare;
    const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
    root.appendChild(
      c.available
        ? h(
            'div',
            { class: 'notice ' + (c.same! > 0.999 ? 'ok' : 'info') },
            h('b', null, '与 PSD 内保存的合成图逐像素比对'),
            h('div', null, `图层内容：${pct(c.same!)} 像素完全相同，${pct(c.near!)} 误差 ≤2/255，最大误差 ${c.max}/255。`),
            c.effectPixels
              ? h(
                  'div',
                  null,
                  `图层样式（图案/颜色叠加，占画面 ${pct(c.effectPixels)}）：${pct(c.effectSame!)} 完全相同，最大误差 ${c.effectMax}/255。`,
                )
              : null,
            h(
              'div',
              { class: 'hint' },
              '残余差异来自 Photoshop 未公开的图案缩放算法，以及半透明边缘的内部取整，肉眼不可见。',
            ),
          )
        : h('div', { class: 'notice info' }, '这个 PSD 没有保存合成图（保存时未勾选「最大兼容」），无法比对。'),
    );
  }

  bulkHost = h('div', { class: 'bulk-host' });
  root.appendChild(bulkHost);

  // search + visibility tools. Searching only re-renders the tree below: the
  // input itself is never replaced, so it keeps focus and the phone keyboard
  // stays put.
  const tools = h('div', { class: 'row tree-tools' });
  const search = h('input', {
    type: 'search',
    class: 'search',
    placeholder: '搜索图层或组名…',
    value: s.search,
    oninput: (e: Event) => {
      const v = (e.target as HTMLInputElement).value;
      clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        store.setSearchQuiet(v);
        renderTree();
      }, 150);
    },
  });
  tools.appendChild(search);
  resetHost = h('span', { class: 'reset-host' });
  tools.appendChild(resetHost);
  root.appendChild(tools);

  treeHost = h('div', { class: 'tree' });
  root.appendChild(treeHost);
  renderTree();
  patchLayersPanel();

  root.appendChild(
    h(
      'div',
      { class: 'hint', style: 'margin-top:10px' },
      '图例：睁眼 = 正在显示；黄色睁眼 = 自身打开但上级组隐藏；闭眼 = 隐藏。图层名后的蓝色标签表示它属于哪个选项组；「整体」组可以展开查看，但里面的图层不能拆开当选项。',
    ),
  );
  return root;
}

/* ---- in-place updates: ticking a row or toggling an eye never rebuilds the panel ---- */

interface RowRef {
  layer: LayerNode;
  row: HTMLElement;
  chk: HTMLInputElement | null;
  eye: HTMLElement;
}
let rowRefs = new Map<string, RowRef>();
let treeHost: HTMLElement | null = null;
let bulkHost: HTMLElement | null = null;
let resetHost: HTMLElement | null = null;
let shownPill: HTMLElement | null = null;

function renderTree(): void {
  const s = store.state;
  const p = s.project!;
  if (!treeHost) return;
  rowRefs = new Map();
  const q = s.search.trim().toLowerCase();
  matches = q ? matchingNodes(q) : null;
  const frag = document.createDocumentFragment();
  for (const r of rootsTopFirst(p)) {
    const el = renderNode(r, 0, false);
    if (el) frag.appendChild(el);
  }
  treeHost.replaceChildren(frag);
  if (q && !treeHost.childElementCount) treeHost.appendChild(h('div', { class: 'hint', style: 'padding:10px' }, `没有找到包含「${s.search}」的图层`));
}

function rowClass(layer: LayerNode, st: string): string {
  return `tree-row ${st}` + (store.state.checked.has(layer.id) ? ' checked' : '');
}

function paintEye(eye: HTMLElement, layer: LayerNode, st: string): void {
  const modified = store.state.project!.visibility?.[layer.id] !== undefined;
  const cls = 'eye' + (modified ? ' mod' : '') + (st === 'hidden' ? ' off' : st === 'parent-hidden' ? ' dim' : '');
  if (eye.className !== cls) eye.className = cls;
  const icon = st === 'hidden' ? 'off' : 'on';
  if (eye.dataset.icon !== icon) {
    eye.dataset.icon = icon;
    eye.innerHTML = icon === 'off' ? EYE_OFF : EYE_ON;
  }
  eye.title =
    (st === 'drawn' ? '正在显示' : st === 'parent-hidden' ? '自身打开，但上级组隐藏' : '隐藏') +
    '。点击切换显示 / 隐藏（预览和导出都按此显示）' +
    (modified ? '。已改动，与文件里保存的状态不同' : '');
}

/** Bring rows, eyes, the tick bar and counters up to date without a rebuild. */
export function patchLayersPanel(): void {
  const s = store.state;
  const p = s.project;
  if (!p || !treeHost) return;
  for (const r of rowRefs.values()) {
    const st = store.nodeState(r.layer);
    const cls = rowClass(r.layer, st);
    if (r.row.className !== cls) r.row.className = cls;
    if (r.chk && r.chk.checked !== s.checked.has(r.layer.id)) r.chk.checked = s.checked.has(r.layer.id);
    paintEye(r.eye, r.layer, st);
  }
  if (bulkHost) bulkHost.replaceChildren(...(s.checked.size > 0 ? [renderBulkBar()] : []));
  if (resetHost) {
    const changed = Object.keys(p.visibility ?? {}).length;
    resetHost.replaceChildren(
      ...(changed
        ? [h('button', { class: 'btn small', title: '撤销在这里做的显示 / 隐藏改动', onclick: () => store.resetVisibility() }, `恢复原始显示（${changed}）`)]
        : []),
    );
  }
  if (shownPill) shownPill.textContent = `当前显示 ${s.vis?.drawn.size ?? 0} 个图层`;
}

/** Which app's compositing rules are used, how well they match, and a manual override. */
function renderProfileCard(): HTMLElement {
  const s = store.state;
  const p = s.project!;
  const active = store.activeProfile();
  const cal = s.calibration;
  const card = h('div', { class: 'card profile-card' });
  card.appendChild(
    h(
      'div',
      { class: 'field' },
      h('label', null, '合成方式'),
      h(
        'select',
        { onchange: (e: Event) => void store.chooseProfile((e.target as HTMLSelectElement).value as any) },
        h('option', { value: 'auto', selected: !p.settings.profile }, `自动识别（${store.PROFILE_LABEL[cal?.profile ?? 'photoshop']}）`),
        ...(Object.keys(store.PROFILE_LABEL) as (keyof typeof store.PROFILE_LABEL)[]).map((id) =>
          h('option', { value: id, selected: p.settings.profile === id }, store.PROFILE_LABEL[id]),
        ),
      ),
    ),
  );
  let text: string;
  if (/^ibisPaint/i.test(s.writer)) {
    const sc = cal?.scores.find((x) => x.profile === active);
    text =
      `爱笔思画作品（${s.writer.replace(/^ibisPaint\s*/i, '')}）：图层、图层组、混合模式和不透明度直接从 .ipv 读取。` +
      (sc ? `与作品自带的合成图比对：抽样像素 ${(sc.same * 100).toFixed(1)}% 完全相同。` : '');
  } else if (cal?.reason === 'photoshop-file') text = `这个 PSD 由 ${s.writer || 'Photoshop'} 保存，按 Photoshop 的算法合成，导出图与 Photoshop 一致。`;
  else if (cal?.reason === 'measured') {
    const sc = cal.scores.find((x) => x.profile === active);
    text =
      `文件由其他绘画软件保存。已用各软件的合成规则试算，与文件里该软件自己保存的合成图比较后选择最接近的一种` +
      (sc ? `：抽样 ${Math.round(cal.sampledPixels / 1000)}k 像素中 ${(sc.same * 100).toFixed(1)}% 完全相同，平均误差 ${sc.mean.toFixed(2)}/255。` : '。');
  } else text = '无法自动识别（文件没有保存合成图），默认使用 Photoshop 算法；如果这个文件来自其他软件，可以手动选择。';
  card.appendChild(h('div', { class: 'hint' }, text));
  return card;
}

function renderBulkBar(): HTMLElement {
  const s = store.state;
  const p = s.project!;
  const bar = h('div', { class: 'bulk' });
  bar.appendChild(
    h(
      'div',
      { class: 'row', style: 'gap:6px' },
      h('b', null, `已勾选 ${s.checked.size} 项`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost small', onclick: () => (s.checked.clear(), store.notify()) }, '清除勾选'),
    ),
  );
  bar.appendChild(h('div', { class: 'hint' }, '新建选项组，每个勾选项作为一个选项：'));
  const kinds = h('div', { class: 'row wrap', style: 'gap:6px' });
  for (const k of ['exclusive', 'optional', 'multi', 'fixed'] as RuleKind[]) {
    kinds.appendChild(
      h('button', { class: 'btn small', title: KIND_INFO[k].hint, onclick: () => store.addRuleFromChecked(k, false) }, KIND_INFO[k].label),
    );
  }
  bar.appendChild(kinds);
  if (s.checked.size > 1) {
    bar.appendChild(h('div', { class: 'hint' }, '不管它们在哪个组，都让它们互相排斥（最多出现一个，可以继续加）：'));
    bar.appendChild(
      h(
        'div',
        { class: 'row wrap', style: 'gap:6px' },
        h('button', { class: 'btn small', onclick: () => store.addMutexFromChecked() }, `设为互斥（${s.checked.size} 选 ≤1）`),
      ),
    );
    bar.appendChild(h('div', { class: 'hint' }, '或者把它们合成「一个选项」（一起出现、一起消失）：'));
    bar.appendChild(
      h(
        'div',
        { class: 'row wrap', style: 'gap:6px' },
        h('button', { class: 'btn small', onclick: () => store.addRuleFromChecked('optional', true) }, '新组（可选一项）'),
        h('button', { class: 'btn small', onclick: () => store.addRuleFromChecked('fixed', true) }, '固定显示'),
      ),
    );
  }
  if (p.rules.length) {
    const sel = h(
      'select',
      {
        onchange: (e: Event) => {
          const v = (e.target as HTMLSelectElement).value;
          if (!v) return;
          const [ruleId, mode] = v.split('|');
          store.addCheckedToRule(ruleId, mode === 'one');
        },
      },
      h('option', { value: '' }, '加入已有选项组…'),
      ...p.rules.flatMap((r) => [
        h('option', { value: `${r.id}|each` }, `「${r.name}」：每项一个新选项`),
        s.checked.size > 1 ? h('option', { value: `${r.id}|one` }, `「${r.name}」：合成一个新选项`) : null,
      ]).filter(Boolean) as HTMLElement[],
    );
    bar.appendChild(sel);
  }
  return bar;
}

// eye icons (Feather, MIT)
const SVG = (body: string) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const EYE_ON = SVG('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>');
const EYE_OFF = SVG(
  '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
);

/** Auto-detect card: option groups proposed from the layer structure. */
function renderSuggestions(): HTMLElement | null {
  const s = store.state;
  const list = store.suggestions();
  if (!list.length) return null;
  if (s.suggestOff) {
    return h(
      'button',
      { class: 'btn ghost small', style: 'align-self:flex-start', onclick: () => store.dismissSuggestions(false) },
      `✨ 智能识别（${list.length} 条建议）`,
    );
  }
  const card = h('div', { class: 'card suggest col' });
  card.appendChild(
    h(
      'div',
      { class: 'row', style: 'gap:6px' },
      h('b', null, `✨ 智能识别：找到 ${list.length} 个可能的选项组`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost small', title: '收起建议（之后可以再打开）', onclick: () => store.dismissSuggestions(true) }, '收起'),
    ),
  );
  card.appendChild(
    h('div', { class: 'hint' }, '按图层的分组方式推测。勾选想要的，类型可以改，再点下面的按钮一次创建；不确定的可以先不勾，之后随时在这里或「选项组」页添加。'),
  );
  const picked = list.filter((sg) => store.suggestionPicked(sg).on).length;
  const total = store.suggestionCount();
  card.appendChild(
    h(
      'div',
      { class: 'row wrap', style: 'gap:6px;align-items:center' },
      h(
        'button',
        { class: 'btn primary small', disabled: !picked, onclick: () => store.applySuggestions() },
        picked ? `创建勾选的 ${picked} 个选项组` : '先勾选要创建的组',
      ),
      picked ? h('span', { class: total > 500 ? 'pill warn' : 'pill' }, `合计约 ${total} 张图`) : null,
    ),
  );
  for (const sg of list) {
    const pick = store.suggestionPicked(sg);
    const row = h('div', { class: 'sg' + (pick.on ? ' on' : '') });
    row.appendChild(
      h(
        'label',
        { class: 'sg-head' },
        h('input', { type: 'checkbox', checked: pick.on, onchange: (e: Event) => store.setSuggestPick(sg.key, { on: (e.target as HTMLInputElement).checked }) }),
        h('b', null, sg.name),
        h(
          'select',
          {
            class: 'small-select',
            title: KIND_INFO[pick.kind].hint,
            onclick: (e: Event) => e.stopPropagation(),
            onchange: (e: Event) => store.setSuggestPick(sg.key, { kind: (e.target as HTMLSelectElement).value as RuleKind, on: true }),
          },
          ...(['exclusive', 'optional', 'multi'] as RuleKind[]).map((k) => h('option', { value: k, selected: k === pick.kind }, KIND_INFO[k].label)),
        ),
      ),
    );
    row.appendChild(h('div', { class: 'sg-opts' }, sg.optionNames.join(' / ')));
    row.appendChild(
      h('div', { class: 'hint' }, sg.why + (sg.shared.length ? `；${sg.shared.map((n) => `「${n}」`).join('')}作为共用部分一直显示` : '')),
    );
    card.appendChild(row);
  }
  return card;
}

let searchTimer: number | undefined;
/** nodes to show while searching: matches and their ancestors (null = no search) */
let matches: Set<string> | null = null;

function matchingNodes(q: string): Set<string> {
  const p = store.state.project!;
  const out = new Set<string>();
  for (const l of p.layers) {
    if (!(l.cleanName.toLowerCase().includes(q) || l.name.toLowerCase().includes(q))) continue;
    for (let cur: string | null = l.id; cur; cur = p.layerIndex[cur]?.parentId ?? null) out.add(cur);
  }
  return out;
}

function renderNode(layer: LayerNode, depth: number, inPart: boolean): HTMLElement | null {
  const s = store.state;
  if (matches && !matches.has(layer.id)) return null;
  const wrap = h('div', null);
  const isGroup = layer.kind === 'group';
  const atomic = isGroup && store.isAtomic(layer.id);
  const st = store.nodeState(layer);
  const row = h('div', { class: rowClass(layer, st), 'data-id': layer.id });

  // eye first, in one column for every row (like Photoshop)
  const eye = h('button', {
    class: 'eye',
    onclick: (e: Event) => {
      e.stopPropagation();
      store.toggleLayerVisible(layer.id);
    },
  });
  paintEye(eye, layer, st);
  row.appendChild(eye);

  // layers inside a part group can't be picked on their own
  let chk: HTMLInputElement | null = null;
  if (inPart) row.appendChild(h('span', { class: 'chk-space' }));
  else {
    chk = h('input', {
      type: 'checkbox',
      class: 'chk',
      checked: s.checked.has(layer.id),
      onclick: (e: Event) => e.stopPropagation(),
      onchange: () => store.toggleChecked(layer.id),
    }) as HTMLInputElement;
    row.appendChild(chk);
  }
  if (depth) row.appendChild(h('span', { class: 'indent', style: `width:${depth * 14}px` }));
  const open = isGroup && (atomic ? store.isPartExpanded(layer.id) : !s.collapsed.has(layer.id) || !!matches);
  if (isGroup && layer.children.length) {
    row.appendChild(
      h(
        'button',
        {
          class: 'twisty',
          title: open ? '收起' : atomic ? '展开查看组内图层' : '展开',
          onclick: (e: Event) => {
            e.stopPropagation();
            if (atomic) store.togglePartExpanded(layer.id);
            else store.toggleCollapsed(layer.id);
          },
        },
        open ? '▾' : '▸',
      ),
    );
  }
  rowRefs.set(layer.id, { layer, row, chk, eye });

  const thumb = s.thumbs.get(layer.id);
  row.appendChild(
    isGroup
      ? h('span', { class: 'thumb folder' }, '📁')
      : thumb
      ? h('img', { class: 'thumb', src: thumb, alt: '' })
      : h('span', { class: 'thumb empty' }),
  );

  const nameBox = h('span', { class: 'name', title: layer.name });
  if (layer.clipping) nameBox.appendChild(h('span', { class: 'clipmark', title: '剪贴蒙版' }, '↳'));
  nameBox.appendChild(document.createTextNode(layer.cleanName));
  row.appendChild(nameBox);

  const badges = h('span', { class: 'badges' });
  for (const label of store.optionsOfLayer(layer.id)) badges.appendChild(h('span', { class: 'optchip' }, label));
  for (const t of layer.tags) {
    badges.appendChild(
      h('span', { class: 'tagchip' + (t.ignore ? ' ign' : '') }, t.ignore ? `#${t.name}` : t.group === null ? `[${t.name}]` : `[${t.name}@${t.group}]`),
    );
  }
  if (layer.blendMode !== 'normal' && !(isGroup && layer.blendMode === 'pass through'))
    badges.appendChild(h('span', { class: 'mini' }, BLEND_CN[layer.blendMode] ?? layer.blendMode));
  if (layer.opacity < 0.999) badges.appendChild(h('span', { class: 'mini' }, `${Math.round(layer.opacity * 100)}%`));
  if (layer.fill < 0.999) badges.appendChild(h('span', { class: 'mini' }, `填充 ${Math.round(layer.fill * 100)}%`));
  if (layer.hasMask) badges.appendChild(h('span', { class: 'mini' }, '蒙版'));
  for (const e of layer.effects) badges.appendChild(h('span', { class: 'mini' }, e));
  if (layer.unsupported.length)
    badges.appendChild(h('span', { class: 'mini warn', title: `无法完全还原：${layer.unsupported.join('、')}` }, '⚠'));
  if (atomic) badges.appendChild(h('span', { class: 'mini atomic', title: '整体组：内部图层一起显示、一起隐藏，不能拆开选' }, `整体 · ${layer.children.length} 层`));
  row.appendChild(badges);

  if (isGroup && layer.children.length && !inPart) {
    row.appendChild(
      h(
        'button',
        {
          class: 'btn ghost small act' + (atomic ? ' on' : ''),
          title: atomic ? '取消整体：可以单独选择组内的图层' : '设为整体：组内的线稿、底色、高光等一起显示，不能拆开',
          onclick: (e: Event) => {
            e.stopPropagation();
            store.toggleAtomic(layer.id);
          },
        },
        atomic ? '🔒' : '🔓',
      ),
    );
  }
  if (isGroup && layer.children.length && !atomic && !inPart) {
    row.appendChild(
      h(
        'button',
        {
          class: 'btn ghost small act',
          title: '把这个组的每个子图层设为一个选项（必选一项），例如 发型 → 短发 / 长发',
          onclick: (e: Event) => {
            e.stopPropagation();
            store.addRuleFromGroup(layer.id, 'exclusive');
          },
        },
        '⇢ ',
        h('span', { class: 'long' }, '子项作选项'),
        h('span', { class: 'short' }, '子项'),
      ),
    );
  }
  if (!inPart) row.addEventListener('click', () => store.toggleChecked(layer.id));
  else if (isGroup) row.addEventListener('click', () => store.togglePartExpanded(layer.id));
  wrap.appendChild(row);

  if (open) {
    for (const c of [...layer.children].reverse()) {
      const el = renderNode(c, depth + 1, inPart || atomic);
      if (el) wrap.appendChild(el);
    }
  }
  return wrap;
}
