/**
 * UI state container: a plain object, explicit notify(), no framework
 * (keeps the APK small and the code easy to follow).
 */

import {
  buildIndex,
  choiceCount,
  computeVisibility,
  MULTI_LIMIT,
  defaultSelection,
  enumerate,
  findViolations,
  hasExportTags,
  isDrawn,
  normalizeSelection,
  ruleFromGroupChildren,
  ruleFromLayers,
  suggestRules,
  toggleOption,
  type Combo,
  type EnumerateResult,
  type RuleIndex,
  type Visibility,
} from '../core/rules';
import type { Constraint, ConstraintKind, LayerNode, Project, Rule, RuleKind, Selection, Target } from '../core/model';
import { uid } from '../core/model';
import { applyConfig, buildConfig, detectAtomicGroups, labelKey, parseConfig } from '../core/config';
import { isGenericName, suggestGroups, suggestionProduct, type Suggestion } from '../core/suggest';
import { defaultSettings } from '../core/model';
import { detectPlatform, type Platform } from '../core/platform';
import { engine } from '../engine/client';
import EnumerateWorker from '../core/enumerate.worker?worker';
import type { Calibration, CompareResult, ProfileId, RenderedImage } from '../engine/protocol';
import { loadRecent, type RecentEntry } from './recent';
import { invalidatePreview, schedulePreview } from './preview';
import { t as tr } from '../i18n';

export {
  clearThumbQueue,
  imageToCanvas,
  previewPending,
  previewSourceCanvas,
  requestComboThumb,
  schedulePreview,
  setPreviewCanvas,
} from './preview';

export type TabId = 'layers' | 'rules' | 'constraints' | 'combos' | 'export' | 'settings';

export interface Toast {
  id: string;
  text: string;
  tone: 'info' | 'ok' | 'bad';
}

export interface State {
  platform: Platform;
  tab: TabId;
  sheetOpen: boolean;
  project: Project | null;
  idx: RuleIndex | null;
  selection: Selection;
  vis: Visibility | null;
  result: EnumerateResult | null;
  /** layer id -> thumbnail data URL */
  thumbs: Map<string, string>;
  /** combo signature -> thumbnail data URL */
  comboThumbs: Map<string, string>;
  checked: Set<string>;
  collapsed: Set<string>;
  /** combinations the user unticked (by signature); everything else is exported */
  excludedCombos: Set<string>;
  search: string;
  suggestPicks: Record<string, { on?: boolean; kind?: RuleKind }>;
  suggestOff: boolean;
  /** settings restored from the last session, shown as a notice */
  restoredInfo: { rules: number; constraints: number } | null;
  autoRestore: boolean;
  prefs: Prefs;
  nodeEditorOpen: boolean;
  exportScope: 'selected' | 'valid' | 'all' | 'current';
  sheetTall: boolean;
  guidesHidden: boolean;
  /** index of the combination shown in the preview, -1 = manual selection */
  focusCombo: number;
  previewBusy: boolean;
  previewSize: { width: number; height: number } | null;
  busy: string | null;
  busyProgress: number;
  cancellable: boolean;
  toasts: Toast[];
  exporting: boolean;
  exportResult: { summary: string; elapsedMs: number; entries: number; archiveBytes: number; location: string } | null;
  compare: CompareResult | null;
  warnings: string[];
  /** app that wrote the PSD, when it recorded one */
  writer: string;
  calibration: Calibration | null;
  helpOpen: boolean;
  /** option whose layers are being edited in the picker */
  editingOption: { ruleId: string; optionId: string } | null;
  /** recently opened files, newest first */
  recent: RecentEntry[];
  /** whether the user dismissed the home screen to import something new */
  homeDismissed: boolean;
}

export const state: State = {
  platform: detectPlatform(),
  tab: 'layers',
  sheetOpen: false,
  project: null,
  idx: null,
  selection: {},
  vis: null,
  result: null,
  thumbs: new Map(),
  comboThumbs: new Map(),
  checked: new Set(),
  collapsed: new Set(),
  excludedCombos: new Set(),
  search: '',
  suggestPicks: {},
  suggestOff: false,
  restoredInfo: null,
  autoRestore: (() => {
    try {
      return localStorage.getItem('psd-export:auto-restore') !== '0';
    } catch {
      return true;
    }
  })(),
  nodeEditorOpen: false,
  prefs: loadPrefs(),
  exportScope: 'selected',
  sheetTall: false,
  guidesHidden: (() => {
    try {
      return localStorage.getItem('psd-export:guides-hidden') === '1';
    } catch {
      return false;
    }
  })(),
  focusCombo: -1,
  previewBusy: false,
  previewSize: null,
  busy: null,
  busyProgress: 0,
  cancellable: false,
  toasts: [],
  exporting: false,
  exportResult: null,
  compare: null,
  warnings: [],
  writer: '',
  calibration: null,
  helpOpen: false,
  editingOption: null,
  recent: loadRecent(),
  homeDismissed: false,
};

type Listener = () => void;
const listeners = new Set<Listener>();
let documentChangeHook: (() => void) | null = null;

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setDocumentChangeHook(fn: () => void): void {
  documentChangeHook = fn;
}

let scheduled = false;
let patchPending = false;
let sidebarDirty = true;

export function notifyPatch(): void {
  patchPending = true;
  notify(true);
}

export function takePatch(): boolean {
  const p = patchPending;
  patchPending = false;
  return p;
}

export function takeSidebarDirty(): boolean {
  const d = sidebarDirty;
  sidebarDirty = false;
  return d;
}

/**
 * Schedule a re-render. `light` updates (preview progress, toasts, busy
 * overlay, thumbnails) leave the side panel alone; rebuilding hundreds of
 * layer rows on every one of those made toggling feel unresponsive.
 */
export function notify(light = false): void {
  if (!light) sidebarDirty = true;
  if (scheduled) return;
  scheduled = true;
  const flush = () => {
    if (!scheduled) return;
    scheduled = false;
    for (const fn of listeners) fn();
  };
  // rAF normally wins; the timer covers pages that never paint
  // (minimised window, headless self-test)
  requestAnimationFrame(flush);
  setTimeout(flush, 50);
}

export function setBusy(label: string | null, progress = 0, cancellable = false): void {
  state.busy = label;
  state.busyProgress = progress;
  state.cancellable = cancellable;
  notify(true);
}

export function toast(text: string, tone: Toast['tone'] = 'info'): void {
  const t: Toast = { id: uid('toast'), text, tone };
  state.toasts = [...state.toasts, t];
  notify(true);
  setTimeout(() => {
    state.toasts = state.toasts.filter((x) => x.id !== t.id);
    notify(true);
  }, tone === 'bad' ? 6000 : 3500);
}

export function setTab(tab: TabId): void {
  state.tab = tab;
  state.sheetOpen = true;
  notify();
}

/* Persistence: rules survive re-opening the same PSD */

/** Key the configuration of this document is persisted under. */
export function storageKeyOf(p: Project): string {
  let h = 0;
  for (const l of p.layers) for (let i = 0; i < l.name.length; i++) h = (h * 31 + l.name.charCodeAt(i)) | 0;
  return `psd-export:rules:${p.name}:${p.width}x${p.height}:${p.layers.length}:${h >>> 0}`;
}

function storageKey(p: Project): string {
  return storageKeyOf(p);
}

export function save(): void {
  const p = state.project;
  if (!p) return;
  try {
    localStorage.setItem(
      storageKey(p),
      JSON.stringify({
        rules: p.rules,
        constraints: p.constraints,
        settings: p.settings,
        selection: state.selection,
        visibility: p.visibility ?? {},
        atomic: p.atomic ?? [],
        atomicV: 2,
        nodeLayout: p.nodeLayout ?? {},
        nodeNotes: p.nodeNotes ?? [],
        nodeBundles: p.nodeBundles ?? [],
        suggestOff: state.suggestOff,
        excluded: [...state.excludedCombos],
      }),
    );
  } catch {
    /* storage full or unavailable: not critical */
  }
}

function restore(p: Project): { selection: Selection } | null {
  try {
    const raw = localStorage.getItem(storageKey(p));
    if (!raw) return null;
    const data = JSON.parse(raw);
    const ok = (ids: string[]) => ids.every((id) => p.layerIndex[id]);
    if (!Array.isArray(data.rules) || !data.rules.every((r: Rule) => r.options.every((o) => ok(o.layerIds)))) return null;
    p.rules = data.rules;
    p.constraints = Array.isArray(data.constraints) ? data.constraints : [];
    p.settings = { ...p.settings, ...(data.settings ?? {}) };
    p.visibility = data.visibility ?? {};
    // part groups saved by an older recogniser are detected again
    p.atomic = Array.isArray(data.atomic) && data.atomicV === 2 ? data.atomic.filter((id: string) => p.layerIndex[id]) : undefined;
    state.suggestOff = !!data.suggestOff;
    p.nodeLayout = data.nodeLayout && typeof data.nodeLayout === 'object' ? data.nodeLayout : {};
    p.nodeNotes = Array.isArray(data.nodeNotes) ? data.nodeNotes : [];
    p.nodeBundles = Array.isArray(data.nodeBundles) ? data.nodeBundles.filter((b: { layerIds: string[] }) => b.layerIds.every((id) => p.layerIndex[id])) : [];
    state.excludedCombos = new Set(Array.isArray(data.excluded) ? data.excluded : []);
    return { selection: data.selection ?? {} };
  } catch {
    return null;
  }
}

/* Project lifecycle */

export function loadProject(
  project: Project,
  thumbs: Map<string, string>,
  warnings: string[],
  meta: { writer: string; calibration: Calibration | null } = { writer: '', calibration: null },
): void {
  state.writer = meta.writer;
  state.calibration = meta.calibration;
  state.project = project;
  state.thumbs = thumbs;
  state.comboThumbs = new Map();
  state.checked = new Set();
  state.collapsed = new Set();
  state.excludedCombos = new Set();
  allResultKey = '';
  state.warnings = warnings;
  state.compare = null;
  state.exportResult = null;
  state.focusCombo = -1;
  state.previewSize = null;
  invalidatePreview();
  documentChangeHook?.();
  undoStack = [];
  redoStack = [];
  current = null;
  state.nodeEditorOpen = state.prefs.nodeDefault;

  const restored = state.autoRestore ? restore(project) : null;
  state.restoredInfo = restored ? { rules: project.rules.length, constraints: project.constraints.length } : null;
  if (restored) {
    state.selection = normalizeSelection(project, restored.selection);
  } else {
    project.rules = suggestRules(project);
    state.selection = defaultSelection(project);
  }
  // part groups (line art + colour + highlight ...) behave as one layer
  if (!project.atomic) project.atomic = detectAtomicGroups(project);
  state.search = '';
  state.suggestPicks = {};
  // a compositing choice saved for this file wins over auto-detection
  if (project.settings.profile) void engine.setProfile(project.settings.profile);
  // start with every group collapsed except the top level: big PSDs stay readable
  for (const l of project.layers) if (l.kind === 'group' && l.children.length > 6) state.collapsed.add(l.id);
  state.tab = project.rules.length ? 'rules' : 'layers';
  refresh();
}

export function closeProject(): void {
  engine.dispose();
  state.project = null;
  state.vis = null;
  state.result = null;
  state.previewSize = null;
  notify();
}

let resultKey = '';
let allResultKey = '';
let allResult: EnumerateResult | null = null;

export function invalidateResultCache(): void {
  resultKey = '';
  allResultKey = '';
  allResult = null;
}

/** Every possibility, ignoring cross-group rules (computed on demand). */
export function allPossibleResult(): EnumerateResult | null {
  const p = state.project;
  if (!p) return null;
  const frozen = Object.fromEntries(p.rules.filter((r) => !r.enabled).map((r) => [r.id, state.selection[r.id] ?? []]));
  const key = JSON.stringify([p.rules, p.visibility ?? {}, frozen]);
  if (key !== allResultKey || !allResult) {
    allResultKey = key;
    allResult = enumerate(p, { base: state.selection, ignoreConstraints: true });
  }
  return allResult;
}

/** Recompute index, visibility and enumeration after any rule edit. */
let enumerateTimer: number | undefined;

/**
 * Recompute after an edit. `quick` (eye toggles): visibility and preview update
 * at once and the panel is patched in place; the full product is re-counted
 * once the user pauses (with a big product that took ~60 ms per click on a
 * PC and far longer on phones).
 */
export function refresh(opts: { keepFocus?: boolean; quick?: boolean } = {}): void {
  const p = state.project;
  if (!p) return notify();
  p.updatedAt = Date.now();
  syncBundles(p);
  state.idx = buildIndex(p);
  state.selection = normalizeSelection(p, state.selection);
  state.vis = computeVisibility(p, state.selection, state.idx);
  if (opts.quick) {
    commitHistory();
    save();
    schedulePreview(0);
    notifyPatch();
    clearTimeout(enumerateTimer);
    enumerateTimer = window.setTimeout(enumerateInBackground, 120);
    return;
  }
  clearTimeout(enumerateTimer);
  updateResult();
  if (!opts.keepFocus) state.focusCombo = -1;
  commitHistory();
  save();
  schedulePreview();
  notify();
}

/* The product is re-counted on a worker after eye toggles: with a big
   product it took up to a second of main-thread time on phones. */
let enumWorker: Worker | null = null;
let enumSeq = 0;

function resultKeyNow(p: Project): string {
  const frozen = Object.fromEntries(p.rules.filter((r) => !r.enabled).map((r) => [r.id, state.selection[r.id] ?? []]));
  return JSON.stringify([p.rules, p.constraints, p.visibility ?? {}, frozen]);
}

/** Give slim combinations from the worker their layer sets, computed on first use. */
function hydrate(r: EnumerateResult, p: Project): EnumerateResult {
  for (const c of r.combos) {
    let vis: ReturnType<typeof computeVisibility> | null = null;
    const get = () => (vis ??= computeVisibility(p, c.selection, state.idx ?? undefined));
    Object.defineProperty(c, 'on', { get: () => get().on, enumerable: true, configurable: true });
    Object.defineProperty(c, 'drawn', { get: () => get().drawn, enumerable: true, configurable: true });
  }
  return r;
}

function enumerateInBackground(): void {
  const p = state.project;
  if (!p) return;
  const key = resultKeyNow(p);
  if (key === resultKey && state.result) return;
  const seq = ++enumSeq;
  const fallback = () => {
    if (seq !== enumSeq || state.project !== p) return;
    updateResult();
    notifyPatch();
  };
  try {
    enumWorker ??= new EnumerateWorker();
  } catch {
    return fallback();
  }
  enumWorker.onmessage = (ev: MessageEvent<{ id: number; result?: EnumerateResult; error?: string }>) => {
    if (ev.data.id !== enumSeq || state.project !== p) return;
    if (!ev.data.result) return fallback();
    // the worker may answer for an older edit: only accept the current one
    if (resultKeyNow(p) !== key) return;
    resultKey = key;
    state.result = hydrate(ev.data.result, p);
    notifyPatch();
  };
  enumWorker.onerror = () => fallback();
  try {
    enumWorker.postMessage({ id: seq, project: p, base: state.selection });
  } catch {
    fallback();
  }
}

function updateResult(): void {
  const p = state.project!;
  // re-enumerate only when something that affects the product changed: a click
  // on an option of a group in the product does not change the product itself
  const frozen = Object.fromEntries(p.rules.filter((r) => !r.enabled).map((r) => [r.id, state.selection[r.id] ?? []]));
  const key = JSON.stringify([p.rules, p.constraints, p.visibility ?? {}, frozen]);
  if (key !== resultKey || !state.result) {
    resultKey = key;
    state.result = enumerate(p, { base: state.selection });
  }
}

/* Selection */

/** What clicking this option would violate, or null. */
export function optionConflict(ruleId: string, optionId: string): string | null {
  const p = state.project;
  if (!p || !state.idx) return null;
  const trial = toggleOption(p, state.selection, ruleId, optionId);
  const v = findViolations(p, trial, state.idx);
  return v.length ? v[0].message : null;
}

export function clickOption(ruleId: string, optionId: string): void {
  const p = state.project;
  if (!p) return;
  const conflict = optionConflict(ruleId, optionId);
  state.selection = toggleOption(p, state.selection, ruleId, optionId);
  refresh();
  if (conflict) toast(tr('store.selectionConflict', { conflict }), 'bad');
}

export function currentViolations(): string[] {
  const p = state.project;
  if (!p || !state.idx) return [];
  return findViolations(p, state.selection, state.idx).map((v) => v.message);
}

export function showCombo(index: number): void {
  const combo = state.result?.combos[index];
  if (!combo) return;
  state.selection = { ...combo.selection };
  refresh({ keepFocus: true });
  state.focusCombo = index;
  state.sheetOpen = false;
  notify();
}

export function resetSelection(): void {
  if (!state.project) return;
  state.selection = defaultSelection(state.project);
  refresh();
}

/* Rule editing */

function rule(ruleId: string): Rule | undefined {
  return state.project?.rules.find((r) => r.id === ruleId);
}

export function addRuleFromChecked(kind: RuleKind, asOneOption: boolean): void {
  const p = state.project;
  if (!p || state.checked.size === 0) return;
  // keep layer-panel order (top-most first)
  const ids = p.layers.filter((l) => state.checked.has(l.id)).map((l) => l.id).reverse();
  let r: Rule;
  if (asOneOption) {
    r = ruleFromLayers(p, [], kind, tr('store.groupNumber', { n: p.rules.length + 1 }));
    r.options = [{ id: uid('opt'), name: p.layerIndex[ids[0]].cleanName, layerIds: ids, source: '' }];
  } else {
    r = ruleFromLayers(p, ids, kind);
  }
  p.rules.push(r);
  state.checked.clear();
  autoSelect(r);
  refresh();
  toast(tr('store.groupCreated', { name: r.name, n: r.options.length }), 'ok');
}

export function addRuleFromGroup(groupId: string, kind: RuleKind = 'exclusive'): void {
  const p = state.project;
  if (!p) return;
  const r = ruleFromGroupChildren(p, groupId, kind);
  if (!r) return toast(tr('store.emptyGroup'), 'bad');
  p.rules.push(r);
  autoSelect(r);
  refresh();
  toast(tr('store.childrenAdded', { name: r.name, n: r.options.length }), 'ok');
}

/** Add the ticked layers as new options of an existing group. */
export function addCheckedToRule(ruleId: string, asOneOption: boolean): void {
  const p = state.project;
  const r = rule(ruleId);
  if (!p || !r || state.checked.size === 0) return;
  const ids = p.layers.filter((l) => state.checked.has(l.id)).map((l) => l.id).reverse();
  if (asOneOption) r.options.push({ id: uid('opt'), name: p.layerIndex[ids[0]].cleanName, layerIds: ids, source: '' });
  else for (const id of ids) r.options.push({ id: uid('opt'), name: p.layerIndex[id].cleanName, layerIds: [id], source: '' });
  state.checked.clear();
  refresh();
  toast(tr('store.addedToGroup', { name: r.name }), 'ok');
}

function autoSelect(r: Rule): void {
  if (!state.project) return;
  const sel = defaultSelection({ ...state.project, rules: [r] });
  if (sel[r.id]) state.selection[r.id] = sel[r.id];
}

export function addEmptyRule(): void {
  const p = state.project;
  if (!p) return;
  p.rules.push({ id: uid('rule'), name: tr('store.groupNumber', { n: p.rules.length + 1 }), kind: 'optional', options: [], enabled: true, source: 'manual' });
  refresh();
}

export function setRuleKind(ruleId: string, kind: RuleKind): void {
  const r = rule(ruleId);
  if (!r) return;
  r.kind = kind;
  refresh();
}

export function setRuleEnabled(ruleId: string, enabled: boolean): void {
  const r = rule(ruleId);
  if (!r) return;
  r.enabled = enabled;
  refresh();
}

export function renameRule(ruleId: string, name: string): void {
  const r = rule(ruleId);
  if (!r) return;
  r.name = name.trim() || r.name;
  refresh({ keepFocus: true });
}

export function moveRule(ruleId: string, delta: number): void {
  const p = state.project;
  if (!p) return;
  const i = p.rules.findIndex((r) => r.id === ruleId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= p.rules.length) return;
  [p.rules[i], p.rules[j]] = [p.rules[j], p.rules[i]];
  refresh();
}

const targetRefs = (t: Target, ruleId?: string, optionIds?: Set<string>) =>
  (t.kind === 'rule' && t.ruleId === ruleId) || (t.kind === 'option' && !!t.optionId && !!optionIds?.has(t.optionId));

export function deleteRule(ruleId: string): void {
  const p = state.project;
  const r = rule(ruleId);
  if (!p || !r) return;
  const optionIds = new Set(r.options.map((o) => o.id));
  p.rules = p.rules.filter((x) => x.id !== ruleId);
  dropTargets(p, (t) => targetRefs(t, ruleId, optionIds));
  delete state.selection[ruleId];
  refresh();
}

/** Remove matching targets from every rule; constraints left with < 2 targets go. */
function dropTargets(p: Project, match: (t: Target) => boolean): void {
  const keep: Constraint[] = [];
  for (const c of p.constraints) {
    const all = [c.a, c.b, ...(c.more ?? [])];
    const left = all.filter((t) => !match(t));
    if (left.length === all.length) keep.push(c);
    else if (c.kind === 'mutex' && left.length >= 2) keep.push({ ...c, a: left[0], b: left[1], more: left.slice(2) });
  }
  p.constraints = keep;
}

/** Clear: every option group and the rules that refer to them. */
export function clearRules(): void {
  const p = state.project;
  if (!p || !p.rules.length) return;
  if (!confirm(tr('store.clearGroupsConfirm', { n: p.rules.length }))) return;
  p.rules = [];
  dropTargets(p, (t) => t.kind !== 'layer');
  state.selection = {};
  state.excludedCombos = new Set();
  refresh();
  toast(tr('store.groupsCleared'), 'ok');
}

/** Reset all: back to how the file looks when imported for the first time. */
export function startFresh(ask = true): void {
  const p = state.project;
  if (!p) return;
  if (ask && !confirm(tr('store.resetFileConfirm'))) return;
  try {
    localStorage.removeItem(storageKey(p));
  } catch {
    /* ignore */
  }
  p.rules = suggestRules(p);
  p.constraints = [];
  p.visibility = {};
  p.nodeLayout = {};
  p.nodeNotes = [];
  p.nodeBundles = [];
  p.settings = { ...defaultSettings(), profile: undefined };
  p.atomic = detectAtomicGroups(p);
  state.selection = defaultSelection(p);
  state.excludedCombos = new Set();
  state.checked = new Set();
  state.suggestPicks = {};
  state.suggestOff = false;
  state.restoredInfo = null;
  state.exportScope = 'selected';
  void engine.setProfile(state.calibration?.profile ?? 'photoshop');
  invalidatePreview();
  refresh();
  toast(tr('store.fileReset'), 'ok');
}

export function dismissRestored(): void {
  state.restoredInfo = null;
  notify();
}

/* ---- preferences (all files) ---- */

export interface Prefs {
  /** progress shows the file name (else only "n / total") */
  progressNames: boolean;
  confirmBig: boolean;
  notifyDone: boolean;
  /** 0 = automatic */
  encoders: number;
  /** 0 = automatic (desktop only; applies on the next import) */
  workers: number;
  quickPreview: boolean;
  miniPreview: boolean;
  nodeDefault: boolean;
  /** 'auto' follows the system language */
  locale: 'auto' | 'zh-CN' | 'en';
  /** how many recent files the home screen lists */
  recentCount: number;
}

// a function (hoisted): the state object above reads it while the module loads
function defaultPrefs(): Prefs {
  return {
    progressNames: true,
    confirmBig: true,
    notifyDone: true,
    encoders: 0,
    workers: 0,
    quickPreview: true,
    miniPreview: true,
    nodeDefault: true,
    locale: 'auto',
    recentCount: 10,
  };
}

function loadPrefs(): Prefs {
  try {
    return { ...defaultPrefs(), ...JSON.parse(localStorage.getItem('psd-export:prefs') ?? '{}') };
  } catch {
    return defaultPrefs();
  }
}

function savePrefs(): void {
  try {
    localStorage.setItem('psd-export:prefs', JSON.stringify(state.prefs));
  } catch {
    /* ignore */
  }
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  state.prefs = { ...state.prefs, [key]: value };
  savePrefs();
  notify();
}

export function resetPrefs(): void {
  state.prefs = defaultPrefs();
  savePrefs();
  notify();
  toast(tr('store.prefsReset'), 'ok');
}

const cores = () => navigator.hardwareConcurrency || 4;

/** Compositing workers (each holds a copy of the layers). */
export function autoWorkers(): number {
  if (state.platform === 'android') return 1;
  return Math.max(1, Math.min(4, cores() - 1));
}

export function workerCount(): number {
  if (state.platform === 'android') return 1;
  return state.prefs.workers || autoWorkers();
}

/**
 * PNG compression workers (no document copy). Compressing a picture takes about
 * twice as long as compositing it, so there are about twice as many of them.
 */
export function autoEncoders(): number {
  const c = cores();
  if (state.platform === 'android') return c < 6 ? 1 : c < 8 ? 2 : 3;
  return Math.max(2, Math.min(8, c - workerCount() - 1, workerCount() * 2 + 1));
}

export function encoderCount(): number {
  return state.prefs.encoders || autoEncoders();
}

const SAVED_PREFIX = 'psd-export:rules:';

export function savedFileCount(): number {
  try {
    let n = 0;
    for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i)?.startsWith(SAVED_PREFIX)) n++;
    return n;
  } catch {
    return 0;
  }
}

export function clearSavedFiles(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(SAVED_PREFIX)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  toast(tr('store.savedCleared', { n: keys.length }), 'ok');
  } catch {
    /* ignore */
  }
  notify();
}

export function setAutoRestore(on: boolean): void {
  state.autoRestore = on;
  try {
    localStorage.setItem('psd-export:auto-restore', on ? '1' : '0');
  } catch {
    /* ignore */
  }
  notify();
}

/* ---- node editor ---- */

export function setNodeEditor(open: boolean): void {
  state.nodeEditorOpen = open;
  if (open) state.sheetOpen = false;
  notify();
}

/** Remember where the user put a node (no re-render). */
export function setNodePos(id: string, x: number, y: number): void {
  const p = state.project;
  if (!p) return;
  p.nodeLayout = { ...(p.nodeLayout ?? {}), [id]: { x: Math.round(x), y: Math.round(y) } };
  commitHistory();
  save();
  notify(true); // undo / redo buttons
}

export function resetNodeLayout(): void {
  if (!state.project) return;
  state.project.nodeLayout = {};
  commitHistory();
  save();
  notify();
}

const sameTarget = (a: Target, b: Target) =>
  a.kind === b.kind && (a.kind === 'rule' ? a.ruleId === b.ruleId : a.kind === 'option' ? a.optionId === b.optionId : a.layerId === b.layerId);

/** Wire two things together as "can't appear together" (returns the new rule's id). */
export function connectMutex(a: Target, b: Target): string | null {
  const p = state.project;
  if (!p || sameTarget(a, b)) return null;
  const c: Constraint = { id: uid('con'), kind: 'mutex', a, b, more: [], enabled: true, preset: 'multiMutex' };
  p.constraints.push(c);
  refresh();
  return c.id;
}

/** A two-item rule (mutex or "A needs B") between options and / or whole groups. */
export function connectConstraint(kind: Constraint['kind'], a: Target, b: Target): string | null {
  const p = state.project;
  if (!p || sameTarget(a, b)) return null;
  const c: Constraint = { id: uid('con'), kind, a, b, more: [], enabled: true, preset: kind === 'mutex' ? 'multiMutex' : 'requires' };
  p.constraints.push(c);
  refresh();
  return c.id;
}

/** Take one item out of a rule; a two-item rule keeps an empty slot to drop into. */
export function clearConstraintTarget(id: string, i: number): void {
  const c = state.project?.constraints.find((x) => x.id === id);
  if (!c) return;
  const all = [c.a, c.b, ...(c.more ?? [])];
  if (all.length > 2) all.splice(i, 1);
  else all[i] = { kind: 'option' };
  c.a = all[0];
  c.b = all[1];
  c.more = all.slice(2);
  refresh();
}

/* Undo / redo */

interface Snap {
  doc: string;
  sel: string;
}
let undoStack: Snap[] = [];
let redoStack: Snap[] = [];
let current: Snap | null = null;
let restoring = false;

function docKey(p: Project): string {
  return JSON.stringify({
    r: p.rules,
    c: p.constraints,
    v: p.visibility ?? {},
    a: p.atomic ?? [],
    l: p.nodeLayout ?? {},
    n: p.nodeNotes ?? [],
    b: p.nodeBundles ?? [],
    s: p.settings,
    x: [...state.excludedCombos],
    scope: state.exportScope,
  });
}

/** Record the document after a change (picking an option alone is not a step). */
function commitHistory(): void {
  const p = state.project;
  if (!p || restoring) return;
  const snap = { doc: docKey(p), sel: JSON.stringify(state.selection) };
  if (!current) {
    current = snap;
    return;
  }
  if (snap.doc === current.doc) {
    current.sel = snap.sel;
    return;
  }
  undoStack.push(current);
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
  current = snap;
}

function applySnap(snap: Snap): void {
  const p = state.project!;
  const d = JSON.parse(snap.doc);
  const profile = p.settings.profile;
  p.rules = d.r;
  p.constraints = d.c;
  p.visibility = d.v;
  p.atomic = d.a;
  p.nodeLayout = d.l;
  p.nodeNotes = d.n;
  p.nodeBundles = d.b ?? [];
  p.settings = d.s;
  state.excludedCombos = new Set(d.x);
  state.exportScope = d.scope;
  state.selection = JSON.parse(snap.sel);
  if (p.settings.profile !== profile) void engine.setProfile(p.settings.profile ?? state.calibration?.profile ?? 'photoshop');
  restoring = true;
  try {
    resultKey = '';
    refresh();
  } finally {
    restoring = false;
  }
  current = { doc: docKey(p), sel: JSON.stringify(state.selection) };
}

export const canUndo = (): boolean => undoStack.length > 0;
export const canRedo = (): boolean => redoStack.length > 0;

export function undo(): void {
  if (!current || !undoStack.length) return toast(tr('store.noUndo'), 'info');
  redoStack.push(current);
  applySnap(undoStack.pop()!);
}

export function redo(): void {
  if (!current || !redoStack.length) return toast(tr('store.noRedo'), 'info');
  undoStack.push(current);
  applySnap(redoStack.pop()!);
}

/* Node editor: canvas-wide actions, notes, presets */

/** Everything off the canvas (undo brings it back). */
export function clearCanvas(): void {
  const p = state.project;
  if (!p) return;
  p.rules = [];
  p.constraints = [];
  p.nodeNotes = [];
  p.nodeBundles = [];
  p.nodeLayout = {};
  state.selection = {};
  state.excludedCombos = new Set();
  if (state.exportScope === 'current') state.exportScope = 'selected';
  refresh();
  toast(tr('store.canvasCleared'), 'ok');
}

export function addNote(kind: 'note' | 'preview'): string | null {
  const p = state.project;
  if (!p) return null;
  const n = { id: uid(kind === 'note' ? 'note' : 'pv'), kind, text: kind === 'note' ? '' : undefined };
  p.nodeNotes = [...(p.nodeNotes ?? []), n];
  refresh();
  return n.id;
}

/* ---- layer bundles ---- */

function syncBundles(p: Project): void {
  for (const b of p.nodeBundles ?? []) {
    if (!b.ruleId) continue;
    const o = p.rules.find((r) => r.id === b.ruleId)?.options.find((x) => x.id === b.optionId);
    if (!o) {
      b.ruleId = undefined;
      b.optionId = undefined;
      continue;
    }
    o.layerIds = [...b.layerIds];
    o.name = b.name;
  }
}

const bundle = (id: string) => state.project?.nodeBundles?.find((b) => b.id === id);

export function addBundle(layerIds: string[]): string | null {
  const p = state.project;
  if (!p) return null;
  const names = layerIds.map((id) => p.layerIndex[id]?.cleanName ?? '');
  const name = layerIds.length ? (names.length > 2 ? tr('store.bundleNameMany', { name: names[0], n: names.length }) : names.join(' + ')) : tr('store.bundleNumber', { n: (p.nodeBundles?.length ?? 0) + 1 });
  const b = { id: uid('bun'), name, layerIds: [...layerIds] };
  p.nodeBundles = [...(p.nodeBundles ?? []), b];
  refresh();
  return b.id;
}

export function bundleAddLayers(id: string, layerIds: string[]): void {
  const b = bundle(id);
  if (!b) return;
  const fresh = layerIds.filter((l) => !b.layerIds.includes(l));
  if (!fresh.length) return toast(tr('store.layersAlreadyBundled'), 'info');
  b.layerIds.push(...fresh);
  refresh();
  toast(tr('store.bundleLayerCount', { name: b.name, n: b.layerIds.length }), 'ok');
}

export function bundleRemoveLayer(id: string, layerId: string): void {
  const b = bundle(id);
  if (!b) return;
  b.layerIds = b.layerIds.filter((l) => l !== layerId);
  refresh();
}

export function renameBundle(id: string, name: string): void {
  const b = bundle(id);
  if (!b || !name.trim()) return;
  b.name = name.trim();
  refresh({ keepFocus: true });
}

/** Wire a bundle into a group: it becomes one option there (moves if it was elsewhere). */
export function linkBundle(id: string, ruleId: string): void {
  const p = state.project;
  const b = bundle(id);
  const r = rule(ruleId);
  if (!p || !b || !r) return;
  if (b.ruleId === ruleId) return;
  if (b.ruleId) {
    const old = rule(b.ruleId);
    if (old) {
      old.options = old.options.filter((o) => o.id !== b.optionId);
      dropTargets(p, (t) => targetRefs(t, undefined, new Set([b.optionId!])));
    }
  }
  const o = { id: uid('opt'), name: b.name, layerIds: [...b.layerIds], source: '' };
  r.options.push(o);
  b.ruleId = r.id;
  b.optionId = o.id;
  if (!(state.selection[r.id] ?? []).length && r.kind === 'exclusive') autoSelect(r);
  refresh();
  toast(tr('store.bundleLinked', { bundle: b.name, group: r.name, n: b.layerIds.length }), 'ok');
}

export function unlinkBundle(id: string): void {
  const b = bundle(id);
  if (!b?.ruleId) return;
  const { ruleId, optionId } = b;
  b.ruleId = undefined;
  b.optionId = undefined;
  deleteOption(ruleId, optionId!);
}

export function deleteBundle(id: string): void {
  const p = state.project;
  const b = bundle(id);
  if (!p || !b) return;
  p.nodeBundles = (p.nodeBundles ?? []).filter((x) => x.id !== id);
  if (b.ruleId) deleteOption(b.ruleId, b.optionId!);
  else refresh();
}

export function setNoteText(id: string, text: string): void {
  const n = state.project?.nodeNotes?.find((x) => x.id === id);
  if (!n || n.text === text) return;
  n.text = text;
  commitHistory();
  save();
  notify(true);
}

export function deleteNote(id: string): void {
  const p = state.project;
  if (!p) return;
  p.nodeNotes = (p.nodeNotes ?? []).filter((x) => x.id !== id);
  refresh();
}

/** The combination that matches what is picked right now (export current only). */
export function currentCombo(): Combo | null {
  const p = state.project;
  const res = state.result;
  if (!p || !res) return null;
  const live = p.rules.filter((r) => r.enabled && r.kind !== 'fixed');
  const same = (a: string[] = [], b: string[] = []) => a.length === b.length && a.every((x) => b.includes(x));
  return res.combos.find((c) => live.every((r) => same(c.selection[r.id], state.selection[r.id]))) ?? null;
}

export function appendConstraintTarget(id: string, t: Target): void {
  const c = state.project?.constraints.find((x) => x.id === id);
  if (!c) return;
  if ([c.a, c.b, ...(c.more ?? [])].some((x) => sameTarget(x, t))) return toast(tr('store.targetAlreadyAdded'), 'info');
  const unset = (x: Target) => !(x.kind === 'rule' ? x.ruleId : x.kind === 'option' ? x.optionId : x.layerId);
  if (unset(c.a)) c.a = t;
  else if (unset(c.b)) c.b = t;
  else if (c.kind !== 'mutex') return toast(tr('store.requireOnlyTwo'), 'info');
  else c.more = [...(c.more ?? []), t];
  refresh();
}

/** An empty "at most one of these" node; options are dragged onto it. */
export function addEmptyMutex(kind: Constraint['kind'] = 'mutex'): string | null {
  const p = state.project;
  if (!p) return null;
  const c: Constraint = { id: uid('con'), kind, a: { kind: 'option' }, b: { kind: 'option' }, more: [], enabled: true, preset: kind === 'mutex' ? 'multiMutex' : 'requires' };
  p.constraints.push(c);
  refresh();
  return c.id;
}

/** New option group from layers / folders; a folder is ONE option. */
export function createRuleWith(layerIds: string[], name?: string): string | null {
  const p = state.project;
  if (!p) return null;
  const r = ruleFromLayers(p, layerIds, 'exclusive', name);
  if (!name && layerIds.length === 1) {
    const l = p.layerIndex[layerIds[0]];
  r.name = (l.parentId ? p.layerIndex[l.parentId]?.cleanName : '') || tr('store.groupNumber', { n: p.rules.length + 1 });
  }
  p.rules.push(r);
  autoSelect(r);
  refresh();
  return r.id;
}

/** Add a layer / folder to a group as one option. */
export function addLayerOption(ruleId: string, layerId: string): void {
  const p = state.project;
  const r = rule(ruleId);
  if (!p || !r) return;
  if (r.options.some((o) => o.layerIds.length === 1 && o.layerIds[0] === layerId)) return toast(tr('store.layerAlreadyOption'), 'info');
  const l = p.layerIndex[layerId];
  r.options.push({ id: uid('opt'), name: l.cleanName, layerIds: [layerId], source: '' });
  if (!(state.selection[r.id] ?? []).length && r.kind === 'exclusive') autoSelect(r);
  refresh();
  toast(tr('store.layerAddedOption', { layer: l.cleanName, group: r.name }), 'ok');
}

/** A folder's sub-folders (or layers) as the options of a new group. */
export function createRuleFromFolder(folderId: string): void {
  addRuleFromGroup(folderId, 'exclusive');
}

/* "these options are really one variant" */

export interface RuleWarning {
  text: string;
  /** label + action of the suggested fix */
  fixes: { label: string; run: () => void }[];
}

/**
 * Options that are only parts of ONE variant (the layers inside a single face folder made
 * 10 "variants"): offer to use the variant folders instead, or to merge.
 */
export function ruleWarning(r: Rule): RuleWarning | null {
  const p = state.project;
  if (!p || r.options.length < 2 || !r.options.every((o) => o.layerIds.length === 1)) return null;
  const layers = r.options.map((o) => p.layerIndex[o.layerIds[0]]);
  const parent = layers[0]?.parentId;
  if (!parent || !layers.every((l) => l && l.parentId === parent)) return null;
  const folder = p.layerIndex[parent];
  const partsOfOne = isAtomic(parent) || layers.every((l) => l.kind === 'layer' && (isGenericName(l.cleanName) || l.clipping));
  if (!partsOfOne) return null;
  const fixes: RuleWarning['fixes'] = [];
  const grand = folder.parentId ? p.layerIndex[folder.parentId] : null;
  const variants = grand ? grand.children.filter((c) => c.kind === 'group') : [];
  if (grand && variants.length >= 2) {
    fixes.push({
      label: `改为「${grand.cleanName}」的 ${variants.length} 个差分（${[...variants].reverse().map((v) => v.cleanName).slice(0, 4).join(' / ')}${variants.length > 4 ? '…' : ''}）`,
      run: () => replaceRuleOptions(r.id, [...variants].reverse().map((v) => v.id), grand.cleanName),
    });
  }
  fixes.push({ label: `合并成一个选项「${folder.cleanName}」`, run: () => replaceRuleOptions(r.id, [folder.id], r.name) });
  return {
    text: `「${r.name}」的 ${r.options.length} 个选项都是「${folder.cleanName}」里的部件（线稿 / 底色 / 图层 NN …），通常它们合起来才是一个差分；现在每个都被当成一个差分，组合数会被放大。`,
    fixes,
  };
}

function replaceRuleOptions(ruleId: string, layerIds: string[], name: string): void {
  const p = state.project;
  const r = rule(ruleId);
  if (!p || !r) return;
  const gone = new Set(r.options.map((o) => o.id));
  dropTargets(p, (t) => targetRefs(t, undefined, gone));
  r.options = layerIds.map((id) => ({ id: uid('opt'), name: p.layerIndex[id].cleanName, layerIds: [id], source: '' }));
  r.name = name;
  if (r.options.length === 1 && r.kind === 'exclusive') r.kind = 'optional';
  delete state.selection[r.id];
  autoSelect(r);
  refresh();
  toast(tr('store.optionCount', { name: r.name, n: r.options.length }), 'ok');
}

/** How many pictures one group multiplies by, and why (shown next to the count). */
export function ruleFactor(r: Rule): { n: number; why: string } {
  const k = r.options.length;
  if (!k) return { n: 1, why: tr('store.factorEmpty') };
  // the same count the enumeration uses
  const n = choiceCount({ ...r, enabled: true });
  switch (r.kind) {
    case 'exclusive':
      return { n, why: tr('store.factorExclusive', { count: k }) };
    case 'optional':
      return { n, why: tr('store.factorOptional', { count: k }) };
    case 'multi':
      return { n, why: tr(k > MULTI_LIMIT ? 'store.factorMultiLimited' : 'store.factorMulti', { count: k, limit: MULTI_LIMIT, factor: n }) };
    default:
      return { n: 1, why: tr('store.factorFixed') };
  }
}

export function addOption(ruleId: string): void {
  const r = rule(ruleId);
  if (!r) return;
  const opt = { id: uid('opt'), name: `选项 ${r.options.length + 1}`, layerIds: [] as string[], source: '' };
  r.options.push(opt);
  state.editingOption = { ruleId, optionId: opt.id };
  refresh();
}

export function deleteOption(ruleId: string, optionId: string): void {
  const p = state.project;
  const r = rule(ruleId);
  if (!p || !r) return;
  r.options = r.options.filter((o) => o.id !== optionId);
  const gone = new Set([optionId]);
  dropTargets(p, (t) => targetRefs(t, undefined, gone));
  refresh();
}

export function renameOption(ruleId: string, optionId: string, name: string): void {
  const opt = rule(ruleId)?.options.find((o) => o.id === optionId);
  if (!opt) return;
  opt.name = name.trim() || opt.name;
  refresh({ keepFocus: true });
}

export function toggleLayerInOption(ruleId: string, optionId: string, layerId: string): void {
  const opt = rule(ruleId)?.options.find((o) => o.id === optionId);
  if (!opt) return;
  opt.layerIds = opt.layerIds.includes(layerId) ? opt.layerIds.filter((id) => id !== layerId) : [...opt.layerIds, layerId];
  refresh({ keepFocus: true });
}

export function rebuildFromTags(): void {
  const p = state.project;
  if (!p) return;
  p.rules = suggestRules(p);
  p.constraints = [];
  state.selection = defaultSelection(p);
  refresh();
}

/* Constraints */

export function addConstraint(kind: ConstraintKind, targetKind: Target['kind'], preset: Constraint['preset']): void {
  const p = state.project;
  if (!p) return;
  p.constraints.push({
    id: uid('con'),
    kind,
    a: { kind: targetKind },
    b: { kind: targetKind },
    more: preset === 'multiMutex' ? [{ kind: targetKind }] : undefined,
    enabled: true,
    preset,
  });
  refresh();
}

/** Replace target #i of a constraint (0 = a, 1 = b, 2.. = more). */
export function setConstraintTarget(id: string, i: number, t: Target): void {
  const c = state.project?.constraints.find((x) => x.id === id);
  if (!c) return;
  if (i === 0) c.a = t;
  else if (i === 1) c.b = t;
  else {
    c.more = [...(c.more ?? [])];
    c.more[i - 2] = t;
  }
  refresh();
}

/** Add one more item to an N-way mutex (same granularity as the last one). */
export function addConstraintTarget(id: string): void {
  const c = state.project?.constraints.find((x) => x.id === id);
  if (!c) return;
  const last = c.more?.length ? c.more[c.more.length - 1] : c.b;
  c.more = [...(c.more ?? []), { kind: last.kind }];
  refresh();
}

export function removeConstraintTarget(id: string, i: number): void {
  const c = state.project?.constraints.find((x) => x.id === id);
  if (!c) return;
  const all = [c.a, c.b, ...(c.more ?? [])];
  if (all.length <= 2) return;
  all.splice(i, 1);
  c.a = all[0];
  c.b = all[1];
  c.more = all.slice(2);
  refresh();
}

/** Ticked layers -> one "at most one of these" rule (e.g. tail A / B / C). */
export function addMutexFromChecked(): void {
  const p = state.project;
  if (!p || state.checked.size < 2) return;
  const ids = p.layers.filter((l) => state.checked.has(l.id)).map((l) => l.id).reverse();
  const ts: Target[] = ids.map((layerId) => ({ kind: 'layer', layerId }));
  p.constraints.push({ id: uid('con'), kind: 'mutex', a: ts[0], b: ts[1], more: ts.slice(2), enabled: true, preset: 'multiMutex' });
  state.checked.clear();
  refresh();
  toast(tr('store.mutexAdded', { count: ids.length }), 'ok');
}

export function updateConstraint(id: string, patch: Partial<Constraint>): void {
  const c = state.project?.constraints.find((x) => x.id === id);
  if (!c) return;
  Object.assign(c, patch);
  refresh();
}

export function deleteConstraint(id: string): void {
  const p = state.project;
  if (!p) return;
  p.constraints = p.constraints.filter((c) => c.id !== id);
  refresh();
}

/* Layer panel helpers */

export function toggleChecked(id: string): void {
  if (state.checked.has(id)) state.checked.delete(id);
  else state.checked.add(id);
  notifyPatch();
}

/** part groups the user opened to look inside (closed by default) */
const partsOpen = new Set<string>();
export const isPartExpanded = (id: string) => partsOpen.has(id);
export function togglePartExpanded(id: string): void {
  if (partsOpen.has(id)) partsOpen.delete(id);
  else partsOpen.add(id);
  notify();
}

export function toggleCollapsed(id: string): void {
  if (state.collapsed.has(id)) state.collapsed.delete(id);
  else state.collapsed.add(id);
  notify();
}

/** Option groups that reference this node, shown as "group: option". */
export function optionsOfLayer(id: string): string[] {
  const idx = state.idx;
  if (!idx) return [];
  return (idx.layerOptions.get(id) ?? []).map((oid) => {
    const o = idx.options.get(oid)!;
    return `${idx.rules.get(o.ruleId)?.name ?? ''}：${o.name}`;
  });
}

export function nodeState(layer: LayerNode): 'drawn' | 'parent-hidden' | 'hidden' {
  const vis = state.vis;
  if (!vis || !vis.on.has(layer.id)) return 'hidden';
  let p = layer.parentId;
  while (p) {
    if (!vis.on.has(p)) return 'parent-hidden';
    p = state.project!.layerIndex[p]?.parentId ?? null;
  }
  return 'drawn';
}

/* Which combinations to export */

/** Valid combinations the user has ticked for export (default: all). */
export function selectedCombos(): Combo[] {
  if (state.exportScope === 'current') {
    const c = currentCombo();
    return c ? [c] : [];
  }
  if (state.exportScope === 'all') return allPossibleResult()?.combos ?? [];
  if (state.exportScope === 'valid') return state.result?.combos ?? [];
  return (state.result?.combos ?? []).filter((c) => !state.excludedCombos.has(c.signature));
}

export function setExportScope(scope: State['exportScope']): void {
  state.exportScope = scope;
  commitHistory();
  notify();
}

/** Several layers / folders into a group at once: each one is one option. */
export function addLayerOptions(ruleId: string, layerIds: string[]): void {
  const p = state.project;
  const r = rule(ruleId);
  if (!p || !r) return;
  const fresh = layerIds.filter((id) => !r.options.some((o) => o.layerIds.length === 1 && o.layerIds[0] === id));
  if (!fresh.length) return toast(tr('store.layersAlreadyOptions'), 'info');
  for (const id of fresh) r.options.push({ id: uid('opt'), name: p.layerIndex[id].cleanName, layerIds: [id], source: '' });
  if (!(state.selection[r.id] ?? []).length && r.kind === 'exclusive') autoSelect(r);
  refresh();
  toast(tr('store.layersAddedOptions', { n: fresh.length, group: r.name }), 'ok');
}

export function appendConstraintTargets(id: string, ts: Target[]): void {
  for (const t of ts) appendConstraintTarget(id, t);
}

export function toggleComboExport(signature: string): void {
  if (state.excludedCombos.has(signature)) state.excludedCombos.delete(signature);
  else state.excludedCombos.add(signature);
  notify();
}

export function selectAllCombos(mode: 'all' | 'none' | 'invert'): void {
  const all = state.result?.combos ?? [];
  if (mode === 'all') state.excludedCombos.clear();
  else if (mode === 'none') state.excludedCombos = new Set(all.map((c) => c.signature));
  else {
    const next = new Set<string>();
    for (const c of all) if (!state.excludedCombos.has(c.signature)) next.add(c.signature);
    state.excludedCombos = next;
  }
  notify();
}

/* Layer panel: search, visibility, part groups */

export function setSearch(q: string): void {
  state.search = q;
  notify();
}

/** The layer panel re-renders its tree itself (keeps the input focused). */
export function setSearchQuiet(q: string): void {
  state.search = q;
}

/** Toggle a layer's own show/hide state (used by the preview and the export). */
/**
 * The eye button. Layers that are options of a group are shown by choosing
 * them, so their eye switches the option (the plain show/hide flag would be
 * ignored and the click would seem to do nothing).
 */
export function toggleLayerVisible(id: string): void {
  const p = state.project;
  const l = p?.layerIndex[id];
  const idx = state.idx;
  if (!p || !l || !idx) return;
  const optionOf = (nodeId: string) => {
    const oid = idx.layerOptions.get(nodeId)?.[0];
    const o = oid ? idx.options.get(oid) : undefined;
    const r = o ? idx.rules.get(o.ruleId) : undefined;
    return o && r && oid ? { oid, rule: r, name: o.name, on: (state.selection[r.id] ?? []).includes(oid) } : null;
  };

  // 1. the layer is itself an option: choose / un-choose it
  const own = optionOf(id);
  if (own) {
    if (own.rule.kind === 'fixed') return toast(tr('store.fixedLayer', { layer: l.cleanName, group: own.rule.name }), 'info');
    if (own.on && own.rule.kind === 'exclusive') {
      return toast(tr('store.exclusiveLayer', { group: own.rule.name, option: own.name }), 'info');
    }
    state.selection = toggleOption(p, state.selection, own.rule.id, own.oid);
    refresh({ keepFocus: true });
    if (!own.on && own.rule.kind === 'exclusive') toast(tr('store.optionSwitched', { group: own.rule.name, option: own.name }), 'ok');
    return;
  }
  if (hasExportTags(l)) return toast(tr('store.tagControlsLayer', { layer: l.cleanName }), 'info');

  // 2. a plain layer. The eye is about the picture: a layer on screen gets
  //    hidden; a layer that is NOT on screen is made to show, whatever is in
  //    the way (its own flag, an option group that isn't chosen, a hidden
  //    folder). Flipping only its own flag hid layers that merely sat in an
  //    unchosen group (e.g. the layers of variant 3 while variant 1 is chosen).
  const setOwn = (nodeId: string, on: boolean) => {
    const n = p.layerIndex[nodeId];
    p.visibility = { ...(p.visibility ?? {}) };
    if (on === n.authoredVisible) delete p.visibility[nodeId];
    else p.visibility[nodeId] = on;
  };
  const ownOn = (nodeId: string) => p.visibility?.[nodeId] ?? p.layerIndex[nodeId].authoredVisible;
  if (isDrawn(p, state.vis!, id)) {
    setOwn(id, false);
    refresh({ keepFocus: true, quick: true });
    return;
  }
  const notes: string[] = [];
  if (!ownOn(id)) setOwn(id, true);
  let selectionChanged = false;
  // walking up: folders between the layer and its option group are opened;
  // once an option is passed, choosing it already forces the folders above on
  let forcedAbove = false;
  for (let a = l.parentId; a; a = p.layerIndex[a]?.parentId ?? null) {
    const opt = optionOf(a);
    if (opt) {
      if (!opt.on && opt.rule.kind !== 'fixed') {
        state.selection = toggleOption(p, state.selection, opt.rule.id, opt.oid);
        selectionChanged = true;
        notes.push(tr('store.selectedOption', { group: opt.rule.name, option: opt.name }));
      }
      forcedAbove = true;
      continue;
    }
    if (!forcedAbove && !ownOn(a)) {
      setOwn(a, true);
      notes.push(tr('store.openedParent', { group: p.layerIndex[a].cleanName }));
    }
  }
  refresh(selectionChanged ? { keepFocus: true } : { keepFocus: true, quick: true });
  if (notes.length) toast(tr('store.layerShown', { layer: l.cleanName, notes: notes.join(', ') }), 'ok');
  else if (!isDrawn(p, state.vis!, id)) toast(tr('store.layerControlled', { layer: l.cleanName }), 'info');
}

export function resetVisibility(): void {
  if (!state.project) return;
  state.project.visibility = {};
  refresh({ keepFocus: true });
  toast(tr('store.visibilityRestored'), 'ok');
}

export function isAtomic(id: string): boolean {
  return !!state.project?.atomic?.includes(id);
}

/** Inside a part group (its children can't be picked individually)? */
export function insideAtomic(id: string): boolean {
  const p = state.project;
  if (!p) return false;
  for (let cur = p.layerIndex[id]?.parentId; cur; cur = p.layerIndex[cur]?.parentId ?? null) if (isAtomic(cur)) return true;
  return false;
}

export function toggleAtomic(id: string): void {
  const p = state.project;
  if (!p) return;
  const set = new Set(p.atomic ?? []);
  if (set.has(id)) set.delete(id);
  else {
    set.add(id);
    // ticks inside the group make no sense any more
    for (const c of [...state.checked]) if (insideAtomic(c) || p.layerIndex[c]?.parentId === id) state.checked.delete(c);
  }
  p.atomic = [...set];
  save();
  notify();
}

/* Structure suggestions */

let suggestKey = '';
let suggestCache: Suggestion[] = [];

/** Option groups proposed from the layer structure (not yet created). */
export function suggestions(): Suggestion[] {
  const p = state.project;
  if (!p) return [];
  const key = JSON.stringify([p.id, p.rules.map((r) => r.options.map((o) => o.layerIds)), p.atomic ?? []]);
  if (key !== suggestKey) {
    suggestKey = key;
    suggestCache = suggestGroups(p);
  }
  return suggestCache;
}

export function suggestionPicked(sg: Suggestion): { on: boolean; kind: RuleKind } {
  const u = state.suggestPicks[sg.key] ?? {};
  return { on: u.on ?? sg.recommended, kind: u.kind ?? sg.kind };
}

export function setSuggestPick(key: string, patch: { on?: boolean; kind?: RuleKind }): void {
  state.suggestPicks = { ...state.suggestPicks, [key]: { ...state.suggestPicks[key], ...patch } };
  notify();
}

/** Pictures the ticked suggestions would add up to, with the existing groups. */
export function suggestionCount(): number {
  const picked = suggestions()
    .filter((sg) => suggestionPicked(sg).on)
    .map((sg) => ({ ...sg, kind: suggestionPicked(sg).kind }));
  return suggestionProduct(picked, Math.max(1, state.result?.combos.length ?? 1));
}

export function applySuggestions(): void {
  const p = state.project;
  if (!p) return;
  const picked = suggestions().filter((sg) => suggestionPicked(sg).on);
  if (!picked.length) return toast(tr('store.pickGroupsFirst'), 'info');
  for (const sg of picked) {
    const r = ruleFromLayers(p, sg.layerIds, suggestionPicked(sg).kind, sg.name);
    r.options.forEach((o, i) => (o.name = sg.optionNames[i] || o.name));
    r.source = 'suggested';
    p.rules.push(r);
    autoSelect(r);
  }
  state.suggestPicks = {};
  refresh();
  toast(tr('store.groupsFromSuggestions', { groups: picked.length, combos: state.result?.combos.length ?? 0 }), 'ok');
}

export function dismissSuggestions(off = true): void {
  state.suggestOff = off;
  save();
  notify();
}

/* Compositing rules */

export const PROFILE_LABEL: Record<ProfileId, string> = {
  photoshop: 'Photoshop',
  procreate: 'Procreate',
  painter: 'profile.painter',
  'gpu-trunc': 'profile.gpuTrunc',
  'gpu-u8': 'profile.gpuU8',
};

export function profileLabel(profile: ProfileId): string {
  const key = PROFILE_LABEL[profile];
  return key.startsWith('profile.') ? tr(key) : key;
}

export function activeProfile(): ProfileId {
  return state.project?.settings.profile ?? state.calibration?.profile ?? 'photoshop';
}

export async function chooseProfile(choice: ProfileId | 'auto'): Promise<void> {
  const p = state.project;
  if (!p) return;
  p.settings.profile = choice === 'auto' ? undefined : choice;
  await engine.setProfile(activeProfile());
  state.comboThumbs = new Map();
  state.compare = null;
  invalidatePreview();
  refresh({ keepFocus: true });
  toast(tr('store.profileChosen', { profile: profileLabel(activeProfile()) }), 'ok');
}

/* Fidelity check */

export async function runCompare(): Promise<void> {
  setBusy(tr('store.comparing'), 0.5);
  try {
    state.compare = await engine.compare();
  } catch (err) {
    toast(tr('store.compareFailed', { msg: (err as Error).message }), 'bad');
  } finally {
    setBusy(null);
  }
}
