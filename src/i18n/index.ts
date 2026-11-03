const localeFiles = import.meta.glob('./locales/*/*.json', { eager: true, import: 'default' }) as Record<
  string,
  Dict
>;

const dictionaries = Object.fromEntries(
  Object.entries(localeFiles).reduce((locales, [path, dictionary]) => {
    const locale = path.match(/\/locales\/([^/]+)\//)![1];
    const entry = locales.find(([id]) => id === locale);
    if (entry) Object.assign(entry[1], dictionary);
    else locales.push([locale, { ...dictionary }]);
    return locales;
  }, [] as [string, Dict][]),
) as Record<Locale, Dict>;

export const LOCALES: { id: Locale; label: string }[] = [
  { id: 'zh-CN', label: '简体中文' },
  { id: 'en', label: 'English' },
];

export type Locale = 'zh-CN' | 'en';
type Dict = Record<string, string | string[]>;

const STORAGE_KEY = 'psd-export:locale';

let current: Locale = 'zh-CN';
const listeners = new Set<() => void>();

export function detectSystemLocale(): Locale {
  const tag = navigator.language ?? navigator.languages?.[0] ?? 'en';
  return /^zh\b/i.test(tag) ? 'zh-CN' : 'en';
}

export function systemLocale(): Locale {
  return detectSystemLocale();
}

export function loadLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh-CN' || saved === 'en') return saved;
  } catch {
    /* storage unavailable */
  }
  return detectSystemLocale();
}

export function getLocale(): Locale {
  return current;
}

export function setLocale(next: Locale): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  document.documentElement.lang = next;
  for (const fn of listeners) fn();
}

export function onLocaleChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function initLocale(): void {
  current = loadLocale();
  document.documentElement.lang = current;
}

function lookup(dict: Dict, key: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(dict, key)) return undefined;
  const value = dict[key];
  return Array.isArray(value) ? value.join('') : value;
}

function interpolate(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (all, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : all,
  );
}

export function t(key: string, params?: Record<string, string | number>): string {
  const text = lookup(dictionaries[current], key) ?? lookup(dictionaries.en, key) ?? key;
  return interpolate(text, params);
}

export function tList(key: string): string[] {
  const value = dictionaries[current][key] ?? dictionaries.en[key];
  return Array.isArray(value) ? value : [key];
}

export function isZh(): boolean {
  return current === 'zh-CN';
}
