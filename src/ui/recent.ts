/**
 * Recently opened files.
 *
 * Only metadata is kept: the document bytes are far too large for
 * localStorage. Re-opening asks the user for the same file again; the saved
 * rule configuration is matched by file name and document signature, so the
 * setup comes back with it.
 */

export interface RecentEntry {
  /** storage key the project config is saved under */
  key: string;
  name: string;
  width: number;
  height: number;
  layerCount: number;
  /** number of option groups, for the subtitle */
  ruleCount: number;
  /** small preview of the document, when one could be captured */
  thumb?: string;
  openedAt: number;
}

const KEY = 'psd-export:recent';
export const DEFAULT_LIMIT = 10;
export const MIN_LIMIT = 3;
export const MAX_LIMIT = 50;

export function loadRecent(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter((e): e is RecentEntry => !!e && typeof e.name === 'string' && typeof e.key === 'string');
  } catch {
    return [];
  }
}

function persist(list: RecentEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage full or unavailable */
  }
}

export function recentLimit(pref: number): number {
  const n = Number.isFinite(pref) ? Math.round(pref) : DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, n));
}

export function touchRecent(entry: RecentEntry, limit: number): RecentEntry[] {
  const list = loadRecent().filter((e) => e.key !== entry.key && e.name !== entry.name);
  const next = [{ ...entry, openedAt: Date.now() }, ...list].slice(0, recentLimit(limit));
  persist(next);
  return next;
}

export function removeRecent(key: string): RecentEntry[] {
  const next = loadRecent().filter((e) => e.key !== key);
  persist(next);
  return next;
}

export function clearRecent(): RecentEntry[] {
  persist([]);
  return [];
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.round(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.round(hour / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ts).toLocaleDateString();
}
