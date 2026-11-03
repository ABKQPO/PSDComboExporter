/**
 * Node workflow view (Blender-style) over the same data as the list pages:
 *
 *   [layers] drawer ──drag──▶ [option group] ●──▶ [product] ──▶ [export N]
 *                              option ●──▶ [mutex: at most one] ◀── option ●
 *
 * - dragging a layer or a FOLDER onto a group adds ONE option (a folder is one
 *   variant, not one variant per layer); onto empty canvas = new group
 * - a group's dot onto the product node = takes part; ✕ there = not
 * - option dot onto another option = "can't appear together"; onto a rule
 *   node = add it to that rule (any number of items)
 *
 * Layout is measured (nodes are rendered, then placed) so nothing overlaps,
 * and every edge is drawn from the real centre of its two dots.
 */

import * as store from './store';
import { h } from './dom';
import { KIND_INFO } from './rulesPanel';
import { startExport } from './exportPanel';
import { openTextFile, saveTextFile } from '../core/platform';
import type { Constraint, LayerNode, NodeBundle, NodeNote, Project, Rule, RuleKind, Target } from '../core/model';

type Pos = { x: number; y: number };
type Size = { w: number; h: number };

let root: HTMLElement | null = null;
let viewport: HTMLElement;
let world: HTMLElement;
let svg: SVGSVGElement;
let wireEl: SVGPathElement;
let nodesHost: HTMLElement;
let countPill: HTMLElement;
let mini: HTMLCanvasElement;
let helpBox: HTMLElement;
let drawer: HTMLElement;
let drawerList: HTMLElement;
let ghost: HTMLElement;
let drawerQuery = '';
const drawerOpen = new Set<string>();
/** layers picked in the drawer (Ctrl / Shift click, or the multi-select switch on phones) */
const drawerSel = new Set<string>();
let drawerMulti = false;
let drawerAnchor: string | null = null;
let undoBtn: HTMLButtonElement;
let redoBtn: HTMLButtonElement;

const view = { x: 24, y: 24, s: 1 };
let busy = false; // dragging something: rebuild later
let rebuildPending = false;
let fitPending = true;
let edges: { from: string; to: string; cls: string }[] = [];
const ports = new Map<string, HTMLElement>();

const SVGNS = 'http://www.w3.org/2000/svg';
const GAP = 26;

/* Mounting */

/** Called on every app render. */
export function syncNodeEditor(dirty: boolean): void {
  const s = store.state;
  const want = s.nodeEditorOpen && !!s.project;
  if (!want) {
    if (root?.isConnected) root.remove();
    fitPending = true;
    return;
  }
  if (!root) build();
  if (!root!.isConnected) {
    document.body.appendChild(root!);
    dirty = true;
  }
  if (dirty) {
    if (busy) rebuildPending = true;
    else rebuild();
  }
  updateCounts();
  mini.style.display = store.state.prefs.miniPreview ? '' : 'none';
  drawMini();
}

function build(): void {
  root = h('div', { class: 'node-editor' });
  const bar = h('div', { class: 'ne-bar' });
  bar.appendChild(h('b', { class: 'ne-title' }, '节点'));
  countPill = h('span', { class: 'pill ok' }, '');
  bar.appendChild(countPill);
  undoBtn = h('button', { class: 'btn small', title: '撤回（Ctrl+Z）', onclick: () => store.undo() }, '↶', h('span', { class: 'ne-lbl' }, ' 撤回')) as HTMLButtonElement;
  redoBtn = h('button', { class: 'btn small', title: '重做（Ctrl+Y / Ctrl+Shift+Z）', onclick: () => store.redo() }, '↷', h('span', { class: 'ne-lbl' }, ' 重做')) as HTMLButtonElement;
  bar.appendChild(undoBtn);
  bar.appendChild(redoBtn);
  bar.appendChild(h('button', { class: 'btn small', title: '清空画布上的全部节点（可以撤回）', onclick: () => store.clearCanvas() }, '清空'));
  bar.appendChild(h('span', { class: 'ne-sep' }));
  bar.appendChild(h('button', { class: 'btn small', title: '打开图层列表：把图层 / 文件夹拖到选项组上', onclick: () => toggleDrawer() }, '图层'));
  bar.appendChild(h('button', { class: 'btn small', title: '添加节点：选项组 / 互斥 / 依赖 / 便签 / 预览', onclick: (e: Event) => addMenu(e.currentTarget as HTMLElement) }, '+ 添加'));
  bar.appendChild(h('button', { class: 'btn small', title: '常用的示例设置', onclick: (e: Event) => presetMenu(e.currentTarget as HTMLElement) }, '示例'));
  bar.appendChild(h('button', { class: 'btn small ghost', title: '从 .json 配置文件导入（选项组、规则、节点位置…）', onclick: () => void importConfig() }, '导入'));
  bar.appendChild(h('button', { class: 'btn small ghost', title: '把当前设置保存成 .json 配置文件，换一个 PSD 也能用', onclick: () => void exportConfig() }, '导出'));
  bar.appendChild(h('span', { class: 'spacer' }));
  bar.appendChild(h('button', { class: 'btn small ghost', title: '重新排列全部节点', onclick: () => ((fitPending = true), store.resetNodeLayout()) }, '自动排列'));
  bar.appendChild(h('button', { class: 'btn small ghost', title: '缩放到能看到全部节点', onclick: () => fit() }, '适应'));
  bar.appendChild(h('button', { class: 'btn small ghost', onclick: () => helpBox.classList.toggle('show') }, '怎么用'));
  bar.appendChild(h('button', { class: 'btn small', onclick: () => store.setNodeEditor(false) }, '回到列表'));
  root.appendChild(bar);

  const body = h('div', { class: 'ne-body' });
  drawer = h('div', { class: 'ne-drawer' });
  drawer.appendChild(
    h(
      'div',
      { class: 'ne-drawer-head' },
      h('input', {
        type: 'search',
        class: 'ne-search',
        placeholder: '搜索图层…',
        oninput: (e: Event) => {
          drawerQuery = (e.target as HTMLInputElement).value.trim().toLowerCase();
          renderDrawer();
        },
      }),
      (drawerMultiBtn = h(
        'button',
        {
          class: 'btn small ne-multi',
          title: '多选：点一下选中 / 取消，再拖其中一个 = 一起拖进去',
          onclick: () => {
            drawerMulti = !drawerMulti;
            if (!drawerMulti) drawerSel.clear();
            renderDrawer();
          },
        },
        '多选',
      )),
      h('button', { class: 'ne-x', title: '收起', onclick: () => toggleDrawer(false) }, '✕'),
    ),
  );
  drawer.appendChild(h('div', { class: 'ne-drawer-hint' }, '拖到选项组上 = 加一个选项（文件夹整体算一个差分）；拖到空白处 = 新建选项组。按住 Ctrl 点 = 多选，Shift 点 = 连选；手机打开「多选」后点一下就是选中，再拖其中一个 = 一起拖'));
  drawerSelBar = h('div', { class: 'ne-selbar' });
  drawer.appendChild(drawerSelBar);
  drawerList = h('div', { class: 'ne-drawer-list' });
  drawer.appendChild(drawerList);
  body.appendChild(drawer);

  viewport = h('div', { class: 'ne-viewport' });
  world = h('div', { class: 'ne-world' });
  svg = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
  svg.setAttribute('class', 'ne-edges');
  wireEl = document.createElementNS(SVGNS, 'path') as SVGPathElement;
  wireEl.setAttribute('class', 'ne-wire');
  nodesHost = h('div', { class: 'ne-nodes' });
  world.append(svg, nodesHost);
  viewport.appendChild(world);
  body.appendChild(viewport);
  root.appendChild(body);

  helpBox = h(
    'div',
    { class: 'ne-help' },
    h('b', null, '节点工作流'),
    h('div', null, '• 「图层」打开图层列表：把图层或文件夹拖到选项组上 = 加一个选项（整个文件夹算一个差分）；拖到空白处 = 新建选项组。'),
    h('div', null, '• 点选项组里的一行 = 选中它，左下角小图实时预览。✕ 删除选项 / 选项组，点一下组名就能改名。'),
    h('div', null, '• 选项组标题右边的圆点连到「组合 ×」= 参与组合；「组合 ×」里会写清楚每组乘了几、为什么。'),
    h('div', null, '• 从选项（或选项组标题）右边的圆点拖到另一个选项 / 选项组上，会问你要「互斥」还是「依赖」。互斥 = 放进去的东西在同一张图里最多出现一个，例如「鱼尾」和「长发」不能同框；依赖 = 有 A 时必须有 B。'),
    h('div', null, '• 左上角：撤回 / 重做（Ctrl+Z / Ctrl+Y）、清空画布。「+ 添加」可以加选项组、互斥、依赖、便签、预览；「示例」一键套用常用设置；「导入 / 导出」保存或读取 .json 配置。'),
    h('div', null, '• 图层包：几个图层一起显示、算一个选项。把图层拖进图层包，再把它右边的 ● 连到选项组左边的 ●，它就成了这个组的一个选项。'),
    h('div', null, '• 图层列表多选：电脑按住 Ctrl 点 = 多选，Shift 点 = 连选；手机点「多选」再点图层。拖其中任意一个 = 一起拖进去，每个都是一个选项。'),
    h('div', null, '• 断开连线：点一下线 →「断开」；或者按住线头的圆点把线拖走，放到空白处就断开，放到别处就改接过去。'),
    h('div', null, '• 按住节点标题（⠿ 或名字）拖动节点；拖空白处平移；滚轮或双指缩放。'),
  );
  root.appendChild(helpBox);

  mini = h('canvas', { class: 'ne-mini', title: '当前选择的预览（点一下放大 / 缩小）' }) as HTMLCanvasElement;
  viewport.appendChild(mini);
  ghost = h('div', { class: 'ne-ghost' });
  root.appendChild(ghost);

  installGestures();
  installDrawerDrag();
  document.addEventListener('keydown', (e) => {
    if (!root?.isConnected || !(e.ctrlKey || e.metaKey)) return;
    const t = e.target;
    if (t instanceof Element && t.closest('input, textarea, select, [contenteditable]')) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) store.undo();
    else if (k === 'y' || (k === 'z' && e.shiftKey)) store.redo();
    else return;
    e.preventDefault();
  });
  new ResizeObserver(() => drawEdges()).observe(viewport);
  nodeSizes = new ResizeObserver(() => scheduleEdges());
  void document.fonts?.ready.then(() => scheduleEdges());
}

let nodeSizes: ResizeObserver | null = null;

function toggleDrawer(open?: boolean): void {
  const on = open ?? !drawer.classList.contains('open');
  drawer.classList.toggle('open', on);
  if (on) renderDrawer();
  // the canvas changed size: show everything again
  requestAnimationFrame(() => fit());
  setTimeout(() => fit(), 60);
}

/* Layer drawer */

function usedBy(): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of store.state.project!.rules) for (const o of r.options) for (const id of o.layerIds) m.set(id, r.name);
  return m;
}

let drawerSelBar: HTMLElement;
let drawerMultiBtn: HTMLElement;

function renderDrawer(): void {
  if (!drawer.classList.contains('open')) return;
  drawerMultiBtn.classList.toggle('on', drawerMulti);
  drawerSelBar.replaceChildren();
  drawerSelBar.classList.toggle('show', drawerSel.size > 0);
  if (drawerSel.size) {
    drawerSelBar.append(
      h('span', null, `已选 ${drawerSel.size} 个：拖其中任意一个 = 一起拖进去`),
      h(
        'button',
        {
          class: 'btn small ghost',
          onclick: () => {
            drawerSel.clear();
            renderDrawer();
          },
        },
        '清除',
      ),
    );
  }
  const p = store.state.project!;
  const used = usedBy();
  const q = drawerQuery;
  const frag = document.createDocumentFragment();
  const show = (l: LayerNode): boolean => !q || l.cleanName.toLowerCase().includes(q) || (l.kind === 'group' && l.children.some(show));
  const walk = (list: LayerNode[], depth: number) => {
    for (const l of [...list].reverse()) {
      if (!show(l)) continue;
      const part = l.kind === 'group' && store.isAtomic(l.id);
      const open = l.kind === 'group' && !part && (drawerOpen.has(l.id) || !!q);
      const thumb = l.kind === 'layer' ? store.state.thumbs.get(l.id) : undefined;
      const row = h(
        'div',
        { class: 'ne-item' + (used.has(l.id) ? ' used' : '') + (drawerSel.has(l.id) ? ' sel' : ''), 'data-layer': l.id, style: `padding-left:${6 + depth * 12}px`, title: '拖到选项组上（Ctrl / Shift 点可以多选）' },
        l.kind === 'group' && !part
          ? h(
              'button',
              {
                class: 'ne-tw',
                onclick: (e: Event) => {
                  e.stopPropagation();
                  if (drawerOpen.has(l.id)) drawerOpen.delete(l.id);
                  else drawerOpen.add(l.id);
                  renderDrawer();
                },
              },
              open ? '▾' : '▸',
            )
          : h('span', { class: 'ne-tw' }),
        drawerMulti ? h('span', { class: 'ne-check' }, drawerSel.has(l.id) ? '☑' : '☐') : null,
        thumb ? h('img', { class: 'ne-thumb', src: thumb, alt: '' }) : h('span', { class: 'ne-thumb' }, l.kind === 'group' ? '📁' : ''),
        h('span', { class: 'ne-label' }, l.cleanName),
        part ? h('span', { class: 'mini atomic' }, '整体') : null,
        used.has(l.id) ? h('span', { class: 'ne-used' }, `✓ ${used.get(l.id)}`) : null,
        l.kind === 'group' && l.children.length > 1
          ? h(
              'button',
              {
                class: 'ne-x',
                title: '把这个文件夹里的每个子文件夹 / 图层各做成一个选项，新建选项组',
                onclick: (e: Event) => {
                  e.stopPropagation();
                  store.createRuleFromFolder(l.id);
                },
              },
              '拆',
            )
          : null,
      );
      frag.appendChild(row);
      if (open) walk(l.children, depth + 1);
    }
  };
  walk(p.layers.filter((l) => !l.parentId), 0);
  drawerList.replaceChildren(frag);
}

/** Ctrl = toggle, Shift = range from the last clicked row, multi-select switch = toggle. */
function pickInDrawer(id: string, ctrl: boolean, shift: boolean): void {
  if (shift && drawerAnchor) {
    const rows = [...drawerList.querySelectorAll<HTMLElement>('.ne-item')].map((r) => r.dataset.layer!);
    const a = rows.indexOf(drawerAnchor);
    const b = rows.indexOf(id);
    if (a >= 0 && b >= 0) {
      if (!ctrl) drawerSel.clear();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) drawerSel.add(rows[i]);
    }
  } else if (ctrl || drawerMulti) {
    if (drawerSel.has(id)) drawerSel.delete(id);
    else drawerSel.add(id);
    drawerAnchor = id;
  } else {
    // a plain click picks just this row, like a file manager
    const only = drawerSel.size === 1 && drawerSel.has(id);
    drawerSel.clear();
    if (!only) drawerSel.add(id);
    drawerAnchor = id;
  }
  renderDrawer();
}

/** What a drag from this row carries: the whole selection if the row is in it. */
function dragSet(id: string): string[] {
  if (!drawerSel.has(id)) return [id];
  const rows = [...drawerList.querySelectorAll<HTMLElement>('.ne-item')].map((r) => r.dataset.layer!);
  const inList = rows.filter((r) => drawerSel.has(r));
  // picked rows hidden by a collapsed folder / search still count
  return [...inList, ...[...drawerSel].filter((x) => !inList.includes(x))];
}

function installDrawerDrag(): void {
  let drag: { id: string; sx: number; sy: number; moved: boolean; ctrl: boolean; shift: boolean } | null = null;
  drawerList.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('button')) return;
    const item = t.closest<HTMLElement>('.ne-item');
    if (!item) return;
    drag = { id: item.dataset.layer!, sx: e.clientX, sy: e.clientY, moved: false, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
    busy = true;
    try {
      drawerList.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  });
  drawerList.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 6) return;
    if (!drag.moved) {
      drag.moved = true;
      const ids = dragSet(drag.id);
      ghost.textContent = ids.length > 1 ? `${ids.length} 个图层 / 文件夹` : store.state.project!.layerIndex[drag.id]?.cleanName ?? '';
      ghost.classList.add('show');
    }
    ghost.style.left = `${e.clientX + 12}px`;
    ghost.style.top = `${e.clientY + 8}px`;
    e.preventDefault();
  });
  const up = (e: PointerEvent) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    ghost.classList.remove('show');
    busy = false;
    if (d.moved) {
      const ids = dragSet(d.id);
      dropLayers(ids, e.clientX, e.clientY);
      drawerSel.clear();
    } else pickInDrawer(d.id, d.ctrl, d.shift);
    if (rebuildPending) rebuild();
  };
  drawerList.addEventListener('pointerup', up);
  drawerList.addEventListener('pointercancel', up);
}

/** Layers from the drawer dropped at (x, y): each one is one option. */
function dropLayers(ids: string[], x: number, y: number): void {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el || !viewport.contains(el)) return;
  const bun = el.closest<HTMLElement>('.ne-node.bundle');
  if (bun) return store.bundleAddLayers(bun.dataset.node!, ids);
  const group = el.closest<HTMLElement>('.ne-node.group');
  if (group) return ids.length === 1 ? store.addLayerOption(group.dataset.node!, ids[0]) : store.addLayerOptions(group.dataset.node!, ids);
  const con = el.closest<HTMLElement>('.ne-node.con');
  if (con) return store.appendConstraintTargets(con.dataset.node!, ids.map((layerId) => ({ kind: 'layer' as const, layerId })));
  if (el.closest('.ne-node')) return;
  if (ids.length > 1) {
    const at = toWorld(x, y);
    showPop(x, y, `${ids.length} 个图层 / 文件夹`, [
      {
        label: '新建选项组：每个是一个选项',
        hint: '它们是同一类的不同差分（例如几种表情），一次只出现一个',
        run: () => {
          const id = store.createRuleWith(ids);
          if (id) {
            store.setNodePos(id, at.x - 20, at.y - 20);
            store.notify();
          }
        },
      },
      {
        label: '打包成图层包：一起显示，算一个选项',
        hint: '它们是一套（例如帽子 + 帽子阴影），再把图层包连到选项组左边',
        run: () => {
          const id = store.addBundle(ids);
          if (id) {
            store.setNodePos(id, at.x - 20, at.y - 20);
            store.notify();
          }
        },
        cls: 'ok',
      },
    ]);
    return;
  }
  const id = store.createRuleWith(ids);
  if (id) {
    const p = toWorld(x, y);
    store.setNodePos(id, p.x - 20, p.y - 20);
    store.notify();
    store.toast('已新建选项组；继续把同类的图层 / 文件夹拖进去，每个就是一个差分', 'ok');
  }
}

/* Creating things from the toolbar */

function viewCentre(): Pos {
  return { x: (viewport.clientWidth / 2 - view.x) / view.s - 100, y: (viewport.clientHeight / 3 - view.y) / view.s };
}

function addGroup(): void {
  const c = freeSpot(viewCentre(), 230, 150);
  const id = store.createRuleWith([]);
  if (id) {
    store.setNodePos(id, c.x, c.y);
    store.notify();
    revealAfter = id; // once it is rendered
    store.toast('空选项组已建好：点「图层」把图层 / 文件夹拖进去', 'ok');
    toggleDrawer(true);
  }
}

function anchorOf(btn: HTMLElement): Pos {
  const r = btn.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.bottom - 6 };
}

function addMenu(btn: HTMLElement): void {
  const a = anchorOf(btn);
  showPop(a.x, a.y, '添加节点', [
    { label: '选项组', hint: '同类的几个差分放一组（例如 3 种表情）；把图层拖进去', run: () => addGroup() },
    { label: '互斥', hint: '拖进来的东西在同一张图里最多出现一个（例如鱼尾和长发不同框）', run: () => addMutex(), cls: 'danger' },
    { label: '依赖', hint: '有 A 的图里必须也有 B（例如有眼镜就必须是正脸）', run: () => addRequire(), cls: 'ok' },
    { label: '图层包', hint: '几个图层一起显示、算一个选项：把图层拖进去，再把它连到选项组左边的 ●', run: () => addBundleNode() },
    { label: '便签', hint: '在画布上写备注，跟着设置一起保存和导出', run: () => addNoteNode('note') },
    { label: '预览', hint: '一个更大的实时预览，看当前选择的效果', run: () => addNoteNode('preview') },
  ]);
}

function presetMenu(btn: HTMLElement): void {
  const a = anchorOf(btn);
  showPop(
    a.x,
    a.y,
    '示例设置（都可以撤回）',
    store.PRESETS.map((ps) => ({ label: ps.label, hint: ps.hint, run: () => ((fitPending = true), store.applyPreset(ps.key)) })),
  );
}

function addRequire(): void {
  const c = freeSpot(viewCentre(), 230, 170);
  const id = store.addEmptyMutex('require');
  if (id) {
    store.setNodePos(id, c.x, c.y);
    store.notify();
    revealAfter = id;
    store.toast('依赖节点已建好：先把 A 的 ●（选项或选项组标题右边）拖进来，再拖 B', 'ok');
  }
}

function addNoteNode(kind: 'note' | 'preview'): void {
  const c = freeSpot(viewCentre(), 250, kind === 'note' ? 150 : 300);
  const id = store.addNote(kind);
  if (id) {
    store.setNodePos(id, c.x, c.y);
    store.notify();
    revealAfter = id;
  }
}

function addBundleNode(): void {
  const c = freeSpot(viewCentre(), 240, 140);
  const id = store.addBundle([]);
  if (id) {
    store.setNodePos(id, c.x, c.y);
    store.notify();
    revealAfter = id;
    store.toast('图层包已建好：从「图层」把图层拖进去（可以多选），再把它右边的 ● 连到选项组左边的 ●', 'ok');
    toggleDrawer(true);
  }
}

async function exportConfig(): Promise<void> {
  const p = store.state.project!;
  try {
    const where = await saveTextFile(`${p.name.replace(/\.[^.]+$/, '')}-导出配置.json`, store.exportConfigText());
    if (where !== null) store.toast(where ? `配置已保存：${where}` : '配置已保存', 'ok');
  } catch (err) {
    store.toast(`保存配置失败：${(err as Error).message}`, 'bad');
  }
}

async function importConfig(): Promise<void> {
  try {
    const file = await openTextFile('.json');
    if (!file) return;
    fitPending = true;
    store.importConfigText(file.text);
  } catch (err) {
    store.toast(`导入配置失败：${(err as Error).message}`, 'bad');
  }
}

function addMutex(): void {
  const c = freeSpot(viewCentre(), 230, 170);
  const id = store.addEmptyMutex();
  if (id) {
    store.setNodePos(id, c.x, c.y);
    store.notify();
    revealAfter = id; // once it is rendered
    store.toast('互斥节点已建好：按住选项（或选项组标题）右边的圆点，拖到这个节点上。放进来的东西在同一张图里最多出现一个', 'ok');
  }
}

/** Scroll a node into view only if it is off screen. */
function revealIfHidden(id: string): void {
  const n = nodesHost.querySelector<HTMLElement>(`[data-node="${id}"]`);
  if (!n) return;
  const r = n.getBoundingClientRect();
  const v = viewport.getBoundingClientRect();
  // pan as little as possible so the whole node is on screen
  const m = 16;
  let dx = 0;
  let dy = 0;
  if (r.right > v.right - m) dx = v.right - m - r.right;
  if (r.left + dx < v.left + m) dx = v.left + m - r.left;
  if (r.bottom > v.bottom - m) dy = v.bottom - m - r.bottom;
  if (r.top + dy < v.top + m) dy = v.top + m - r.top;
  if (!dx && !dy) return;
  view.x += dx;
  view.y += dy;
  applyView();
  drawEdges();
}

/* Nodes */

function rebuild(): void {
  const s = store.state;
  const p = s.project!;
  rebuildPending = false;
  ports.clear();
  edges = [];
  const frag = document.createDocumentFragment();
  for (const r of p.rules) frag.appendChild(groupNode(r));
  for (const c of p.constraints) frag.appendChild(constraintNode(c));
  frag.appendChild(combineNode(p));
  frag.appendChild(exportNode());
  for (const n of p.nodeNotes ?? []) frag.appendChild(noteNode(n));
  for (const b of p.nodeBundles ?? []) frag.appendChild(bundleNode(b));
  nodesHost.replaceChildren(frag);
  nodeSizes?.disconnect();
  for (const n of nodesHost.children) nodeSizes?.observe(n);

  // measure, then place: saved positions win, the rest is laid out without overlap
  const nodes = [...nodesHost.children] as HTMLElement[];
  const sizes = new Map<string, Size>(nodes.map((n) => [n.dataset.node!, { w: n.offsetWidth, h: n.offsetHeight }]));
  const auto = autoLayout(p, sizes);
  // notes / previews: a row under everything else
  const bottom = Math.max(0, ...Object.entries(auto).map(([id, q]) => q.y + (sizes.get(id)?.h ?? 0)));
  let nx = 0;
  for (const n of p.nodeNotes ?? []) {
    auto[n.id] = { x: nx, y: bottom + GAP + 10 };
    nx += (sizes.get(n.id)?.w ?? 240) + 40;
  }
  // bundles: a column left of the groups, next to the group they feed
  let floor = -Infinity;
  const bundles = [...(p.nodeBundles ?? [])].sort((a, b) => (auto[a.ruleId ?? '']?.y ?? 1e9) - (auto[b.ruleId ?? '']?.y ?? 1e9));
  const bw = Math.max(0, ...bundles.map((b) => sizes.get(b.id)?.w ?? 220));
  for (const b of bundles) {
    const want = auto[b.ruleId ?? '']?.y ?? (Number.isFinite(floor) ? floor : 0);
    const y = Number.isFinite(floor) ? Math.max(floor, want) : want;
    auto[b.id] = { x: -bw - 90, y };
    floor = y + (sizes.get(b.id)?.h ?? 120) + GAP;
  }
  for (const n of nodes) {
    const id = n.dataset.node!;
    const at = p.nodeLayout?.[id] ?? auto[id] ?? { x: 0, y: 0 };
    n.style.left = `${at.x}px`;
    n.style.top = `${at.y}px`;
  }

  for (const r of p.rules) if (r.enabled && r.kind !== 'fixed') edges.push({ from: `rule:${r.id}`, to: `comb:${r.id}`, cls: 'flow' });
  if (s.exportScope !== 'current') edges.push({ from: 'comb:out', to: 'export:in', cls: 'flow' });
  for (const b of p.nodeBundles ?? []) if (b.ruleId) edges.push({ from: `bun:${b.id}`, to: `gin:${b.ruleId}`, cls: 'flow pack' });
  for (const c of p.constraints) {
    [c.a, c.b, ...(c.more ?? [])].forEach((t, i) => {
      const from = t.kind === 'option' && t.optionId ? `opt:${t.optionId}` : t.kind === 'rule' && t.ruleId ? `rule:${t.ruleId}` : '';
      if (from) edges.push({ from, to: `cin:${c.id}:${i}`, cls: (c.kind === 'mutex' ? 'mutex' : 'require') + (c.enabled ? '' : ' off') });
    });
  }
  applyView();
  if (fitPending) {
    fitPending = false;
    fit();
  } else drawEdges();
  if (revealAfter) {
    revealIfHidden(revealAfter);
    revealAfter = null;
  }
  renderDrawer();
}

function node(cls: string, id: string, target: string): HTMLElement {
  return h('div', { class: `ne-node ${cls}`, 'data-node': id, 'data-target': target });
}

function port(key: string, side: 'in' | 'out', extra = ''): HTMLElement {
  const el = h('span', { class: `ne-port ${side} ${extra}`, 'data-port': key });
  ports.set(key, el);
  return el;
}

function groupNode(r: Rule): HTMLElement {
  const s = store.state;
  const sel = s.selection[r.id] ?? [];
  const f = store.ruleFactor(r);
  const el = node('group' + (r.enabled && r.kind !== 'fixed' ? ' live' : ''), r.id, `rule:${r.id}`);
  const bundled = new Set((s.project!.nodeBundles ?? []).filter((b) => b.ruleId === r.id).map((b) => b.optionId));
  const head = h('div', { class: 'ne-head' });
  head.appendChild(port(`gin:${r.id}`, 'in', 'gin'));
  head.appendChild(h('span', { class: 'ne-grip', title: '按住拖动' }, '⠿'));
  head.appendChild(h('span', { class: 'ne-name', 'data-rename': r.id, title: '按住拖动；点一下改名' }, r.name));
  head.appendChild(
    h(
      'select',
      { class: 'ne-kind', title: KIND_INFO[r.kind].hint, onchange: (e: Event) => store.setRuleKind(r.id, (e.target as HTMLSelectElement).value as RuleKind) },
      ...(['exclusive', 'optional', 'multi', 'fixed'] as RuleKind[]).map((k) => h('option', { value: k, selected: k === r.kind }, KIND_INFO[k].label)),
    ),
  );
  head.appendChild(
    h('button', { class: 'ne-x', title: '删除这个选项组', onclick: () => confirm(`删除选项组「${r.name}」？`) && store.deleteRule(r.id) }, '✕'),
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
        h('span', { class: 'ne-label' }, '无'),
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
          title: `${o.name}${o.layerIds.length > 1 ? `（${o.layerIds.length} 个图层一起）` : ''}：点一下选中并预览`,
          onclick: () => r.kind !== 'fixed' && store.clickOption(r.id, o.id),
        },
        thumb ? h('img', { class: 'ne-thumb', src: thumb, alt: '' }) : h('span', { class: 'ne-thumb' }, first?.kind === 'group' ? '📁' : ''),
        h('span', { class: 'ne-label' }, o.name),
        bundled.has(o.id) ? h('span', { class: 'ne-tag pack', title: '来自图层包：在图层包节点里改图层' }, '包') : null,
        h(
          'button',
          {
            class: 'ne-x',
            title: '删除这个选项',
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
  if (!r.options.length) el.appendChild(h('div', { class: 'ne-empty' }, '把左边「图层」里的图层 / 文件夹拖到这里'));
  return el;
}

function targetName(t: Target): string {
  const p = store.state.project!;
  if (t.kind === 'rule') return t.ruleId ? p.rules.find((r) => r.id === t.ruleId)?.name ?? '?' : '';
  if (t.kind === 'option') {
    for (const r of p.rules) {
      const o = r.options.find((x) => x.id === t.optionId);
      if (o) return `${r.name}：${o.name}`;
    }
    return '';
  }
  return t.layerId ? `图层：${p.layerIndex[t.layerId]?.cleanName ?? '?'}` : '';
}

function constraintNode(c: Constraint): HTMLElement {
  const all = [c.a, c.b, ...(c.more ?? [])];
  const removed = store.state.result?.perConstraint[c.id] ?? 0;
  const el = node(`con ${c.kind}` + (c.enabled ? '' : ' off'), c.id, `con:${c.id}`);
  el.title = '把选项右边的圆点拖到这里 = 加入这条规则';
  const head = h('div', { class: 'ne-head' });
  head.appendChild(h('span', { class: 'ne-grip', title: '按住拖动' }, '⠿'));
  head.appendChild(
    h('input', {
      type: 'checkbox',
      checked: c.enabled,
      title: '启用 / 停用',
      onchange: (e: Event) => store.updateConstraint(c.id, { enabled: (e.target as HTMLInputElement).checked }),
    }),
  );
  head.appendChild(
    h(
      'select',
      { class: 'ne-kind wide', onchange: (e: Event) => store.updateConstraint(c.id, { kind: (e.target as HTMLSelectElement).value as Constraint['kind'] }) },
      h('option', { value: 'mutex', selected: c.kind === 'mutex' }, '互斥：最多一个'),
      h('option', { value: 'require', selected: c.kind === 'require' }, '依赖：A 需要 B'),
    ),
  );
  head.appendChild(h('button', { class: 'ne-x', title: '删除这条规则', onclick: () => store.deleteConstraint(c.id) }, '✕'));
  el.appendChild(head);
  el.appendChild(
    h(
      'div',
      { class: 'ne-sub' },
      c.kind === 'mutex'
        ? '下面这些在同一张图里最多出现一个。把选项或选项组标题右边的 ● 拖进来就能加入'
        : '有 A 的图里必须也有 B（A、B 可以是选项，也可以是整个选项组）',
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
        h('span', { class: 'ne-label', title: name }, name || '（空：把 ● 拖到这里）'),
        name
          ? h(
              'button',
              { class: 'ne-x', title: '从这条规则里移除', onclick: () => store.clearConstraintTarget(c.id, i) },
              '✕',
            )
          : null,
      ),
    );
  });
  el.appendChild(h('div', { class: 'ne-foot' }, removed ? `排除了 ${removed} 个组合` : '暂未排除任何组合'));
  return el;
}

function combineNode(p: Project): HTMLElement {
  const live = p.rules.filter((r) => r.enabled && r.kind !== 'fixed');
  const el = node('combine', 'combine', 'combine');
  el.appendChild(h('div', { class: 'ne-head' }, h('span', { class: 'ne-name' }, '组合 ×'), port('comb:out', 'out', 'on')));
  if (!live.length) el.appendChild(h('div', { class: 'ne-empty' }, '把选项组标题右边的圆点拖到这里'));
  for (const r of live) {
    const f = store.ruleFactor(r);
    el.appendChild(
      h(
        'div',
        { class: 'ne-row slim', title: f.why },
        port(`comb:${r.id}`, 'in'),
        h('span', { class: 'ne-label' }, r.name),
        h('span', { class: 'ne-count' + (f.n > 16 ? ' warn' : '') }, `×${f.n}`),
        h('button', { class: 'ne-x', title: '断开：不参与组合，固定用当前选项', onclick: () => store.setRuleEnabled(r.id, false) }, '✕'),
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
          `组合多主要来自：${big.map((x) => `「${x.r.name}」×${x.f.n}（${x.f.why}）`).join('、')}。` +
            (big.some((x) => x.r.kind === 'multi') ? '「可多选」是任意搭配；如果一次只出现一个，改成「可选一项」。' : ''),
        ),
      );
    }
  }
  return el;
}

function noteNode(n: NodeNote): HTMLElement {
  const el = node(n.kind === 'note' ? 'note' : 'pv', n.id, `note:${n.id}`);
  el.appendChild(
    h(
      'div',
      { class: 'ne-head' },
      h('span', { class: 'ne-grip', title: '按住拖动' }, '⠿'),
      h('span', { class: 'ne-name' }, n.kind === 'note' ? '便签' : '预览'),
      h('button', { class: 'ne-x', title: '删除', onclick: () => store.deleteNote(n.id) }, '✕'),
    ),
  );
  if (n.kind === 'note') {
    el.appendChild(
      h('textarea', {
        class: 'ne-note-text',
        placeholder: '写点备注：这张图给谁、哪些组合要注意…',
        value: n.text ?? '',
        onchange: (e: Event) => store.setNoteText(n.id, (e.target as HTMLTextAreaElement).value),
      }),
    );
  } else {
    el.appendChild(h('canvas', { class: 'ne-pv-canvas', 'data-pv': n.id }));
    el.appendChild(h('div', { class: 'ne-foot' }, '当前选择的实时预览：点选项组里的一行就会变'));
  }
  return el;
}

function bundleNode(b: NodeBundle): HTMLElement {
  const p = store.state.project!;
  const el = node('bundle', b.id, `bun:${b.id}`);
  el.title = '把图层拖到这里：它们会一起显示，算一个选项';
  el.appendChild(
    h(
      'div',
      { class: 'ne-head' },
      h('span', { class: 'ne-grip', title: '按住拖动' }, '⠿'),
      h('span', { class: 'ne-name', 'data-rename': b.id, 'data-rename-kind': 'bundle', title: '按住拖动；点一下改名' }, b.name),
      h('button', { class: 'ne-x', title: '删除这个图层包', onclick: () => store.deleteBundle(b.id) }, '✕'),
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
        h('button', { class: 'ne-x', title: '从图层包里拿掉', onclick: () => store.bundleRemoveLayer(b.id, id) }, '✕'),
      ),
    );
  }
  if (!b.layerIds.length) el.appendChild(h('div', { class: 'ne-empty' }, '把图层 / 文件夹拖到这里（可以多选一起拖）'));
  const r = b.ruleId ? p.rules.find((x) => x.id === b.ruleId) : undefined;
  el.appendChild(
    h(
      'div',
      { class: 'ne-foot' },
      r ? `→ 是「${r.name}」的一个选项：这 ${b.layerIds.length} 个图层一起显示` : '把右边的 ● 连到选项组左边的 ● = 成为它的一个选项',
    ),
  );
  return el;
}

function exportNode(): HTMLElement {
  const el = node('export' + (store.state.exportScope === 'current' ? ' direct' : ''), 'export', 'export');
  el.appendChild(h('div', { class: 'ne-head' }, port('export:in', 'in'), h('span', { class: 'ne-name' }, '导出 ZIP')));
  el.appendChild(h('div', { class: 'ne-big', 'data-count': '1' }, ''));
  el.appendChild(h('div', { class: 'ne-foot', 'data-why': '1' }, ''));
  el.appendChild(h('button', { class: 'btn primary small ne-go', 'data-go': '1', onclick: () => void startExport() }, '导出'));
  return el;
}

function updateCounts(): void {
  const s = store.state;
  const res = s.result;
  const n = store.selectedCombos().length;
  countPill.textContent = res ? `${n} 张` : '';
  const big = nodesHost.querySelector<HTMLElement>('[data-count]');
  if (big) big.textContent = `${n} 张`;
  undoBtn.disabled = !store.canUndo();
  redoBtn.disabled = !store.canRedo();
  const why = nodesHost.querySelector<HTMLElement>('[data-why]');
  if (why && res && s.exportScope === 'current')
    why.textContent = n
      ? '没接「组合 ×」：只导出当前预览的这一张。把「组合 ×」右边的圆点拖到这里 = 接回去'
      : '当前选择被规则排除了：换一个选项，或把「组合 ×」接回来';
  else if (why && res)
    why.textContent = res.truncated
      ? `组合太多（${res.rawCount}），只列出前 ${res.combos.length} 个：先减少「可多选」或断开一些组`
      : res.rejected.length
      ? `另有 ${res.rejected.length} 个被规则排除或去重`
      : '全部组合都有效';
  const go = nodesHost.querySelector<HTMLButtonElement>('[data-go]');
  if (go) {
    go.disabled = !n || s.exporting;
    go.textContent = s.exporting ? '导出中…' : `导出 ${n} 张`;
  }
}

/* Layout (measured) */

function autoLayout(p: Project, sizes: Map<string, Size>): Record<string, Pos> {
  const out: Record<string, Pos> = {};
  const size = (id: string) => sizes.get(id) ?? { w: 220, h: 120 };
  const narrow = viewport.clientWidth > 0 && viewport.clientWidth < 600;
  // option groups in k balanced columns: as many as make the whole graph
  // fit the screen at the largest zoom (one column on phones)
  const colW = Math.max(220, ...p.rules.map((r) => size(r.id).w));
  const place = (k: number) => {
    const cols: { ids: string[]; h: number }[] = Array.from({ length: k }, () => ({ ids: [], h: 0 }));
    const per = p.rules.reduce((a, r) => a + size(r.id).h + GAP, 0) / k;
    let c = 0;
    for (const r of p.rules) {
      if (cols[c].h > 0 && cols[c].h + size(r.id).h / 2 > per && c < k - 1) c++;
      cols[c].ids.push(r.id);
      cols[c].h += size(r.id).h + GAP;
    }
    return cols;
  };
  let best = place(1);
  if (!narrow && p.rules.length > 2) {
    const vw = Math.max(1, viewport.clientWidth);
    const vh = Math.max(1, viewport.clientHeight);
    const extra = 90 + 260 + 70 + 200 + (p.constraints.length ? 330 : 0);
    let bestScale = 0;
    for (let k = 1; k <= Math.min(4, p.rules.length); k++) {
      const cols = place(k);
      const w = k * colW + (k - 1) * 60 + extra;
      const hgt = Math.max(...cols.map((c) => c.h));
      const sc = Math.min(1, vw / w, vh / hgt);
      if (sc > bestScale + 0.02) {
        bestScale = sc;
        best = cols;
      }
    }
  }
  const groupTop: Record<string, number> = {};
  best.forEach((col, ci) => {
    let y = 0;
    for (const id of col.ids) {
      out[id] = { x: ci * (colW + 60), y };
      groupTop[id] = y;
      y += size(id).h + GAP;
    }
  });
  const groupsBottom = Math.max(0, ...best.map((c) => c.h - GAP));
  const groupsRight = (best.length - 1) * (colW + 60) + colW;
  const x2 = groupsRight + (narrow ? 34 : 90);

  if (narrow) {
    // phone: one more column with the product, export and the rules stacked
    let y2 = 0;
    for (const id of ['combine', 'export', ...p.constraints.map((c) => c.id)]) {
      out[id] = { x: x2, y: y2 };
      y2 += size(id).h + GAP;
    }
    return out;
  }

  // column 2: rules, near the groups they connect, without overlapping
  const rowY = (t: Target): number | undefined => {
    if (t.kind === 'rule' && t.ruleId) return groupTop[t.ruleId];
    if (t.kind !== 'option') return undefined;
    const r = p.rules.find((x) => x.options.some((o) => o.id === t.optionId));
    if (!r) return undefined;
    const idx = r.options.findIndex((o) => o.id === t.optionId) + (r.kind === 'optional' ? 1 : 0);
    return groupTop[r.id] + 70 + idx * 34;
  };
  const wanted = p.constraints.map((c) => {
    const ys = [c.a, c.b, ...(c.more ?? [])].map(rowY).filter((v): v is number => v !== undefined);
    return { c, y: ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length - size(c.id).h / 2 : 0 };
  });
  wanted.sort((a, b) => a.y - b.y);
  let floor = 0;
  let col2W = 0;
  for (const { c, y: want } of wanted) {
    const yy = Math.max(floor, want);
    out[c.id] = { x: x2, y: yy };
    floor = yy + size(c.id).h + GAP;
    col2W = Math.max(col2W, size(c.id).w);
  }
  // column 3: the product node, centred on the groups; then export
  const x3 = p.constraints.length ? x2 + col2W + 90 : x2;
  out.combine = { x: x3, y: Math.max(0, groupsBottom / 2 - size('combine').h / 2) };
  out.export = { x: x3 + size('combine').w + 70, y: out.combine.y };
  return out;
}

/* Edges */

/**
 * Centre of a dot in world coordinates: the node's own position (exact, from
 * its style) plus where the dot sits inside the node. Edges are therefore
 * tied to the node, whatever the zoom / pan / screen does.
 */
function portPos(key: string): Pos | null {
  const el = ports.get(key);
  const n = el?.closest<HTMLElement>('.ne-node');
  if (!el || !n || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  const nr = n.getBoundingClientRect();
  const s = nr.width / (n.offsetWidth || 1) || view.s;
  const nx = parseFloat(n.style.left) || 0;
  const ny = parseFloat(n.style.top) || 0;
  return { x: nx + (r.left + r.width / 2 - nr.left) / s, y: ny + (r.top + r.height / 2 - nr.top) / s };
}

/** Same point measured on screen: used by the test hook to verify the drawing. */
function portScreenPos(key: string): Pos | null {
  const el = ports.get(key);
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  return toWorld(r.left + r.width / 2, r.top + r.height / 2);
}

let edgeFrame = 0;
/** Redraw on the next frame (node grew / shrank, fonts, images). */
function scheduleEdges(): void {
  if (edgeFrame) return;
  edgeFrame = requestAnimationFrame(() => {
    edgeFrame = 0;
    drawEdges();
  });
}

function toWorld(cx: number, cy: number): Pos {
  const vr = viewport.getBoundingClientRect();
  return { x: (cx - vr.left - view.x) / view.s, y: (cy - vr.top - view.y) / view.s };
}

function curve(a: Pos, b: Pos): string {
  // forward links bend right-to-left; links that go back (phone layout)
  // loop out to the side instead of cutting through the nodes
  const dx = b.x > a.x + 20 ? Math.max(40, (b.x - a.x) / 2) : 60 + Math.abs(b.y - a.y) / 6;
  return `M${a.x.toFixed(1)},${a.y.toFixed(1)} C${(a.x + dx).toFixed(1)},${a.y.toFixed(1)} ${(b.x - dx).toFixed(1)},${b.y.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
}

let revealAfter: string | null = null;
let edgeBounds = { x0: 0, y0: 0, x1: 1, y1: 1 };

/**
 * The SVG gets an explicit box around everything it draws (no reliance on
 * overflow: visible, which some Android WebViews clip to a stale area).
 */
function sizeSvg(extra: Pos[] = []): void {
  let { x0, y0, x1, y1 } = edgeBounds;
  for (const q of extra) {
    x0 = Math.min(x0, q.x - 140);
    y0 = Math.min(y0, q.y - 40);
    x1 = Math.max(x1, q.x + 140);
    y1 = Math.max(y1, q.y + 40);
  }
  const w = Math.max(1, Math.ceil(x1 - x0));
  const hh = Math.max(1, Math.ceil(y1 - y0));
  svg.style.left = `${Math.floor(x0)}px`;
  svg.style.top = `${Math.floor(y0)}px`;
  svg.style.width = `${w}px`;
  svg.style.height = `${hh}px`;
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(hh));
  svg.setAttribute('viewBox', `${Math.floor(x0)} ${Math.floor(y0)} ${w} ${hh}`);
}

function drawEdges(): void {
  if (!root?.isConnected) return;
  const parts: SVGPathElement[] = [];
  const hits: SVGPathElement[] = [];
  const b0 = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const grow = (q: Pos, mx: number, my: number) => {
    b0.x0 = Math.min(b0.x0, q.x - mx);
    b0.y0 = Math.min(b0.y0, q.y - my);
    b0.x1 = Math.max(b0.x1, q.x + mx);
    b0.y1 = Math.max(b0.y1, q.y + my);
  };
  for (const n of nodesHost.children as HTMLCollectionOf<HTMLElement>) {
    grow({ x: n.offsetLeft, y: n.offsetTop }, 20, 20);
    grow({ x: n.offsetLeft + n.offsetWidth, y: n.offsetTop + n.offsetHeight }, 20, 20);
  }
  for (const e of edges) {
    const a = portPos(e.from);
    const b = portPos(e.to);
    if (!a || !b) continue;
    const d = curve(a, b);
    // the curve's control points stick out sideways: keep them inside the box
    const dx = Math.abs(b.x - a.x) + 80 + Math.abs(b.y - a.y) / 6;
    grow(a, dx, 10);
    grow(b, dx, 10);
    const path = document.createElementNS(SVGNS, 'path') as SVGPathElement;
    path.setAttribute('d', d);
    path.setAttribute('class', `ne-edge ${e.cls}`);
    path.dataset.from = e.from;
    path.dataset.to = e.to;
    parts.push(path);
    {
      const hit = document.createElementNS(SVGNS, 'path') as SVGPathElement;
      hit.setAttribute('d', d);
      hit.setAttribute('class', 'ne-hit');
      hit.dataset.from = e.from;
      hit.dataset.to = e.to;
      hits.push(hit);
    }
  }
  edgeBounds = Number.isFinite(b0.x0) ? b0 : { x0: 0, y0: 0, x1: 1, y1: 1 };
  sizeSvg();
  svg.replaceChildren(...parts, ...hits, wireEl);
}

/** Test hook: largest distance (px) between an edge end and the centre of its dot. */
export function edgeAlignment(): { edges: number; maxError: number } {
  let maxError = 0;
  let n = 0;
  for (const path of svg.querySelectorAll<SVGPathElement>('path.ne-edge')) {
    const nums = (path.getAttribute('d') ?? '').match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
    if (nums.length < 8) continue;
    const a = portScreenPos(path.dataset.from!);
    const b = portScreenPos(path.dataset.to!);
    if (!a || !b) continue;
    n++;
    maxError = Math.max(maxError, Math.hypot(nums[0] - a.x, nums[1] - a.y), Math.hypot(nums[6] - b.x, nums[7] - b.y));
  }
  return { edges: n, maxError: Math.round(maxError * 100) / 100 };
}

/* View */

function applyView(): void {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
}

export function fit(): void {
  const nodes = [...nodesHost.children] as HTMLElement[];
  const vw = viewport.clientWidth;
  const vh = viewport.clientHeight;
  if (!nodes.length || !vw || !vh) return;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const n of nodes) {
    x0 = Math.min(x0, n.offsetLeft);
    y0 = Math.min(y0, n.offsetTop);
    x1 = Math.max(x1, n.offsetLeft + n.offsetWidth);
    y1 = Math.max(y1, n.offsetTop + n.offsetHeight);
  }
  const pad = 20;
  const bw = x1 - x0 + 16; // + the dots sticking out
  const bh = y1 - y0;
  let s = Math.min(1, (vw - pad * 2) / bw, (vh - pad * 2) / bh);
  // phones: fit the width and scroll vertically rather than shrinking to unreadable
  if (vw < 600 && s < 0.6) s = Math.min(1, (vw - pad * 2) / bw);
  view.s = Math.max(0.2, s);
  view.x = (vw - bw * view.s) / 2 - (x0 - 8) * view.s;
  view.y = bh * view.s < vh - pad * 2 ? (vh - bh * view.s) / 2 - y0 * view.s : pad - y0 * view.s;
  applyView();
  drawEdges();
}

/** Scroll so a node is in view (top-left area), keeping the zoom. */
export function revealNode(id: string): void {
  const n = nodesHost.querySelector<HTMLElement>(`[data-node="${id}"]`);
  if (!n) return;
  view.x = 24 - n.offsetLeft * view.s;
  view.y = 24 - n.offsetTop * view.s;
  applyView();
  drawEdges();
}

function drawMini(): void {
  const src = document.querySelector<HTMLCanvasElement>('canvas.preview');
  if (!src || !src.width) return;
  const k = Math.min(150 / src.width, 190 / src.height);
  const w = Math.max(1, Math.round(src.width * k));
  const hh = Math.max(1, Math.round(src.height * k));
  if (mini.width !== w) mini.width = w;
  if (mini.height !== hh) mini.height = hh;
  const ctx = mini.getContext('2d')!;
  ctx.clearRect(0, 0, w, hh);
  ctx.drawImage(src, 0, 0, w, hh);
  for (const c of nodesHost.querySelectorAll<HTMLCanvasElement>('canvas.ne-pv-canvas')) {
    const k2 = Math.min(240 / src.width, 300 / src.height);
    const w2 = Math.max(1, Math.round(src.width * k2));
    const h2 = Math.max(1, Math.round(src.height * k2));
    if (c.width !== w2) c.width = w2;
    if (c.height !== h2) c.height = h2;
    const cx = c.getContext('2d')!;
    cx.clearRect(0, 0, w2, h2);
    cx.drawImage(src, 0, 0, w2, h2);
  }
}

/* Gestures: pan / zoom, move nodes, drag wires */

function capture(id: number): void {
  try {
    viewport.setPointerCapture(id);
  } catch {
    /* synthetic or already released pointer */
  }
}

function installGestures(): void {
  const pts = new Map<number, { x: number; y: number }>();
  let mode: 'none' | 'pan' | 'node' | 'wire' = 'none';
  let pinch: { d: number; cx: number; cy: number } | null = null;
  let nodeDrag: { el: HTMLElement; sx: number; sy: number; nx: number; ny: number; moved: boolean; rename: HTMLElement | null } | null = null;
  let wire: { from: string; start: Pos; moved: boolean; detach?: string } | null = null;
  let tap: { edge: SVGPathElement; x: number; y: number } | null = null;

  const local = (e: { clientX: number; clientY: number }) => {
    const r = viewport.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const finish = () => {
    busy = false;
    if (rebuildPending) rebuild();
  };

  viewport.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    if (t === mini) {
      mini.classList.toggle('big');
      return;
    }
    closePop();
    const portEl = t.closest<HTMLElement>('.ne-port');
    const key = portEl?.dataset.port ?? '';
    if (portEl && (key.startsWith('opt:') || key.startsWith('rule:') || key.startsWith('bun:') || key === 'comb:out')) {
      mode = 'wire';
      busy = true;
      wire = { from: key, start: portPos(key)!, moved: false };
      capture(e.pointerId);
      e.preventDefault();
      return;
    }
    // an input dot with a link: pick the link up (drop elsewhere = move / nowhere = disconnect)
    const linked = portEl ? edges.find((x) => x.to === key) : undefined;
    if (linked) {
      mode = 'wire';
      busy = true;
      wire = { from: linked.from, start: portPos(linked.from)!, moved: false, detach: key };
      capture(e.pointerId);
      e.preventDefault();
      return;
    }
    const head = t.closest<HTMLElement>('.ne-head');
    if (head && !t.closest('select, input, button')) {
      const el = head.closest<HTMLElement>('.ne-node')!;
      mode = 'node';
      busy = true;
      nodeDrag = { el, sx: e.clientX, sy: e.clientY, nx: el.offsetLeft, ny: el.offsetTop, moved: false, rename: t.closest<HTMLElement>('[data-rename]') };
      capture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (t.closest('.ne-node')) return; // rows, buttons, selects: normal clicks
    tap = t instanceof SVGPathElement && t.classList.contains('ne-hit') ? { edge: t, x: e.clientX, y: e.clientY } : null;
    pts.set(e.pointerId, local(e));
    capture(e.pointerId);
    mode = 'pan';
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(b.x - a.x, b.y - a.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    }
  });

  viewport.addEventListener('pointermove', (e) => {
    if (mode === 'wire' && wire) {
      if (!wire.moved && wire.detach) {
        svg.querySelector(`path.ne-edge[data-to="${wire.detach}"]`)?.classList.add('lifting');
      }
      wire.moved = true;
      const at = toWorld(e.clientX, e.clientY);
      sizeSvg([wire.start, at]);
      wireEl.setAttribute('d', curve(wire.start, at));
      return;
    }
    if (mode === 'node' && nodeDrag) {
      if (!nodeDrag.moved && Math.hypot(e.clientX - nodeDrag.sx, e.clientY - nodeDrag.sy) < 6) return;
      nodeDrag.moved = true;
      nodeDrag.el.style.left = `${nodeDrag.nx + (e.clientX - nodeDrag.sx) / view.s}px`;
      nodeDrag.el.style.top = `${nodeDrag.ny + (e.clientY - nodeDrag.sy) / view.s}px`;
      drawEdges();
      return;
    }
    if (mode !== 'pan' || !pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId)!;
    const cur = local(e);
    pts.set(e.pointerId, cur);
    if (pts.size >= 2 && pinch) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      zoomAt(cx, cy, d / pinch.d, cx - pinch.cx, cy - pinch.cy);
      pinch = { d, cx, cy };
    } else {
      view.x += cur.x - prev.x;
      view.y += cur.y - prev.y;
      applyView();
    }
  });

  const up = (e: PointerEvent) => {
    if (mode === 'wire' && wire) {
      wireEl.setAttribute('d', '');
      const { from, moved, detach } = wire;
      wire = null;
      mode = 'none';
      if (detach) {
        busy = false;
        svg.querySelector('path.lifting')?.classList.remove('lifting');
        if (!moved) showEdgeMenu(from, detach, e.clientX, e.clientY);
        else moveLink(from, detach, e.clientX, e.clientY);
        return finish();
      }
      if (!moved) {
        if (from.startsWith('rule:')) {
          const id = from.slice(5);
          const r = store.state.project!.rules.find((x) => x.id === id);
          if (r) store.setRuleEnabled(id, !r.enabled);
        } else if (from.startsWith('bun:')) store.toast('把这个圆点拖到选项组左边的圆点（或选项组上）= 成为它的一个选项', 'info');
        else if (from === 'comb:out') store.toast('把这个圆点拖到「导出」上 = 导出全部组合', 'info');
        else store.toast('拖到另一个选项 / 选项组上 = 互斥或依赖；拖到互斥节点上 = 加入它', 'info');
        return finish();
      }
      busy = false;
      dropWire(from, e.clientX, e.clientY);
      return finish();
    }
    if (mode === 'node' && nodeDrag) {
      const { el, moved, rename } = nodeDrag;
      nodeDrag = null;
      mode = 'none';
      if (moved) store.setNodePos(el.dataset.node!, el.offsetLeft, el.offsetTop);
      finish();
      if (!moved && rename) startRename(rename);
      return;
    }
    if (tap && pts.size === 1 && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 6) {
      showEdgeMenu(tap.edge.dataset.from!, tap.edge.dataset.to!, e.clientX, e.clientY);
    }
    tap = null;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (!pts.size) mode = 'none';
  };
  viewport.addEventListener('pointerup', up);
  viewport.addEventListener('pointercancel', up);
  viewport.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const p = local(e);
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015), 0, 0);
    },
    { passive: false },
  );
}

/** Swap a group title for an input; Enter / leaving the field saves, Esc cancels. */
function startRename(span: HTMLElement): void {
  const id = span.dataset.rename!;
  const input = h('input', { class: 'ne-name-input', value: span.textContent ?? '', spellcheck: false }) as HTMLInputElement;
  let done = false;
  const end = (save: boolean) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== span.textContent) {
      if (span.dataset.renameKind === 'bundle') store.renameBundle(id, v);
      else store.renameRule(id, v);
    }
    else input.replaceWith(span);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') end(true);
    else if (e.key === 'Escape') end(false);
  });
  input.addEventListener('blur', () => end(true));
  span.replaceWith(input);
  input.focus();
  input.select();
}

function zoomAt(cx: number, cy: number, k: number, dx: number, dy: number): void {
  const s = Math.max(0.2, Math.min(2.5, view.s * k));
  k = s / view.s;
  view.x = cx - (cx - view.x) * k + dx;
  view.y = cy - (cy - view.y) * k + dy;
  view.s = s;
  applyView();
}

/** The port / node under a screen point, as a key ('' = empty canvas). */
function keyAt(x: number, y: number): string {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const hit = el?.closest<HTMLElement>('[data-port], [data-target]');
  return hit ? hit.dataset.port ?? hit.dataset.target ?? '' : '';
}

/** What a wire dropped at (x, y) means. */
function dropWire(from: string, x: number, y: number): void {
  connectTo(from, keyAt(x, y), x, y);
}

/** A link picked up from an input dot and dropped somewhere else. */
function moveLink(from: string, oldTo: string, x: number, y: number): void {
  const to = keyAt(x, y);
  const con = (k: string) => (k.startsWith('con:') ? k.slice(4) : k.startsWith('cin:') ? k.split(':')[1] : '');
  if (to === oldTo) return;
  if (oldTo === 'export:in' && to.startsWith('export')) return;
  if (oldTo.startsWith('gin:') && groupOfKey(to) === oldTo.slice(4)) return;
  if (oldTo.startsWith('comb:') && (to === 'combine' || to.startsWith('comb:'))) return;
  if (con(oldTo) && con(oldTo) === con(to)) return;
  disconnect(from, oldTo, true);
  if (to) connectTo(from, to, x, y);
}

/** Remove one link. */
function disconnect(from: string, to: string, quiet = false): void {
  const p = store.state.project!;
  if (to.startsWith('gin:') && from.startsWith('bun:')) {
    store.unlinkBundle(from.slice(4));
    if (!quiet) store.toast('已断开：图层包不再是这个组的选项', 'ok');
    return;
  }
  if (to === 'export:in') {
    store.setExportScope('current');
    if (!quiet) store.toast('已断开：只导出当前预览的这一张。把「组合 ×」右边的圆点拖回「导出」可以接上', 'ok');
    return;
  }
  if (to.startsWith('comb:')) {
    const r = p.rules.find((x) => x.id === to.slice(5));
    if (!r) return;
    store.setRuleEnabled(r.id, false);
    if (!quiet) store.toast(`「${r.name}」已断开：不参与组合，导出时固定用它当前选中的选项。把它的圆点拖回「组合 ×」可以重新接上`, 'ok');
    return;
  }
  if (to.startsWith('cin:')) {
    const [, id, i] = to.split(':');
    store.clearConstraintTarget(id, Number(i));
    if (!quiet) store.toast('已从这条规则里移除', 'ok');
  }
  void from;
}

let pop: HTMLElement | null = null;
function closePop(): void {
  pop?.remove();
  pop = null;
}

/** A small menu at a screen point. */
function showPop(x: number, y: number, title: string, items: { label: string; hint?: string; run: () => void; cls?: string }[]): void {
  closePop();
  pop = h('div', { class: 'ne-pop' });
  pop.appendChild(h('div', { class: 'ne-pop-title' }, title));
  for (const it of items) {
    pop.appendChild(
      h(
        'button',
        {
          class: 'ne-pop-item ' + (it.cls ?? ''),
          onclick: () => {
            closePop();
            it.run();
          },
        },
        h('b', null, it.label),
        it.hint ? h('span', null, it.hint) : null,
      ),
    );
  }
  pop.appendChild(h('button', { class: 'ne-pop-item ghost', onclick: () => closePop() }, h('b', null, '取消')));
  root!.appendChild(pop);
  const r = pop.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(innerWidth - r.width - 8, x - r.width / 2))}px`;
  pop.style.top = `${Math.max(8, Math.min(innerHeight - r.height - 8, y + 12))}px`;
}

function showEdgeMenu(from: string, to: string, x: number, y: number): void {
  const p = store.state.project!;
  if (to.startsWith('gin:')) {
    const b = p.nodeBundles?.find((x) => `bun:${x.id}` === from);
    const r = p.rules.find((x) => x.id === to.slice(4));
    showPop(x, y, `「${b?.name ?? ''}」→「${r?.name ?? ''}」`, [
      { label: '✂ 断开', hint: '不再是这个组的选项（图层包本身留着）', run: () => disconnect(from, to), cls: 'danger' },
    ]);
    return;
  }
  if (to === 'export:in') {
    showPop(x, y, '组合 × → 导出', [{ label: '✂ 断开', hint: '不按组合导出，只导出当前预览的这一张', run: () => disconnect(from, to), cls: 'danger' }]);
    return;
  }
  if (to.startsWith('comb:')) {
    const r = p.rules.find((q) => q.id === to.slice(5));
    if (!r) return;
    showPop(x, y, `「${r.name}」→ 组合 ×`, [
      { label: '✂ 断开', hint: '不参与组合：导出时固定用它当前选中的选项', run: () => disconnect(from, to), cls: 'danger' },
    ]);
    return;
  }
  if (to.startsWith('cin:')) {
    const t = from.startsWith('opt:') ? { kind: 'option' as const, optionId: from.slice(4) } : { kind: 'rule' as const, ruleId: from.slice(5) };
    showPop(x, y, `${targetName(t)} → 规则`, [{ label: '✂ 断开', hint: '把它从这条互斥 / 依赖里移除', run: () => disconnect(from, to), cls: 'danger' }]);
  }
}

/** Connect a dragged dot to whatever key it was dropped on. */
/** The group a key points into (its input dot, the node, or one of its rows). */
function groupOfKey(key: string): string | null {
  const p = store.state.project!;
  if (key.startsWith('gin:')) return key.slice(4);
  if (key.startsWith('rule:')) return key.slice(5);
  if (key.startsWith('opt:')) return p.rules.find((r) => r.options.some((o) => o.id === key.slice(4)))?.id ?? null;
  return null;
}

function connectTo(from: string, to: string, x: number, y: number): void {
  if (!to) return;
  if (from.startsWith('bun:')) {
    const g = groupOfKey(to);
    if (g) store.linkBundle(from.slice(4), g);
    else store.toast('图层包要连到选项组上（左边的圆点）', 'info');
    return;
  }
  if (from === 'comb:out') {
    if (to.startsWith('export') && store.state.exportScope === 'current') {
      store.setExportScope('selected');
      store.toast('已接回：按组合导出', 'ok');
    }
    return;
  }
  const asTarget = (key: string): Target | null =>
    key.startsWith('opt:') ? { kind: 'option', optionId: key.slice(4) } : key.startsWith('rule:') ? { kind: 'rule', ruleId: key.slice(5) } : null;
  const src = asTarget(from)!;
  if (from.startsWith('rule:') && (to === 'combine' || to.startsWith('comb:'))) {
    store.setRuleEnabled(from.slice(5), true);
    return;
  }
  const con = to.startsWith('con:') ? to.slice(4) : to.startsWith('cin:') ? to.split(':')[1] : '';
  if (con) {
    store.appendConstraintTarget(con, src);
    return;
  }
  const dst = asTarget(to);
  if (!dst || from === to) return;
  if (src.kind === 'option' && dst.kind === 'option') {
    const p = store.state.project!;
    const ra = p.rules.find((r) => r.options.some((o) => o.id === src.optionId));
    const rb = p.rules.find((r) => r.options.some((o) => o.id === dst.optionId));
    if (ra && ra === rb && ra.kind !== 'multi') {
      store.toast(`同一个「${KIND_INFO[ra.kind].label}」组里的选项本来就只能出现一个`, 'info');
      return;
    }
  }
  // two items (options or whole groups): ask what the link means
  const an = targetName(src);
  const bn = targetName(dst);
  const at = toWorld(x, y);
  const make = (kind: Constraint['kind'], a: Target, b: Target) => {
    const id = store.connectConstraint(kind, a, b);
    if (!id) return;
    const spot = freeSpot({ x: at.x + 30, y: at.y - 30 }, 230, 150);
    store.setNodePos(id, spot.x, spot.y);
    store.notify();
    revealAfter = id; // once it is rendered
  };
  const p = store.state.project!;
  const ruleOf = (t: Target) => (t.kind === 'rule' ? p.rules.find((r) => r.id === t.ruleId) : undefined);
  const bothAlways = [src, dst].every((t) => ruleOf(t)?.kind === 'exclusive');
  showPop(x, y, `连接「${an}」和「${bn}」`, [
    {
      label: '互斥：最多出现一个',
      hint: bothAlways ? '注意：两个都是「必选一项」，总会同时出现，互斥会排除全部组合；先把其中一个改成「可选一项」' : `有「${an}」就不要「${bn}」，反过来也一样`,
      run: () => make('mutex', src, dst),
      cls: 'danger',
    },
    { label: `依赖：有「${an}」时必须有「${bn}」`, hint: `没有「${bn}」的组合里不会出现「${an}」`, run: () => make('require', src, dst), cls: 'ok' },
    { label: `依赖：有「${bn}」时必须有「${an}」`, hint: '反方向', run: () => make('require', dst, src), cls: 'ok' },
  ]);
}

/** A spot near `prefer` where a w×h node does not overlap any other node. */
function freeSpot(prefer: Pos, w: number, hh: number): Pos {
  const kids = [...nodesHost.children] as HTMLElement[];
  const rects = kids.map((n) => ({ x: n.offsetLeft, y: n.offsetTop, w: n.offsetWidth, h: n.offsetHeight }));
  // placed a moment ago but not drawn yet (two quick taps on "add group")
  const shown = new Set(kids.map((n) => n.dataset.node));
  for (const [id, q] of Object.entries(store.state.project?.nodeLayout ?? {})) if (!shown.has(id)) rects.push({ x: q.x, y: q.y, w: 240, h: 160 });
  const free = (q: Pos) => rects.every((r) => q.x + w + 16 <= r.x || r.x + r.w + 16 <= q.x || q.y + hh + 16 <= r.y || r.y + r.h + 16 <= q.y);
  const cands = [prefer, ...rects.flatMap((r) => [{ x: r.x, y: r.y + r.h + GAP }, { x: r.x + r.w + 40, y: r.y }, { x: r.x - w - 40, y: r.y }])];
  let best: Pos | null = null;
  let bd = Infinity;
  for (const c of cands) {
    if (!free(c)) continue;
    const d = Math.hypot(c.x - prefer.x, c.y - prefer.y);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best ?? { x: prefer.x, y: Math.max(0, ...rects.map((r) => r.y + r.h)) + GAP };
}
