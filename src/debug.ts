/**
 * QA surface on `window.psdExportApp.debug`, used by the Electron end-to-end
 * test to drive the real store, engine and export pipeline.
 */

import * as store from './ui/store';
import { exportConfigText, importConfigText } from './ui/configIO';
import { applyPreset } from './ui/presets';
import { engine } from './engine/client';
import { runExport } from './core/exporter';
import { bytesToBase64, createTarget, type ExportTarget } from './core/platform';
import { ZipWriter } from './core/zip';
import { decodePng } from './engine/pngdecode';
import { edgeAlignment, fit as fitNodes, revealNode } from './ui/nodeEditor';
import type { RuleKind } from './core/model';
import { loadRecent } from './ui/recent';

const pickMenu = (label: string) => {
  [...document.querySelectorAll<HTMLButtonElement>('.ne-bar .btn')].find((b) => b.textContent === '+ 添加')!.click();
  [...document.querySelectorAll<HTMLElement>('.ne-pop .ne-pop-item')].find((b) => b.querySelector('b')?.textContent === label)!.click();
};

export function installDebugApi(host: any): void {
  host.debug = {
    findLayer(name: string) {
      return store.state.project!.layers.filter((l) => l.cleanName === name || l.name === name).map((l) => l.id);
    },
    ruleFromGroup(groupName: string, kind: RuleKind = 'exclusive') {
      // prefer a group when a layer and a group share the name
      const p = store.state.project!;
      const id =
        p.layers.find((l) => l.kind === 'group' && (l.cleanName === groupName || l.name === groupName))?.id ??
        this.findLayer(groupName)[0];
      store.addRuleFromGroup(id, kind);
      return store.state.project!.rules.at(-1)!.id;
    },
    ruleFromLayers(names: string[], kind: RuleKind) {
      store.state.checked = new Set(names.flatMap((n: string) => this.findLayer(n).slice(0, 1)));
      store.addRuleFromChecked(kind, false);
      return store.state.project!.rules.at(-1)!.id;
    },
    optionId(ruleId: string, name: string) {
      return store.state.project!.rules.find((r) => r.id === ruleId)!.options.find((o) => o.name === name)!.id;
    },
    addMutex(a: any, b: any) {
      store.addConstraint('mutex', a.kind, undefined);
      const c = store.state.project!.constraints.at(-1)!;
      store.updateConstraint(c.id, { a, b });
    },
    /** Drive the preview viewer with synthetic pointer events; returns the transforms. */
    gestureCheck() {
      const el = document.querySelector<HTMLElement>('.viewer')!;
      const cv = el.querySelector('canvas')!;
      const b = el.getBoundingClientRect();
      const cx = b.left + b.width / 2;
      const cy = b.top + b.height / 2;
      const ev = (type: string, id: number, x: number, y: number) =>
        el.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, pointerType: 'touch', isPrimary: id === 1 }));
      const m = () => new DOMMatrix(getComputedStyle(cv).transform);
      const scale = () => Math.hypot(m().a, m().b);
      const angle = () => (Math.atan2(m().b, m().a) * 180) / Math.PI;
      const s0 = scale();
      // one-finger pan by (40, 30)
      ev('pointerdown', 1, cx, cy);
      ev('pointermove', 1, cx + 20, cy + 15);
      ev('pointermove', 1, cx + 40, cy + 30);
      ev('pointerup', 1, cx + 40, cy + 30);
      const pan = [Math.round(m().e), Math.round(m().f)];
      // two fingers: spread to double distance and turn by 30°
      ev('pointerdown', 1, cx - 50, cy);
      ev('pointerdown', 2, cx + 50, cy);
      const r = (30 * Math.PI) / 180;
      for (let i = 1; i <= 5; i++) {
        const d = 50 * (1 + i / 5);
        const a = (r * i) / 5;
        ev('pointermove', 1, cx - d * Math.cos(a), cy - d * Math.sin(a));
        ev('pointermove', 2, cx + d * Math.cos(a), cy + d * Math.sin(a));
      }
      ev('pointerup', 1, 0, 0);
      ev('pointerup', 2, 0, 0);
      const pinch = { zoom: +(scale() / s0).toFixed(3), angle: +angle().toFixed(1) };
      document.querySelector<HTMLButtonElement>('.view-tools .zoom')!.click();
      const reset = { zoom: +(scale() / s0).toFixed(3), angle: +angle().toFixed(1), x: Math.round(m().e), y: Math.round(m().f) };
      return { pan, pinch, reset, label: document.querySelector('.view-tools .zoom')!.textContent };
    },
    /** Main-thread cost of common clicks: long tasks + time until the panel settled. */
    async perfCheck() {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const longs: number[] = [];
      const po = new PerformanceObserver((l) => l.getEntries().forEach((e) => longs.push(e.duration)));
      po.observe({ entryTypes: ['longtask'] });
      const settle = async () => {
        await sleep(80);
        for (let i = 0; i < 100 && store.state.previewBusy; i++) await sleep(20);
        await sleep(120);
      };
      const measure = async (name: string, pick: () => HTMLElement | null | undefined, n = 4) => {
        const res = { sync: 0, long: 0, maxLong: 0, total: 0, n: 0 };
        for (let i = 0; i < n; i++) {
          const el = pick();
          if (!el) break;
          longs.length = 0;
          const t0 = performance.now();
          el.click();
          res.sync += performance.now() - t0;
          await settle();
          res.total += performance.now() - t0 - 200;
          res.long += longs.reduce((a, b) => a + b, 0);
          res.maxLong = Math.max(res.maxLong, ...longs, 0);
          res.n++;
        }
        const k = Math.max(1, res.n);
        return { [name]: { n: res.n, syncMs: Math.round(res.sync / k), blockedMs: Math.round(res.long / k), worstTaskMs: Math.round(res.maxLong), settleMs: Math.round(res.total / k) } };
      };
      const out: Record<string, unknown> = {};
      store.setTab('layers');
      await settle();
      let k = 0;
      Object.assign(out, await measure('layerCheckbox', () => document.querySelectorAll<HTMLElement>('.tree-row input[type=checkbox]')[(k++ % 3) + 1]));
      store.state.checked.clear();
      Object.assign(out, await measure('eyeToggle', () => document.querySelectorAll<HTMLElement>('.tree-row .eye')[2]));
      store.setTab('rules');
      await settle();
      let j = 0;
      Object.assign(out, await measure('optionClick', () => {
        const opts = document.querySelectorAll<HTMLElement>('.opt:not(.locked)');
        return opts[j++ % Math.max(1, opts.length)];
      }, 6));
      // time to first pixels after a click, and a burst of 5 quick clicks
      const opts = () => [...document.querySelectorAll<HTMLElement>('.opt:not(.locked)')];
      const firstPaint = async (el: HTMLElement) => {
        const before = store.state.previewSize;
        const t0 = performance.now();
        el.click();
        for (let i = 0; i < 400 && store.state.previewSize === before; i++) await sleep(5);
        const first = performance.now() - t0;
        await settle();
        return Math.round(first);
      };
      const fp: number[] = [];
      for (let i = 0; i < 4; i++) {
        const o = opts();
        // a not-yet-seen state: walk the options of the last group
        fp.push(await firstPaint(o[o.length - 1 - (i % Math.max(1, o.length))]));
      }
      out.firstPaintMs = fp;
      const t0 = performance.now();
      for (let i = 0; i < 5; i++) {
        opts()[i % opts().length]?.click();
        await sleep(30);
      }
      for (let i = 0; i < 600 && (store.state.previewBusy || store.previewPending()); i++) await sleep(5);
      out.burst5Ms = Math.round(performance.now() - t0);
      // rapid eye toggles: the preview must end up showing exactly the final state
      const eyes = () => [...document.querySelectorAll<HTMLElement>('.tree-row .eye')];
      store.setTab('layers');
      await settle();
      const t1 = performance.now();
      for (let i = 0; i < 6; i++) {
        eyes()[1 + (i % 4)]?.click();
        await sleep(25);
      }
      for (let i = 0; i < 1000 && store.previewPending(); i++) await sleep(5);
      out.eyeBurstMs = Math.round(performance.now() - t1);
      await sleep(200);
      const cv = document.querySelector<HTMLCanvasElement>('canvas.preview')!;
      const shown = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
      const ref = await engine.render(store.state.vis!.on, 'preview');
      let same = shown.length === ref.data.length;
      for (let i = 0; same && i < shown.length; i += 4) {
        // canvas stores premultiplied colour: compare opaque pixels and alpha
        if (shown[i + 3] !== ref.data[i + 3] || (ref.data[i + 3] === 255 && (shown[i] !== ref.data[i] || shown[i + 1] !== ref.data[i + 1] || shown[i + 2] !== ref.data[i + 2]))) same = false;
      }
      out.previewMatchesFinalState = same;
      if (!same) {
        let alphaDiff = 0;
        let colorDiff = 0;
        for (let i = 0; i < Math.min(shown.length, ref.data.length); i += 4) {
          if (shown[i + 3] !== ref.data[i + 3]) alphaDiff++;
          else if (ref.data[i + 3] === 255 && (shown[i] !== ref.data[i] || shown[i + 1] !== ref.data[i + 1] || shown[i + 2] !== ref.data[i + 2])) colorDiff++;
        }
        out.mismatch = { canvas: [cv.width, cv.height], ref: [ref.width, ref.height], alphaDiff, colorDiff, pending: store.previewPending(), busy: store.state.previewBusy };
      }
      po.disconnect();
      out.rows = store.state.project!.layers.length;
      return out;
    },
    /** Create the default-ticked suggested option groups; report expected vs actual combos. */
    applyAllSuggest() {
      for (const sg of store.suggestions()) store.setSuggestPick(sg.key, { on: true });
      return this.applySuggest();
    },
    applySuggest() {
      const list = store.suggestions();
      const had = list.filter((sg) => store.suggestionPicked(sg).on).length;
      const expected = store.suggestionCount();
      if (had) store.applySuggestions();
      return { suggestions: list.length, applied: had, expected, got: store.state.result!.combos.length };
    },
    /** Text dump of the layer tree as the app sees it. */
    dumpTree() {
      const s = store.state;
      const p = s.project!;
      const lines: string[] = [];
      const atomic = new Set(p.atomic ?? []);
      const walk = (list: typeof p.layers, d: number) => {
        for (const l of [...list].reverse()) {
          const st = s.vis?.drawn.has(l.id) ? '●' : l.authoredVisible ? '◐' : '○';
          const extra = [
            l.blendMode !== 'normal' && l.blendMode !== 'pass through' ? l.blendMode : '',
            l.opacity < 1 ? `op${Math.round(l.opacity * 100)}` : '',
            l.fill < 1 ? `fill${Math.round(l.fill * 100)}` : '',
            l.clipping ? 'clip' : '',
            l.hasMask ? 'mask' : '',
            l.effects.length ? `fx:${l.effects.join('/')}` : '',
            atomic.has(l.id) ? 'ATOMIC' : '',
            l.kind === 'layer' && !l.bbox ? 'EMPTY' : '',
          ].filter(Boolean);
          lines.push(`${'  '.repeat(d)}${st} ${l.kind === 'group' ? `[${l.name}]` : l.name}${extra.length ? `  {${extra.join(' ')}}` : ''}`);
          if (l.kind === 'group') walk(l.children, d + 1);
        }
      };
      walk(p.layers.filter((l) => !l.parentId), 0);
      lines.push('rules: ' + JSON.stringify(p.rules.map((r) => [r.name, r.kind, r.options.map((o) => o.name)])));
      lines.push('combos: ' + s.result?.combos.length);
      for (const sg of store.suggestions())
        lines.push(`suggest ${sg.recommended ? '[x]' : '[ ]'} ${sg.name} ${sg.kind}: ${sg.optionNames.join(' / ')}${sg.shared.length ? ` (共用 ${sg.shared.join('、')})` : ''}`);
      lines.push('suggested total: ' + store.suggestionCount());
      return lines.join('\n');
    },
    /** Open a part group (and its parents) in the layer tree. */
    expandPart(name: string) {
      const p = store.state.project!;
      const l = p.layers.find((x) => x.cleanName === name);
      if (!l) return false;
      for (let c = l.parentId; c; c = p.layerIndex[c]?.parentId ?? null) store.state.collapsed.delete(c);
      if (!store.isPartExpanded(l.id)) store.togglePartExpanded(l.id);
      return true;
    },
    /** Export n combos one by one and report where the time goes (ms per image). */
    /** Compare deflate back ends and the filter on real full-size pictures. */
    async deflateBench(n = 3) {
      const { zlibSync } = await import('fflate');
      const { filterRows, deflate } = await import('./engine/png');
      const combos = store.state.result!.combos.slice(0, n);
      const t: Record<string, number> = { filter: 0, native: 0, f1: 0, f3: 0, f6: 0 };
      const size: Record<string, number> = { native: 0, f1: 0, f3: 0, f6: 0 };
      let zeroRows = 0;
      let sameRows = 0;
      let rows = 0;
      for (const c of combos) {
        const img = await engine.render(c.on, 'full');
        const px = img.data as Uint8ClampedArray;
        const W = img.width;
        const H = img.height;
        const u = new Uint32Array(px.buffer, px.byteOffset, W * H);
        for (let y = 0; y < H; y++) {
          rows++;
          let z = true;
          let same = y > 0;
          for (let x = 0, i = y * W; x < W; x++, i++) {
            if (u[i] !== 0) z = false;
            if (same && u[i] !== u[i - W]) same = false;
            if (!z && !same) break;
          }
          if (z) zeroRows++;
          else if (same) sameRows++;
        }
        let a = performance.now();
        const f = filterRows(px, W, H, 4);
        t.filter += performance.now() - a;
        a = performance.now();
        size.native += (await deflate(f)).length;
        t.native += performance.now() - a;
        for (const lv of [1, 3, 6] as const) {
          a = performance.now();
          size['f' + lv] += zlibSync(f, { level: lv }).length;
          t['f' + lv] += performance.now() - a;
        }
      }
      const k = combos.length;
      return {
        ms: Object.fromEntries(Object.entries(t).map(([key, v]) => [key, Math.round(v / k)])),
        kb: Object.fromEntries(Object.entries(size).map(([key, v]) => [key, Math.round(v / k / 1024)])),
        zeroRowsPct: Math.round((100 * zeroRows) / rows),
        sameRowsPct: Math.round((100 * sameRows) / rows),
      };
    },
    async exportTiming(n = 6) {
      const combos = store.state.result!.combos.slice(0, n);
      const sum = { render: 0, filter: 0, deflate: 0, other: 0, transfer: 0, base64: 0, total: 0, bytes: 0, reusedPct: 0 };
      const t0 = performance.now();
      for (const c of combos) {
        const t = performance.now();
        const enc = await engine.exportImage(c.on, 'png', 100, 1);
        const wall = performance.now() - t;
        const tm = enc.timing!;
        sum.render += tm.render;
        sum.filter += tm.filter;
        sum.deflate += tm.deflate;
        sum.other += tm.other;
        sum.reusedPct += tm.tiles ? (100 * (tm.reused ?? 0)) / tm.tiles : 0;
        sum.transfer += wall - (tm.render + tm.filter + tm.deflate + tm.other);
        const tb = performance.now();
        bytesToBase64(enc.bytes);
        sum.base64 += performance.now() - tb;
        sum.bytes += enc.bytes.length;
      }
      sum.total = performance.now() - t0;
      const k = Math.max(1, combos.length);
      return Object.fromEntries(Object.entries(sum).map(([key, v]) => [key, key === 'bytes' ? Math.round(v / k / 1024) + 'KB' : Math.round(v / k)]));
    },
    /** Export combos through the real pipeline and compare each PNG with a fresh, uncached full render. */
    async exportExactCheck(n = 8) {
      const combos = store.state.result!.combos.slice(0, n);
      let identical = 0;
      let reused = 0;
      let tiles = 0;
      const bad: string[] = [];
      for (const c of combos) {
        const enc = await engine.exportImage(c.on, 'png', 100, 1);
        reused += enc.timing?.reused ?? 0;
        tiles += enc.timing?.tiles ?? 0;
        const png = await decodePng(enc.bytes);
        const ref = await engine.render(c.on, 'full');
        let same = png.width === ref.width && png.height === ref.height;
        if (same) {
          const a = png.data;
          const b = ref.data;
          for (let i = 0; i < b.length; i++) {
            if (a[i] !== b[i]) {
              same = false;
              break;
            }
          }
        }
        if (same) identical++;
        else bad.push(c.labels.join('-'));
      }
      return { checked: combos.length, identical, bad, slots: engine.exportSlots, workers: engine.workerCount, tiles, reused };
    },
    /** Eye buttons on option layers switch the option (they used to do nothing). */
    async eyeOptionCheck() {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const s = store.state;
      const p = s.project!;
      const ok = (x: (typeof p.rules)[number]) => x.kind === 'exclusive' && x.options.length >= 2 && x.options.every((o) => o.layerIds.length === 1);
      const r = p.rules.find((x) => ok(x) && x.name === '表情') ?? p.rules.find(ok);
      if (!r) return { skipped: true };
      store.setTab('layers');
      await sleep(150);
      const other = r.options.find((o) => !(s.selection[r.id] ?? []).includes(o.id))!;
      const eyeOf = (layerId: string) => document.querySelector<HTMLElement>(`.tree-row[data-id="${layerId}"] .eye`);
      eyeOf(other.layerIds[0])?.click();
      await sleep(150);
      const switched = (s.selection[r.id] ?? [])[0] === other.id;
      // a layer inside the option that is not chosen now (yellow eye: on itself,
      // hidden by its group): its eye must show the whole group, not hide the layer
      const back = r.options.find((o) => o.id !== other.id)!;
      const group = p.layerIndex[back.layerIds[0]];
      let insideOk: boolean | null = null;
      if (group.kind === 'group' && group.children.length) {
        if (store.isAtomic(group.id) && !store.isPartExpanded(group.id)) store.togglePartExpanded(group.id);
        await sleep(150);
        const child = [...group.children].reverse().find((c) => (p.visibility?.[c.id] ?? c.authoredVisible) && !!c.bbox) ?? null;
        if (child) {
          eyeOf(child.id)?.click();
          await sleep(200);
          const vis = s.vis!;
          const shown = group.children.filter((c) => (p.visibility?.[c.id] ?? c.authoredVisible) && !!c.bbox).every((c) => vis.drawn.has(c.id) || c.kind === 'group');
          insideOk = (s.selection[r.id] ?? [])[0] === back.id && shown && vis.drawn.has(child.id);
        }
      }
      return { rule: r.name, to: other.name, switched, insideOk };
    },
    openNodes() {
      store.state.sheetOpen = false;
      store.setNodeEditor(true);
    },
    /** The reported phone case: clear all groups, two new ones via the toolbar, a folder in the second. */
    userCase() {
      const p = store.state.project!;
      p.rules = [];
      p.constraints = [];
      p.nodeLayout = {};
      store.notify();
      pickMenu('选项组');
      pickMenu('选项组');
      const body = p.layers.find((l) => l.kind === 'group' && l.cleanName === '身体');
      if (body) store.addLayerOption(p.rules[1].id, body.id);
    },
    /** Undo / redo, clear, export link, drawer multi-select, bundles, presets, notes, config round trip. */
    async nodeExtrasCheck() {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const s = store.state;
      const p = () => s.project!;
      const out: Record<string, unknown> = {};
      store.setNodeEditor(true);
      await sleep(300);
      fitNodes();
      const vp = document.querySelector<HTMLElement>('.ne-viewport')!;
      const center = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      };
      const fire = (el: Element, type: string, pt: { x: number; y: number }, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}) =>
        el.dispatchEvent(new PointerEvent(type, { pointerId: 9, clientX: pt.x, clientY: pt.y, bubbles: true, isPrimary: true, pointerType: 'mouse', button: 0, ...mods }));
      const drag = async (fromEl: Element, to: { x: number; y: number }, moveOn: Element = vp) => {
        const a = center(fromEl);
        fire(fromEl, 'pointerdown', a);
        fire(moveOn, 'pointermove', { x: (a.x + to.x) / 2, y: (a.y + to.y) / 2 });
        fire(moveOn, 'pointermove', to);
        fire(moveOn, 'pointerup', to);
        await sleep(300);
      };
      const btn = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('.ne-bar .btn')].find((b) => b.textContent?.includes(text))!;
      const emptySpot = () => {
        const vr = vp.getBoundingClientRect();
        for (let yy = vr.bottom - 30; yy > vr.top + 20; yy -= 24)
          for (let xx = vr.right - 30; xx > vr.left + 20; xx -= 24) {
            const e = document.elementFromPoint(xx, yy) as Element | null;
            if (e && vp.contains(e) && !e.closest('.ne-node') && !e.classList.contains('ne-hit') && !e.classList.contains('ne-mini')) return { x: xx, y: yy };
          }
        return null;
      };
      // 1. clear -> undo -> redo -> undo (start from the auto-detect example so there is something)
      applyPreset('smart');
      await sleep(300);
      const n0 = p().rules.length;
      btn('清空').click();
      await sleep(200);
      const cleared = p().rules.length === 0;
      btn('撤回').click();
      await sleep(200);
      const back = p().rules.length === n0;
      btn('重做').click();
      await sleep(200);
      const again = p().rules.length === 0;
      btn('撤回').click();
      await sleep(300);
      out.undoRedo = cleared && back && again && p().rules.length === n0 && n0 > 0;
      out.undoDbg = [n0, cleared, back, again, p().rules.length, store.canUndo(), store.canRedo()];
      // keyboard
      const before = p().rules.length;
      store.addEmptyRule();
      await sleep(150);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
      await sleep(200);
      out.ctrlZ = p().rules.length === before;
      // 2. the export link can be cut (only the current picture) and put back
      fitNodes();
      await sleep(100);
      const exIn = document.querySelector('[data-port="export:in"]')!;
      const sp = emptySpot();
      if (sp) await drag(exIn, sp);
      out.exportCut = s.exportScope === 'current' && store.selectedCombos().length === 1;
      await drag(document.querySelector('[data-port="comb:out"]')!, center(document.querySelector('.ne-node.export .ne-big')!));
      out.exportBack = s.exportScope === 'selected';
      // a single remaining group can be disconnected too
      const live = p().rules.filter((r) => r.enabled && r.kind !== 'fixed');
      for (const r of live.slice(1)) store.setRuleEnabled(r.id, false);
      await sleep(300);
      const only = live[0];
      const inDot = document.querySelector(`[data-port="comb:${only.id}"]`);
      const sp2 = emptySpot();
      if (inDot && sp2) await drag(inDot, sp2);
      out.lastGroupCut = !p().rules.find((r) => r.id === only.id)!.enabled && (s.result?.combos.length ?? 0) === 1;
      for (const r of live) store.setRuleEnabled(r.id, true);
      await sleep(300);
      // 3. drawer: Shift range, Ctrl-click two rows, drag one = both
      const g = p().rules.find((r) => r.kind !== 'fixed')!;
      const g0 = g.options.length;
      if (!document.querySelector('.ne-drawer.open')) btn('图层').click();
      await sleep(1100);
      fitNodes();
      await sleep(100);
      const list = document.querySelector<HTMLElement>('.ne-drawer-list')!;
      const rows = () => [...list.querySelectorAll<HTMLElement>('.ne-item')];
      const usedNow = () => new Set(p().rules.flatMap((r) => r.options.flatMap((o) => o.layerIds)));
      const row = (id: string) => list.querySelector<HTMLElement>(`.ne-item[data-layer="${id}"]`)!;
      const free = rows().filter((r) => !usedNow().has(r.dataset.layer!)).map((r) => r.dataset.layer!);
      const click = (id: string, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}) => {
        const el = row(id);
        fire(el, 'pointerdown', center(el), mods);
        fire(list, 'pointerup', center(el), mods);
      };
      click(free[0]);
      click(free[3] ?? free[2], { shiftKey: true });
      await sleep(50);
      out.shiftRange = document.querySelectorAll('.ne-item.sel').length >= 3;
      click(free[0]);
      click(free[1], { ctrlKey: true });
      await sleep(50);
      out.ctrlPicked = document.querySelectorAll('.ne-item.sel').length;
      const gHead = document.querySelector(`.ne-node[data-node="${g.id}"] .ne-head .ne-name`)!;
      await drag(row(free[1]), center(gHead), list);
      out.multiIntoGroup = p().rules.find((r) => r.id === g.id)!.options.length === g0 + 2;
      // phone way: the multi-select switch, then plain taps
      document.querySelector<HTMLElement>('.ne-multi')!.click();
      await sleep(50);
      const fr = rows().filter((r) => !usedNow().has(r.dataset.layer!)).map((r) => r.dataset.layer!);
      click(fr[0]);
      click(fr[1]);
      await sleep(50);
      out.switchPicked = document.querySelectorAll('.ne-item.sel').length;
      // 4. two picked rows onto the empty canvas -> bundle into one layer pack
      const sp3 = emptySpot();
      const bundlesBefore = (p().nodeBundles ?? []).length;
      if (sp3) await drag(row(fr[0]), sp3, list);
      [...document.querySelectorAll<HTMLElement>('.ne-pop .ne-pop-item')].find((b) => b.textContent?.includes('图层包'))?.click();
      await sleep(300);
      const bun = (p().nodeBundles ?? [])[bundlesBefore];
      out.bundleMade = !!bun && bun.layerIds.length === 2;
      document.querySelector<HTMLElement>('.ne-multi')!.click();
      // 5. bundle dot -> a group's left dot = one option with both layers
      if (bun) {
        fitNodes();
        await sleep(100);
        const g1 = p().rules.find((r) => r.id === g.id)!.options.length;
        await drag(document.querySelector(`[data-port="bun:${bun.id}"]`)!, center(document.querySelector(`[data-port="gin:${g.id}"]`)!));
        const gr = p().rules.find((r) => r.id === g.id)!;
        const opt = gr.options[gr.options.length - 1];
        out.bundleLinked = gr.options.length === g1 + 1 && opt.layerIds.length === 2 && !!document.querySelector(`path.ne-edge[data-from="bun:${bun.id}"]`);
        // pull it off the group's dot onto empty canvas = disconnected
        const sp4 = emptySpot();
        if (sp4) await drag(document.querySelector(`[data-port="gin:${g.id}"]`)!, sp4);
        out.bundleUnlinked = p().rules.find((r) => r.id === g.id)!.options.length === g1 && !p().nodeBundles!.find((b) => b.id === bun.id)!.ruleId;
        await drag(document.querySelector(`[data-port="bun:${bun.id}"]`)!, center(document.querySelector(`.ne-node[data-node="${g.id}"] .ne-head .ne-name`)!));
      }
      // 6. presets + notes
      const c0 = p().constraints.length;
      applyPreset('mutex');
      await sleep(200);
      out.presetMutex = p().constraints.length === c0 + 1;
      btn('+ 添加').click();
      await sleep(50);
      [...document.querySelectorAll<HTMLElement>('.ne-pop .ne-pop-item')].find((b) => b.textContent?.startsWith('便签'))?.click();
      await sleep(300);
      out.noteAdded = (p().nodeNotes ?? []).length === 1 && !!document.querySelector('.ne-node.note');
      // 7. config round trip keeps groups, rules, bundles, notes
      const text = exportConfigText();
      const sig = () =>
        JSON.stringify([
          p().rules.map((r) => [r.name, r.options.length]),
          p().constraints.length,
          (p().nodeBundles ?? []).map((b) => [b.name, b.layerIds.length, !!b.ruleId]),
          (p().nodeNotes ?? []).length,
        ]);
      const want = sig();
      store.clearCanvas();
      await sleep(200);
      importConfigText(text);
      await sleep(300);
      out.configRoundTrip = sig() === want;
      out.edges = edgeAlignment().maxError;
      store.startFresh(false);
      await sleep(200);
      out.ok = !!(
        out.undoRedo &&
        out.ctrlZ &&
        out.exportCut &&
        out.exportBack &&
        out.lastGroupCut &&
        out.shiftRange &&
        out.ctrlPicked === 2 &&
        out.multiIntoGroup &&
        out.switchPicked === 2 &&
        out.bundleMade &&
        out.bundleLinked &&
        out.bundleUnlinked &&
        out.presetMutex &&
        out.noteAdded &&
        out.configRoundTrip &&
        (out.edges as number) <= 1
      );
      return out;
    },
    /** Drive the node editor with real pointer events; checks edges stay on their dots. */
    async nodeEditorCheck() {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const s = store.state;
      const out: Record<string, unknown> = {};
      const align: number[] = [];
      const checkEdges = (label: string) => {
        const a = edgeAlignment();
        align.push(a.maxError);
        if (a.maxError > 1) out[`misaligned:${label}`] = a;
      };
      store.setNodeEditor(true);
      await sleep(300);
      const p = () => s.project!;
      out.open = !!document.querySelector('.node-editor');
      out.nodes = document.querySelectorAll('.ne-node').length;
      out.expectedNodes = p().rules.length + p().constraints.length + 2;
      checkEdges('open');
      // nodes must not overlap after automatic layout
      const rects = [...document.querySelectorAll<HTMLElement>('.ne-node')].map((n) => n.getBoundingClientRect());
      let overlaps = 0;
      for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i];
          const b = rects[j];
          if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps++;
        }
      out.overlaps = overlaps;
      const center = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      };
      const vp = document.querySelector<HTMLElement>('.ne-viewport')!;
      const fire = (el: Element, type: string, pt: { x: number; y: number }) =>
        el.dispatchEvent(new PointerEvent(type, { pointerId: 7, clientX: pt.x, clientY: pt.y, bubbles: true, isPrimary: true, pointerType: 'mouse', button: 0 }));
      const hits: string[] = [];
      out.hits = hits;
      const drag = async (fromEl: Element, to: { x: number; y: number }, moveOn: Element = vp) => {
        const a = center(fromEl);
        const at = document.elementFromPoint(to.x, to.y) as HTMLElement | null;
        const fr = document.elementFromPoint(a.x, a.y) as HTMLElement | null;
        hits.push(`${fr === fromEl || fromEl.contains(fr) ? '' : 'FROM-HIDDEN(' + (fr ? fr.className : 'null') + '):'}${at ? (at.closest('[data-port],[data-target]') as HTMLElement | null)?.dataset.port ?? (at.closest('[data-target]') as HTMLElement | null)?.dataset.target ?? at.className : 'null'}`);
        fire(fromEl, 'pointerdown', a);
        fire(moveOn, 'pointermove', { x: (a.x + to.x) / 2, y: (a.y + to.y) / 2 });
        fire(moveOn, 'pointermove', to);
        fire(moveOn, 'pointerup', to);
        await sleep(300);
      };
      const byName = (n: string) => p().rules.find((r) => r.name === n);
      const tail = byName('尾巴');
      const hair = byName('头发');
      const horn = byName('角');
      if (!tail || !hair || !horn) return { ...out, ok: false, skipped: 'rules missing' };
      // zoom with the wheel: edges are in node space and must follow
      vp.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, clientX: 300, clientY: 300, bubbles: true, cancelable: true }));
      await sleep(80);
      checkEdges('zoom');
      // 1. click an option row (rebuild)
      const fish = tail.options.find((o) => o.name === '鱼尾')!;
      document.querySelector<HTMLElement>(`.ne-row[data-target="opt:${fish.id}"]`)!.click();
      await sleep(250);
      out.optionClick = (s.selection[tail.id] ?? [])[0] === fish.id;
      checkEdges('rebuild');
      // 2. wire one layer to another = mutex
      const longHair = hair.options.find((o) => o.name === '长发')!;
      const before = p().constraints.length;
      await drag(document.querySelector(`[data-port="opt:${fish.id}"]`)!, center(document.querySelector(`.ne-row[data-target="opt:${longHair.id}"]`)!));
      // dropping on another item asks mutex / require
      out.askMenu = document.querySelectorAll('.ne-pop .ne-pop-item').length;
      document.querySelector<HTMLElement>('.ne-pop .ne-pop-item.danger')?.click();
      await sleep(250);
      const c = p().constraints[before];
      out.mutexCreated = !!c && c.kind === 'mutex' && c.a.optionId === fish.id && c.b.optionId === longHair.id;
      checkEdges('mutex');
      // 3. drag a third layer onto that rule node = third item
      const twin = horn.options.find((o) => o.name === '双角')!;
      const conFoot = c ? document.querySelector(`.ne-node[data-node="${c.id}"] .ne-foot`) : null;
      if (conFoot) await drag(document.querySelector(`[data-port="opt:${twin.id}"]`)!, center(conFoot));
      const c2 = p().constraints.find((x) => x.id === c?.id);
      out.threeWay = !!c2 && (c2.more ?? []).length === 1 && c2.more![0].optionId === twin.id;
      // 4. tap the dot of a group: out of the product
      const raw0 = s.result!.rawCount;
      const dot = document.querySelector(`[data-port="rule:${horn.id}"]`)!;
      fire(dot, 'pointerdown', center(dot));
      fire(vp, 'pointerup', center(dot));
      await sleep(250);
      out.hornDisconnected = p().rules.find((r) => r.id === horn.id)!.enabled === false && s.result!.rawCount < raw0;
      const enabled = (id: string) => p().rules.find((r) => r.id === id)!.enabled;
      const emptySpot = () => {
        const vr = vp.getBoundingClientRect();
        for (let yy = vr.top + 20; yy < vr.bottom - 20; yy += 24)
          for (let xx = vr.left + 20; xx < vr.right - 20; xx += 24) {
            const e = document.elementFromPoint(xx, yy) as Element | null;
            if (e && vp.contains(e) && !e.closest('.ne-node') && !e.classList.contains('ne-hit') && !e.classList.contains('ne-mini')) return { x: xx, y: yy };
          }
        return null;
      };
      fitNodes();
      await sleep(100);
      // 4b. reconnect: the group's dot onto the product node
      await drag(document.querySelector(`[data-port="rule:${horn.id}"]`)!, center(document.querySelector('.ne-node.combine .ne-head')!));
      out.reconnected = enabled(horn.id);
      // 4c. tap the line -> disconnect
      const hit = document.querySelector<SVGPathElement>(`path.ne-hit[data-to="comb:${horn.id}"]`);
      if (hit) {
        const L = hit.getTotalLength();
        let tp: { x: number; y: number } | null = null;
        for (const f of [0.5, 0.35, 0.65, 0.2, 0.8]) {
          const q = new DOMPoint(hit.getPointAtLength(L * f).x, hit.getPointAtLength(L * f).y).matrixTransform(hit.getScreenCTM()!);
          if (document.elementFromPoint(q.x, q.y) === hit) {
            tp = { x: q.x, y: q.y };
            break;
          }
        }
        if (tp) {
          fire(hit, 'pointerdown', tp);
          fire(vp, 'pointerup', tp);
          await sleep(50);
          document.querySelector<HTMLElement>('.ne-pop .ne-pop-item.danger')?.click();
          await sleep(250);
        }
        out.edgeTapCut = !enabled(horn.id);
      }
      // 4d. reconnect, then pull the line off its input dot onto empty canvas
      await drag(document.querySelector(`[data-port="rule:${horn.id}"]`)!, center(document.querySelector('.ne-node.combine .ne-head')!));
      const inDot = document.querySelector(`[data-port="comb:${horn.id}"]`);
      const empty0 = emptySpot();
      if (inDot && empty0) await drag(inDot, empty0);
      out.liftCut = enabled(horn.id) === false;
      // 4e. group -> group: a whole group requires another (require)
      const nBefore = p().constraints.length;
      revealNode(tail.id);
      await sleep(100);
      await drag(document.querySelector(`[data-port="rule:${hair.id}"]`)!, center(document.querySelector(`.ne-node[data-node="${tail.id}"] .ne-head .ne-name`)!));
      document.querySelector<HTMLElement>('.ne-pop .ne-pop-item.ok')?.click();
      await sleep(250);
      const gg = p().constraints[nBefore];
      out.groupToGroup = !!gg && gg.kind === 'require' && gg.a.kind === 'rule' && gg.a.ruleId === hair.id && gg.b.kind === 'rule' && gg.b.ruleId === tail.id;
      if (gg) store.deleteConstraint(gg.id);
      await sleep(200);
      checkEdges('links');
      // 5. move a node by its title (the name, like a finger would), and a rule node by its grip
      const nameEl = document.querySelector(`.ne-node[data-node="${tail.id}"] .ne-head .ne-name`)!;
      const h0 = center(nameEl);
      fire(nameEl, 'pointerdown', h0);
      fire(vp, 'pointermove', { x: h0.x + 30, y: h0.y + 20 });
      fire(vp, 'pointermove', { x: h0.x + 60, y: h0.y + 40 });
      fire(vp, 'pointerup', { x: h0.x + 60, y: h0.y + 40 });
      await sleep(150);
      out.nodeMoved = !!p().nodeLayout?.[tail.id];
      checkEdges('move');
      const grip = c ? document.querySelector(`.ne-node[data-node="${c.id}"] .ne-grip`) : null;
      if (grip) {
        const g0 = center(grip);
        fire(grip, 'pointerdown', g0);
        fire(vp, 'pointermove', { x: g0.x + 20, y: g0.y + 30 });
        fire(vp, 'pointerup', { x: g0.x + 20, y: g0.y + 30 });
        await sleep(150);
      }
      out.ruleNodeMoved = !!c && !!p().nodeLayout?.[c.id];
      checkEdges('move-rule');
      // tap the name = rename box; Escape keeps the name
      const nm = document.querySelector(`.ne-node[data-node="${hair.id}"] .ne-head .ne-name`)!;
      fire(nm, 'pointerdown', center(nm));
      fire(vp, 'pointerup', center(nm));
      await sleep(50);
      const box = document.querySelector<HTMLInputElement>(`.ne-node[data-node="${hair.id}"] .ne-name-input`);
      out.tapRename = !!box && document.activeElement === box;
      box?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      // a node that grows without a rebuild: its edges follow
      const grow = document.querySelector<HTMLElement>(`.ne-node[data-node="${hair.id}"]`)!;
      grow.insertBefore(Object.assign(document.createElement('div'), { style: 'height:57px' }), grow.children[1]);
      await sleep(1200);
      checkEdges('grow');
      // 6. layer drawer: a FOLDER onto a group = one option; a layer onto empty space = new group
      document.querySelector<HTMLButtonElement>('.ne-bar .btn[title^="打开图层列表"]')!.click();
      await sleep(1100) // the drawer refits on the next frame (1 fps in a hidden window);
      checkEdges('drawer');
      const list = document.querySelector<HTMLElement>('.ne-drawer-list')!;
      const item = (name: string) => [...list.querySelectorAll<HTMLElement>('.ne-item')].find((x) => x.querySelector('.ne-label')?.textContent === name);
      revealNode(tail.id);
      await sleep(100);
      const wings = item('翅膀');
      const tailOpts = tail.options.length;
      const tailHead = document.querySelector(`.ne-node[data-node="${tail.id}"] .ne-head`)!;
      const dropAt = center(tailHead);
      const hitEl = document.elementFromPoint(dropAt.x, dropAt.y) as HTMLElement | null;
      out.folderDrop = { found: !!wings, hit: hitEl ? hitEl.className || hitEl.tagName : null };
      if (wings) await drag(wings, dropAt, list);
      const tailNow = p().rules.find((r) => r.id === tail.id)!;
      out.folderIsOneOption = tailNow.options.length === tailOpts + 1 && tailNow.options[tailNow.options.length - 1].name === '翅膀';
      const rulesBefore = p().rules.length;
      const mask = item('眼罩');
      // an empty spot of the canvas (not on a node, not under the drawer)
      const vr = vp.getBoundingClientRect();
      let spot: { x: number; y: number } | null = null;
      for (let yy = vr.top + 20; yy < vr.bottom - 20 && !spot; yy += 24)
        for (let xx = vr.left + 20; xx < vr.right - 20 && !spot; xx += 24) {
          const e = document.elementFromPoint(xx, yy) as HTMLElement | null;
          if (e && vp.contains(e) && !e.closest('.ne-node')) spot = { x: xx, y: yy };
        }
      if (mask && spot) await drag(mask, spot, list);
      out.newGroupFromDrop = p().rules.length === rulesBefore + 1;
      // 7. delete that option again
      const wingOpt = tailNow.options.find((o) => o.name === '翅膀');
      if (wingOpt) {
        document.querySelector<HTMLElement>(`.ne-row[data-target="opt:${wingOpt.id}"] .ne-x`)!.click();
        await sleep(200);
      }
      out.optionDeleted = p().rules.find((r) => r.id === tail.id)!.options.length === tailOpts;
      // 8. toolbar + mutex, then drop an option on it (fills the first slot)
      document.querySelector<HTMLButtonElement>('.ne-drawer .ne-x')!.click();
      await sleep(150);
      pickMenu('互斥');
      await sleep(250);
      fitNodes();
      await sleep(100);
      const empty = p().constraints[p().constraints.length - 1];
      const fox = tail.options.find((o) => o.name === '狐尾')!;
      revealNode(empty.id);
      await sleep(100);
      const emptyFoot = document.querySelector(`.ne-node[data-node="${empty.id}"] .ne-foot`);
      const ef = emptyFoot ? center(emptyFoot) : null;
      const efHit = ef ? (document.elementFromPoint(ef.x, ef.y) as HTMLElement | null) : null;
      out.step8 = { foot: !!emptyFoot, hit: efHit ? efHit.className || efHit.tagName : null, fox: !!document.querySelector(`[data-port="opt:${fox.id}"]`) };
      if (emptyFoot) await drag(document.querySelector(`[data-port="opt:${fox.id}"]`)!, center(emptyFoot));
      out.emptyMutexFilled = p().constraints.find((x) => x.id === empty.id)?.a.optionId === fox.id;
      checkEdges('after-edits');
      // 9. options that are parts of ONE variant: warning + fix
      const face1 = p().layers.find((l) => l.cleanName === '表情1' && l.kind === 'group');
      if (face1) {
        store.addRuleFromGroup(face1.id, 'exclusive');
        await sleep(250);
        const bad = p().rules[p().rules.length - 1];
        const w = store.ruleWarning(bad);
        out.partsWarning = !!w && document.querySelector(`.ne-node[data-node="${bad.id}"] .ne-warn`) !== null;
        w?.fixes[0].run();
        await sleep(250);
        const fixed = p().rules.find((r) => r.id === bad.id)!;
        out.partsFixed = fixed.options.map((o) => o.name).join('/');
      }
      // the editor survives idle re-renders (not rebuilt on light updates)
      const keep = document.querySelector('.ne-node');
      store.notify(true);
      await sleep(120);
      out.stable = document.querySelector('.ne-node') === keep;
      out.finalDom = {
        rules: document.querySelectorAll('.ne-node.con').length,
        combine: document.querySelector('.ne-node.combine .ne-foot')?.textContent,
        exportCount: document.querySelector('[data-count]')?.textContent,
      };
      out.maxEdgeError = Math.max(...align);
      // start over: everything back to a fresh import
      store.startFresh(false);
      await sleep(200);
      const fp = p();
      const freshOk = fp.constraints.length === 0 && !Object.keys(fp.visibility ?? {}).length && !Object.keys(fp.nodeLayout ?? {}).length;
      out.ok = !!(
        freshOk &&
        out.open &&
        out.nodes === out.expectedNodes &&
        out.overlaps === 0 &&
        out.optionClick &&
        out.mutexCreated &&
        out.reconnected &&
        out.edgeTapCut &&
        out.liftCut &&
        out.groupToGroup &&
        out.threeWay &&
        out.hornDisconnected &&
        out.nodeMoved &&
        out.ruleNodeMoved &&
        out.tapRename &&
        out.folderIsOneOption &&
        out.newGroupFromDrop &&
        out.optionDeleted &&
        out.emptyMutexFilled &&
        out.partsWarning &&
        out.partsFixed === '表情3/表情1/表情2' &&
        out.stable &&
        (out.maxEdgeError as number) <= 1
      );
      return out;
    },
    /** Phone: open the panel sheet on a tab. */
    openTab(tab: store.TabId) {
      store.setTab(tab);
      store.state.sheetOpen = true;
      store.state.sheetTall = true;
      store.notify();
    },
    /** Close the open document and go back to the home screen. */
    closeToHome() {
      store.closeProject();
      store.state.recent = loadRecent();
      store.notify();
    },
    summary() {
      const r = store.state.result!;
      return { combos: r.combos.length, raw: r.rawCount, rejected: r.rejected.length, labels: r.combos.map((c) => c.labels) };
    },
    compare: () => engine.compare(),
    /** export selection: untick the first combination, then report counts */
    selectionCheck() {
      const all = store.state.result!.combos;
      store.selectAllCombos('all');
      const full = store.selectedCombos().length;
      if (all[0]) store.toggleComboExport(all[0].signature);
      const minusOne = store.selectedCombos().length;
      store.selectAllCombos('invert');
      const inverted = store.selectedCombos().length;
      store.selectAllCombos('all');
      return { total: all.length, full, minusOne, inverted, restored: store.selectedCombos().length };
    },
    /** New UI features: eye toggle latency, search, export scopes, config round trip. */
    async featureCheck() {
      const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      const s = store.state;
      const p = s.project!;
      const out: Record<string, unknown> = {};
      store.setTab('layers');
      await frame();
      // eye toggles through the real DOM, timed until the next painted frame
      // (hidden test windows run rAF at 1 fps, so poll for the rebuilt row instead)
      let sync = 0;
      let total = 0;
      for (let i = 0; i < 6; i++) {
        const eye = document.querySelector<HTMLButtonElement>('.tree-row button.eye');
        if (!eye) break;
        const before = eye.className + eye.dataset.icon;
        const t0 = performance.now();
        eye.click();
        sync += performance.now() - t0;
        // patched in place (or rebuilt): wait until the first row's eye changed
        const changed = () => {
          const now = document.querySelector<HTMLButtonElement>('.tree-row button.eye');
          return now !== eye || eye.className + eye.dataset.icon !== before;
        };
        for (let k = 0; k < 600 && !changed(); k++) await new Promise((r) => setTimeout(r, 5));
        total += performance.now() - t0;
      }
      out.eyeClickMs = Math.round(sync / 6);
      out.eyeUpdateMs = Math.round(total / 6);
      out.eyeOverrides = Object.keys(p.visibility ?? {}).length; // 6 toggles = back to original
      const name = p.layers[0].cleanName;
      // type into the real search box: it must keep focus and the panel must not be rebuilt
      const box = document.querySelector<HTMLInputElement>('.search')!;
      const panel = document.querySelector('.tab-panel');
      const allBefore = document.querySelectorAll('.tree-row').length;
      box.focus();
      box.value = name;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      out.searchRows = document.querySelectorAll('.tree-row').length;
      out.searchKeepsFocus = document.activeElement === box && document.querySelector('.tab-panel') === panel;
      box.value = '';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      box.blur();
      await frame();
      out.allRows = Math.max(allBefore, document.querySelectorAll('.tree-row').length);
      const valid = s.result!.combos.length;
      store.setExportScope('all');
      out.scopeAll = store.selectedCombos().length;
      store.setExportScope('valid');
      out.scopeValid = store.selectedCombos().length;
      store.setExportScope('selected');
      const text = exportConfigText();
      importConfigText(text);
      out.configRoundTrip = s.result!.combos.length === valid && exportConfigText().length === text.length;
      out.ok =
        out.eyeOverrides === 0 &&
        (out.searchRows as number) >= 1 &&
        (out.searchRows as number) <= (out.allRows as number) &&
        (out.scopeAll as number) >= valid &&
        out.scopeValid === valid &&
        out.configRoundTrip === true &&
        out.searchKeepsFocus === true;
      return out;
    },
    /** Raw full-size RGBA of combination i. */
    rawFull: (i: number) => engine.render(store.state.result!.combos[i].on, 'full'),
    /** Full-size PNG of combination i, as bytes. */
    async exportPng(i: number) {
      const c = store.state.result!.combos[i];
      return (await engine.exportImage(c.on, 'png', 100, 1)).bytes;
    },
    /** Run the real export into an in-memory ZIP. */
    async exportZipInMemory(limit?: number) {
      const chunks: Uint8Array[] = [];
      let zip: ZipWriter;
      const target: ExportTarget = {
        platform: 'web',
        async begin() {
          zip = new ZipWriter((c) => void chunks.push(c.slice()));
        },
        async add(path, data) {
          await zip.addEntry(path, data);
        },
        async finish() {
          await zip.finish();
          return { location: 'memory', entries: zip.entries.length, archiveBytes: zip.totalBytes };
        },
        async cancel() {},
      };
      const res = await runExport({
        project: store.state.project!,
        combos: store.state.result!.combos.slice(0, limit ?? Infinity),
        target,
        onProgress: () => undefined,
        shouldCancel: () => false,
      });
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) {
        out.set(c, o);
        o += c.length;
      }
      return { entries: res.entries, bytes: out };
    },
    /** Real platform target (Electron self-test writes to the given folder). */
    async exportWithPlatformTarget() {
      const res = await runExport({
        project: store.state.project!,
        combos: store.state.result!.combos,
        target: await createTarget(),
        onProgress: () => undefined,
        shouldCancel: () => false,
      });
      return { ok: !res.cancelled, ...res };
    },
  };
}
