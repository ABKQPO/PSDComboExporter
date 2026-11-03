/** Build the UI-side project model from the engine's layer tree. */

import type { LoadedDoc, LayerMeta } from '../engine/protocol';
import { defaultSettings, uid, type LayerNode, type Project } from './model';
import { parseTags, stripTags } from './tags';

export function buildProject(fileName: string, fileSize: number, doc: LoadedDoc): Project {
  const layers: LayerNode[] = [];
  const toNode = (m: LayerMeta, parentId: string | null, depth: number, index: number): LayerNode => {
    const node: LayerNode = {
      id: m.id,
      name: m.name,
      cleanName: stripTags(m.name) || m.name || '(未命名)',
      kind: m.kind,
      parentId,
      index,
      depth,
      authoredVisible: !m.hidden,
      opacity: m.opacity,
      fill: m.fill,
      blendMode: m.blendMode,
      clipping: m.clipping,
      hasMask: m.hasMask,
      effects: m.effects,
      unsupported: m.unsupported,
      tags: parseTags(m.name),
      children: [],
      bbox: m.bbox,
    };
    layers.push(node);
    node.children = m.children.map((c, i) => toNode(c, node.id, depth + 1, i));
    return node;
  };
  doc.roots.forEach((r, i) => toNode(r, null, 0, i));
  return {
    id: uid('proj'),
    name: fileName.replace(/\.(psd|psb|ipv)$/i, ''),
    width: doc.width,
    height: doc.height,
    layers,
    layerIndex: Object.fromEntries(layers.map((n) => [n.id, n])),
    rules: [],
    constraints: [],
    settings: defaultSettings(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    fileSize,
  };
}

/** Top-level nodes, top-most first (Photoshop layer panel order). */
export function rootsTopFirst(p: Project): LayerNode[] {
  return p.layers.filter((l) => l.parentId === null).sort((a, b) => b.index - a.index);
}
