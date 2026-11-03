import { applyConfig, buildConfig, labelKey, parseConfig } from '../core/config';
import { normalizeSelection } from '../core/rules';
import { engine } from '../engine/client';
import { invalidateResultCache, notify, refresh, save, state, toast } from './store';
import { t } from '../i18n';

export function exportConfigText(): string {
  const p = state.project!;
  const excluded = (state.result?.combos ?? []).filter((c) => state.excludedCombos.has(c.signature)).map((c) => c.labels);
  return JSON.stringify(buildConfig(p, state.selection, excluded), null, 1);
}

export function importConfigText(text: string): void {
  const p = state.project;
  if (!p) return;
  const cfg = parseConfig(text);
  const res = applyConfig(p, cfg);
  state.selection = normalizeSelection(p, res.selection);
  if (p.settings.profile) void engine.setProfile(p.settings.profile);
  invalidateResultCache();
  refresh();
  const keys = new Set(res.excludedLabels.map(labelKey));
  state.excludedCombos = new Set((state.result?.combos ?? []).filter((c) => keys.has(labelKey(c.labels))).map((c) => c.signature));
  save();
  notify();
  const sourceName = cfg.source?.name && cfg.source.name !== p.name ? cfg.source.name : '';
  const source = sourceName ? t('config.source', { source: sourceName }) : '';
  if (res.missing.length) {
    toast(t('config.importMissing', { source, count: res.missing.length, names: res.missing.slice(0, 3).join(', ') }), 'bad');
  } else {
    toast(t('config.imported', { source, groups: p.rules.length, rules: p.constraints.length }), 'ok');
  }
}
