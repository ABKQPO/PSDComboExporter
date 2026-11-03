/** Shared data model for the exporter. */

import type { Tag } from './tags';

export type LayerKind = 'layer' | 'group';

export interface LayerNode {
  id: string;
  name: string;
  /** name with `[...]` tags removed, used for display */
  cleanName: string;
  kind: LayerKind;
  parentId: string | null;
  /** position among siblings, 0 = bottom */
  index: number;
  depth: number;
  /** visibility authored in the PSD file */
  authoredVisible: boolean;
  opacity: number;
  fill: number;
  blendMode: string;
  clipping: boolean;
  hasMask: boolean;
  /** rendered layer effects, e.g. a pattern overlay */
  effects: string[];
  /** features of this layer we cannot reproduce exactly */
  unsupported: string[];
  tags: Tag[];
  /** children, bottom -> top (PSD order) */
  children: LayerNode[];
  /** content bounds in document pixels; null when empty */
  bbox: [number, number, number, number] | null;
}

export type RuleKind =
  /** exactly one option (radio) */
  | 'exclusive'
  /** zero or one option (radio + implicit "none") */
  | 'optional'
  /** any subset (checkboxes) */
  | 'multi'
  /** every option always on (background / logo) */
  | 'fixed';

export interface RuleOption {
  id: string;
  name: string;
  /** ids of the layers that become visible when this option is picked */
  layerIds: string[];
  /** layer name of the first member, for display */
  source: string;
}

export interface Rule {
  id: string;
  name: string;
  kind: RuleKind;
  options: RuleOption[];
  /** include this rule in cartesian enumeration */
  enabled: boolean;
  /** where the rule came from: 'primary tags', '@group', 'manual', ... */
  source: string;
}

export type TargetKind = 'rule' | 'option' | 'layer';

export interface Target {
  kind: TargetKind;
  /** ruleId for kind='rule' */
  ruleId?: string;
  /** optionId for kind='option' */
  optionId?: string;
  /** layerId for kind='layer' */
  layerId?: string;
}

export type ConstraintKind =
  /** both sides may never be active at the same time */
  | 'mutex'
  /** if A is active then B is required */
  | 'require';

export interface Constraint {
  id: string;
  kind: ConstraintKind;
  a: Target;
  b: Target;
  /** mutex only: further targets; at most ONE of a, b, ...more may be active */
  more?: Target[];
  enabled: boolean;
  note?: string;
  /** free-form preset label shown in the UI */
  preset?: 'crossGroupMutex' | 'conditionalExclude' | 'absoluteExclude' | 'requires' | 'multiMutex';
}

export interface ProjectSettings {
  /** how rendered images are delivered on native platforms */
  exportMode: 'zip' | 'folder';
  format: 'png' | 'jpeg' | 'webp';
  quality: number;
  /** 1 = original size (pixel exact) */
  scale: number;
  /** 'flat' => all files at the ZIP root ; 'primary' => one folder per option of the first group */
  layout: 'flat' | 'primary';
  /** naming template tokens: {psd} {primary} {combo} {index} {n} */
  template: string;
  /** compositing rules chosen by the user; undefined = auto-detected */
  profile?: 'photoshop' | 'procreate' | 'painter' | 'gpu-trunc' | 'gpu-u8';
}

export type ExportMode = ProjectSettings['exportMode'];

export interface NodeNote {
  id: string;
  kind: 'note' | 'preview';
  text?: string;
}

/** Several layers that show together; wired into a group it becomes ONE option. */
export interface NodeBundle {
  id: string;
  name: string;
  layerIds: string[];
  ruleId?: string;
  optionId?: string;
}

export interface Project {
  id: string;
  name: string;
  width: number;
  height: number;
  layers: LayerNode[];
  layerIndex: Record<string, LayerNode>;
  rules: Rule[];
  constraints: Constraint[];
  settings: ProjectSettings;
  /** user changes to the saved show/hide state (layer id -> visible) */
  visibility?: Record<string, boolean>;
  /** groups treated as one indivisible part (line art + colour + highlight ...) */
  atomic?: string[];
  /** node editor: positions of nodes (rule / constraint ids, 'combine', 'export') */
  nodeLayout?: Record<string, { x: number; y: number }>;
  /** node editor: sticky notes and extra preview nodes */
  nodeNotes?: NodeNote[];
  /** node editor: layer bundles; a linked bundle is one option of a group */
  nodeBundles?: NodeBundle[];
  createdAt: number;
  updatedAt: number;
  /** original file size in bytes, informational */
  fileSize: number;
}

export interface Selection {
  /** ruleId -> selected option ids */
  [ruleId: string]: string[];
}

export const defaultSettings = (): ProjectSettings => ({
  exportMode: 'zip',
  format: 'png',
  quality: 92,
  scale: 1,
  layout: 'flat',
  template: '{psd}-{combo}',
});

export function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}
