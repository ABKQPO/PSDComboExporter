/**
 * Batch export: every valid combination -> full-size render in the engine
 * workers -> encoded image -> one streamed ZIP archive.
 *
 * Renders run in parallel on all workers; entries are written to the archive
 * in combination order so the ZIP is deterministic.
 */

import { comboFileName, uniqueNames, type Combo } from './rules';
import type { Project } from './model';
import type { ExportTarget } from './platform';
import { engine } from '../engine/client';
import type { Encoded } from '../engine/protocol';

export interface ExportProgress {
  done: number;
  total: number;
  current: string;
  bytes: number;
}

export interface ExportOptions {
  project: Project;
  combos: Combo[];
  target: ExportTarget;
  onProgress: (p: ExportProgress) => void;
  shouldCancel: () => boolean;
}

export interface ExportResult {
  cancelled: boolean;
  summary: string;
  entries: number;
  archiveBytes: number;
  location: string;
  elapsedMs: number;
}

export function exportNames(project: Project, combos: Combo[]): string[] {
  return uniqueNames(combos.map((c, i) => comboFileName(project, c, i)));
}

export async function runExport(opts: ExportOptions): Promise<ExportResult> {
  const { project, combos, target, onProgress, shouldCancel } = opts;
  const started = Date.now();
  const names = exportNames(project, combos);
  const st = project.settings;

  await target.begin({ suggestedName: project.name, total: combos.length });

  let bytes = 0;
  let written = 0;
  let cancelled = false;
  // render workers + encoder workers, one picture each, plus one queued
  const parallel = Math.max(1, engine.exportSlots);
  const inflight = new Map<number, Promise<Encoded>>();
  let next = 0;

  const launch = () => {
    while (next < combos.length && inflight.size < parallel + 1) {
      const i = next++;
      inflight.set(i, engine.exportImage(combos[i].on, st.format, st.quality, st.scale));
    }
  };

  try {
    launch();
    for (let i = 0; i < combos.length; i++) {
      if (shouldCancel()) {
        cancelled = true;
        break;
      }
      onProgress({ done: i, total: combos.length, current: names[i], bytes });
      const enc = await inflight.get(i)!;
      inflight.delete(i);
      launch();
      await target.add(names[i], enc.bytes);
      bytes += enc.bytes.byteLength;
      written++;
      onProgress({ done: i + 1, total: combos.length, current: names[i], bytes });
    }
  } catch (err) {
    await target.cancel();
    throw err;
  } finally {
    // let in-flight renders settle so they don't surface as unhandled rejections
    for (const p of inflight.values()) p.catch(() => undefined);
  }

  if (cancelled) {
    await target.cancel();
    return {
      cancelled: true,
      summary: `已取消，没有生成压缩包（已渲染 ${written} 张）`,
      entries: written,
      archiveBytes: 0,
      location: '',
      elapsedMs: Date.now() - started,
    };
  }

  const summary = await target.finish();
  return {
    cancelled: false,
    summary: `${summary.entries} 张图已打包为 ZIP → ${summary.location}`,
    entries: summary.entries,
    archiveBytes: summary.archiveBytes,
    location: summary.location,
    elapsedMs: Date.now() - started,
  };
}
