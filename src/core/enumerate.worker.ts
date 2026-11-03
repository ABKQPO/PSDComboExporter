/** Enumerates the combinations off the main thread (see store.enumerateInBackground). */
import { enumerate } from './rules';
import type { Project, Selection } from './model';

self.onmessage = (ev: MessageEvent<{ id: number; project: Project; base: Selection }>) => {
  const { id, project, base } = ev.data;
  try {
    const result = enumerate(project, { base });
    // only what the main thread can't cheaply rebuild: the layer sets of each
    // picture are recomputed there on demand (cloning 5000 of them blocked
    // the UI for ~140 ms)
    const combos = result.combos.map((c) => ({ selection: c.selection, labels: c.labels, primaryLabel: c.primaryLabel, signature: c.signature }));
    (self as unknown as Worker).postMessage({ id, result: { ...result, combos } });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
