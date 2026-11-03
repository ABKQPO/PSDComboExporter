/**
 * Automatic compositing-profile detection.
 *
 * Files saved by Photoshop are composited with Photoshop's maths (fitted
 * exactly). For any other app (Procreate, SAI, ibisPaint, MediBang, ...) the
 * merged image stored in the PSD *is* what that app shows, so we render a
 * sample of 64×64 blocks with each candidate profile and keep the one closest
 * to it. Only a few hundred thousand pixels are rendered per candidate, so this
 * costs well under a second even on very large documents.
 */

import { BLOCK, type EngineDoc } from './doc';
import { renderBlocks, authoredVisibility, PROFILES, type ProfileId } from './composite';
import { pixelDiff } from './compare';

export interface Calibration {
  profile: ProfileId;
  /** why this profile was chosen */
  reason: 'photoshop-file' | 'measured' | 'no-reference';
  /** per candidate: mean difference and share of identical pixels on the sample */
  scores: { profile: ProfileId; mean: number; same: number }[];
  sampledPixels: number;
}

const MAX_BLOCKS = 160;

/** Blocks where something interesting happens (non-normal modes first), plus an even spread. */
function pickBlocks(doc: EngineDoc): number[] {
  const level = doc.levels[0];
  const vis = authoredVisibility(doc);
  const special = new Set<number>();
  const any = new Set<number>();
  const walk = (list: typeof doc.roots, on: boolean) => {
    for (const n of list) {
      const v = on && vis(n.id);
      if (n.kind === 'group') {
        walk(n.children, v);
        continue;
      }
      if (!v) continue;
      const blocks = level.layers.get(n.id)?.blocks;
      if (!blocks) continue;
      const interesting = n.blendMode !== 'normal' || n.opacity < 0.999 || n.fill < 0.999 || n.clipping || n.special;
      for (let i = 0; i < blocks.length; i++) {
        if (!blocks[i]) continue;
        any.add(i);
        if (interesting) special.add(i);
      }
    }
  };
  walk(doc.roots, true);
  const spread = (set: Set<number>, n: number) => {
    const arr = [...set].sort((a, b) => a - b);
    if (arr.length <= n) return arr;
    const out: number[] = [];
    for (let k = 0; k < n; k++) out.push(arr[Math.floor((k * arr.length) / n)]);
    return out;
  };
  const picked = new Set([...spread(special, (MAX_BLOCKS * 3) / 4), ...spread(any, MAX_BLOCKS / 4)]);
  return [...picked];
}

export function calibrate(doc: EngineDoc): Calibration {
  if (/photoshop/i.test(doc.writer) || doc.bitsPerChannel !== 8) {
    return { profile: 'photoshop', reason: 'photoshop-file', scores: [], sampledPixels: 0 };
  }
  const ref = doc.composite;
  if (!ref) return { profile: 'painter', reason: 'no-reference', scores: [], sampledPixels: 0 };

  const blocks = pickBlocks(doc);
  const level = doc.levels[0];
  const vis = authoredVisibility(doc);
  const scores: Calibration['scores'] = [];
  let sampled = 0;
  for (const id of Object.keys(PROFILES) as ProfileId[]) {
    const tiles = renderBlocks(doc, blocks, vis, { profile: id });
    let sum = 0;
    let same = 0;
    let n = 0;
    blocks.forEach((bi, k) => {
      const bx = bi % level.bw;
      const by = (bi - bx) / level.bw;
      const w = Math.min(BLOCK, level.width - bx * BLOCK);
      const h = Math.min(BLOCK, level.height - by * BLOCK);
      const tile = tiles[k];
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const t = (y * BLOCK + x) * 4;
          const r = ((by * BLOCK + y) * level.width + bx * BLOCK + x) * 4;
          // pixelDiff wants both pixels at the same index: copy the reference pixel
          refPx[0] = ref[r];
          refPx[1] = ref[r + 1];
          refPx[2] = ref[r + 2];
          refPx[3] = ref[r + 3];
          const d = pixelDiff(tile.subarray(t, t + 4), refPx, 0);
          sum += d;
          if (d === 0) same++;
          n++;
        }
    });
    sampled = n;
    scores.push({ profile: id, mean: n ? sum / n : 0, same: n ? same / n : 1 });
  }
  // lowest mean difference wins; on a tie prefer the more general profile
  // (Procreate's rules only matter when its "Add" layers are present)
  const order: ProfileId[] = ['photoshop', 'painter', 'procreate', 'gpu-u8', 'gpu-trunc'];
  const best = [...scores].sort((a, b) => a.mean - b.mean > 1e-9 || a.mean - b.mean < -1e-9 ? a.mean - b.mean : order.indexOf(a.profile) - order.indexOf(b.profile))[0];
  return { profile: best.profile, reason: 'measured', scores, sampledPixels: sampled };
}

const refPx = new Uint8ClampedArray(4);
