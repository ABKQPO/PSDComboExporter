/** Messages between the UI thread and the engine worker. */

import type { Calibration } from './calibrate';
import type { ProfileId } from './composite';

export type { Calibration, ProfileId };

export type EncodeFormat = 'png' | 'jpeg' | 'webp';

export interface LayerMeta {
  id: string;
  kind: 'layer' | 'group';
  name: string;
  hidden: boolean;
  opacity: number;
  fill: number;
  blendMode: string;
  clipping: boolean;
  bbox: [number, number, number, number] | null;
  hasMask: boolean;
  effects: string[];
  unsupported: string[];
  /** bottom -> top */
  children: LayerMeta[];
}

export interface Thumb {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type EngineRequest =
  | {
      id: number;
      type: 'load';
      buffer: ArrayBuffer;
      keepComposite: boolean;
      wantThumbs: boolean;
      reportProgress: boolean;
      previewEdge: number;
      thumbEdge: number;
      /** detect the writer's compositing rules from the merged image */
      calibrate: boolean;
      /** export-only worker: full resolution only (no preview levels, no thumbnails) */
      exportOnly?: boolean;
    }
  | { id: number; type: 'setProfile'; profile: ProfileId }
  /** `latest`: a newer latest-request stops this one (it then fails with "superseded") */
  | { id: number; type: 'render'; level: 'full' | 'preview' | 'thumb'; visible: string[]; latest?: boolean }
  | { id: number; type: 'export'; visible: string[]; format: EncodeFormat; quality: number; scale: number }
  /** full-size render (+ downscale) returned as raw pixels, for a separate encoder */
  | { id: number; type: 'renderExport'; visible: string[]; scale: number }
  /** encode raw pixels (needs no document: runs on an encoder-only worker) */
  | { id: number; type: 'encode'; data: Uint8ClampedArray; width: number; height: number; opaque: boolean; format: EncodeFormat; quality: number }
  | { id: number; type: 'compare' };

export interface LoadedDoc {
  /** decode time per stage (ms), for diagnostics */
  stats?: Record<string, number>;
  width: number;
  height: number;
  bitsPerChannel: number;
  hasComposite: boolean;
  /** application that wrote the file, when it says so */
  writer: string;
  calibration: Calibration | null;
  roots: LayerMeta[];
  warnings: string[];
  thumbs: Record<string, Thumb>;
  levels: { k: number; width: number; height: number }[];
  ms: number;
}

export interface RenderedImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  opaque: boolean;
}

export interface Encoded {
  bytes: Uint8Array;
  width: number;
  height: number;
  /** where the worker spent its time (ms) */
  timing?: { render: number; filter: number; deflate: number; other: number; reused?: number; tiles?: number };
}

export interface RawImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  opaque: boolean;
  render: number;
  reused: number;
  tiles: number;
}

export interface CompareResult {
  available: boolean;
  /** fraction of pixels identical to the PSD's merged image (outside layer effects) */
  same?: number;
  /** fraction within ±2 levels (outside layer effects) */
  near?: number;
  max?: number;
  /** share of the canvas covered by layer effects (pattern / colour overlay) */
  effectPixels?: number;
  effectSame?: number;
  effectMax?: number;
}
