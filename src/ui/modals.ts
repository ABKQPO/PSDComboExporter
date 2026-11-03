/** Dialogs: option editor (pick the layers of one option) and the help sheet. */

import type { LayerNode } from '../core/model';
import { rootsTopFirst } from '../core/project';
import * as store from './store';
import { h } from './dom';
import { KIND_INFO } from './rulesPanel';

function close(): void {
  store.state.editingOption = null;
  store.state.helpOpen = false;
  store.notify();
}

function shell(title: string, body: HTMLElement, footer?: HTMLElement): HTMLElement {
  const modal = h('div', { class: 'modal wide', onclick: (e: Event) => e.stopPropagation() });
  modal.appendChild(
    h('div', { class: 'modal-head' }, h('h2', null, title), h('span', { class: 'spacer' }), h('button', { class: 'btn ghost small', onclick: close }, '关闭')),
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
      h('label', null, '选项名'),
      h('input', {
        value: opt.name,
        onchange: (e: Event) => store.renameOption(rule.id, opt.id, (e.target as HTMLInputElement).value),
      }),
    ),
  );
  body.appendChild(
    h('div', { class: 'hint' }, `勾选这个选项包含的图层（可以是图层组）。选中这个选项时，勾选的图层会一起显示。已选 ${opt.layerIds.length} 个。`),
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
  return shell(`编辑选项：${rule.name} / ${opt.name}`, body, h('div', { class: 'modal-foot' }, h('button', { class: 'btn primary', onclick: close }, '完成')));
}

export function renderHelp(): HTMLElement | null {
  if (!store.state.helpOpen) return null;
  const body = h('div', { class: 'help' });
  body.innerHTML = `
<h3>它能做什么</h3>
<p>把一个 PSD 里的多套可替换图层（角色、服装、表情、文字……）按规则自动组合，逐张合成后打包成一个 ZIP。合成算法按 Photoshop 的方式逐像素计算（混合模式、剪贴蒙版、图层蒙版、不透明度/填充、穿透组、图案/颜色叠加），导出图与在 Photoshop 里手动切换图层后导出的结果一致。</p>
<h3>五个步骤</h3>
<ol>
<li><b>图层</b>：勾选要变化的图层或图层组，设为一个「选项组」；或在组上点「⇢ 子项作选项」。</li>
<li><b>选项组</b>：为每组选择规则类型，决定是否参与组合。点选项可以实时预览。</li>
<li><b>规则</b>：需要时添加跨组互斥、条件排除、完全排除、依赖。</li>
<li><b>组合</b>：检查所有将要导出的图，被排除的组合会写明原因。</li>
<li><b>导出</b>：选格式与文件名，导出为一个 ZIP。</li>
</ol>
<h3>规则一览</h3>
<table>
<tr><th>功能</th><th>在哪设置</th><th>示例</th></tr>
<tr><td>固定显示</td><td>选项组类型「${KIND_INFO.fixed.label}」</td><td>${KIND_INFO.fixed.example}</td></tr>
<tr><td>必选一项</td><td>选项组类型「${KIND_INFO.exclusive.label}」</td><td>${KIND_INFO.exclusive.example}</td></tr>
<tr><td>可选一项</td><td>选项组类型「${KIND_INFO.optional.label}」</td><td>${KIND_INFO.optional.example}</td></tr>
<tr><td>互斥组</td><td>「必选一项 / 可选一项」本身就是组内互斥</td><td>中文 / 英文 放进同一组</td></tr>
<tr><td>笛卡尔积</td><td>勾选「参与组合」的组相乘</td><td>角色 × 服装 × 表情</td></tr>
<tr><td>跨组互斥</td><td>规则页「跨组互斥」（整组粒度）</td><td>中文字幕组 与 英文字幕组</td></tr>
<tr><td>条件排除</td><td>规则页「条件排除」（选项粒度）</td><td>角色 A 不允许搭配服装 C</td></tr>
<tr><td>完全排除</td><td>规则页「完全排除」（图层粒度）</td><td>两个图层永不同时出现</td></tr>
<tr><td>多项互斥</td><td>规则页「多项互斥」，或在图层页勾选多项后点「设为互斥」；可「+ 再加一项」无限追加</td><td>尾巴 A / B / C 分散在不同组，最多出现一种</td></tr>
<tr><td>依赖</td><td>规则页「依赖」</td><td>选了睫毛必须有眼线</td></tr>
</table>
<h3>两种互斥的区别</h3>
<p><b>组内互斥</b>：同一个选项组里只能选一个，由组的类型决定，不需要另外设置。<br>
<b>跨组互斥</b>：两个不同的组之间也有冲突，在「规则」页添加；违反的组合会被跳过并在「组合」页说明原因。</p>
<h3>常用小功能</h3>
<ul>
<li><b>节点工作流</b>：顶栏「节点」。选项组 → 组合 × → 导出。「图层」打开图层列表：把图层或<b>文件夹</b>拖到选项组上 = 加<b>一个</b>选项（整个文件夹算一个差分），拖到空白处 = 新建选项组；「拆」= 文件夹里每个子项各做一个选项。「+ 选项组」「+ 互斥」新建节点，✕ 删除，标题直接改名。选项组标题右边的圆点连到「组合 ×」= 参与组合；从选项的圆点拖到另一个选项 = 互斥，再拖更多选项到互斥节点 = 最多出现一个。</li>
<li><b>组合数怎么来的</b>：每个参与组合的组乘一个数——必选一项 ×选项数，可选一项 ×(选项数+1)，可多选 ×2^选项数（任意搭配，增长最快）。「组合 ×」节点和选项组页都会逐组写清楚；如果一个组的选项其实是同一个差分的部件（如表情1 里的 10 个图层），会提示并可一键改正。</li>
<li><b>清空 / 重置</b>：选项组页「清空全部」删除所有选项组；导出页「全部重置」回到刚导入的状态。再次导入同一个文件会自动恢复上次的设置，顶部会提示，可点「不要，重新开始」，也可以关掉自动恢复。</li>
<li><b>智能识别</b>：导入后图层页顶部会按分组方式推测选项组（如 尾巴 → 龙尾 / 鱼尾 / 狐尾；牛子（大）/ 牛子（小）这类同名前缀；默认隐藏的配件），勾选后一键创建；和变体组放在一起的散图层（如 头发阴影）会作为共用部分一直显示。</li>
<li><b>搜索</b>：图层页顶部输入名字，只显示匹配的图层和它们的上级组。</li>
<li><b>显示 / 隐藏</b>：点图层最左边的眼睛图标直接切换，预览和导出都会按此显示；改动过的带蓝点，可一键「恢复原始显示」。</li>
<li><b>整体组 🔒</b>：线稿、底色、高光等拆成多层的部件组（包括里面全是「图层 61」这类默认名的组）会自动识别为「整体」，一起显示、不能拆开选；点 ▸ 可以展开查看并单独显示 / 隐藏里面的图层，点 🔒/🔓 可手动切换。</li>
<li><b>导出范围</b>：已勾选 / 全部有效组合 / 全部可能组合（忽略互斥规则）。</li>
<li><b>配置文件</b>：在导出页「导出配置」保存全部设置；画完新图后导入 PSD →「导入配置」→ 顶栏「一键导出」。</li>
<li><b>预览手势</b>：单指/鼠标拖动平移，双指或滚轮缩放，双指转动或 Shift+滚轮旋转（接近 90° 自动吸附），双击复位；顶部 ⟲ ⟳ 旋转 90°，百分比按钮复位。</li>
<li><b>回到顶部</b>：面板滚动后右下角的 ↑；手机上可「展开面板」显示更多内容，顶栏「说明」可隐藏蓝色提示省空间。</li>
</ul>
<h3>没加入选项组的图层</h3>
<p>按 PSD 保存时的显示/隐藏状态出现在每一张导出图里。被选中的选项会自动打开它所在的上级组。</p>
<h3>图层名标签（兼容命令行版 psd-export）</h3>
<p><code>[1]</code> 主标签；<code>[jp@lang]</code> lang 组的 jp 选项；<code>[+logo]</code> 固定显示；<code>[#censor]</code> 忽略；<code>[1:4]</code> 展开为 1~4。带标签的 PSD 导入后自动生成选项组。</p>
<h3>已知限制</h3>
<p>调整图层、投影/描边/发光等其余图层样式、矢量蒙版不会渲染（会在图层页用 ⚠ 标出）。缩放过的图案叠加与 Photoshop 有极细微的边缘差异。</p>
<p>设置会按文件自动保存，下次打开同一个 PSD 时自动恢复。</p>`;
  return shell('使用说明', body);
}
