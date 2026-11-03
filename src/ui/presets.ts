import { defaultSelection, suggestRules } from '../core/rules';
import type { Target } from '../core/model';
import { t } from '../i18n';
import {
  applySuggestions,
  clearCanvas,
  connectConstraint,
  refresh,
  state,
  suggestionPicked,
  suggestions,
  toast,
} from './store';

const FACE = /表情|脸|面部|眼|嘴|face|expression|emote/i;

export interface Preset {
  key: string;
  label: string;
  hint: string;
}

export function presets(): Preset[] {
  return [
    { key: 'smart', label: t('preset.smart'), hint: t('preset.smartHint') },
    { key: 'face', label: t('preset.face'), hint: t('preset.faceHint') },
    { key: 'optional', label: t('preset.optional'), hint: t('preset.optionalHint') },
    { key: 'mutex', label: t('preset.mutex'), hint: t('preset.mutexHint') },
    { key: 'require', label: t('preset.require'), hint: t('preset.requireHint') },
    { key: 'blank', label: t('preset.blank'), hint: t('preset.blankHint') },
  ];
}

export function applyPreset(key: string): void {
  const p = state.project;
  if (!p) return;
  const groups = () => p.rules.filter((r) => r.kind !== 'fixed' && r.options.length >= 2);
  switch (key) {
    case 'smart': {
      p.rules = [];
      p.constraints = [];
      p.nodeLayout = {};
      state.selection = {};
      state.suggestPicks = {};
      const list = suggestions();
      if (list.some((sg) => suggestionPicked(sg).on)) {
        applySuggestions();
      } else {
        p.rules = suggestRules(p);
        state.selection = defaultSelection(p);
        refresh();
      }
      return toast(t('preset.smartDone', { count: p.rules.length }), 'ok');
    }
    case 'face': {
      const face = p.rules.filter((r) => FACE.test(r.name) || r.options.some((o) => FACE.test(o.name)));
      if (!face.length) return toast(t('preset.noFaceGroups'), 'info');
      for (const r of p.rules) r.enabled = face.includes(r);
      refresh();
      return toast(t('preset.faceDone', { groups: face.map((r) => r.name).join(', ') }), 'ok');
    }
    case 'optional': {
      let n = 0;
      for (const r of p.rules)
        if (r.kind === 'exclusive') {
          r.kind = 'optional';
          n++;
        }
      refresh();
      return toast(n ? t('preset.optionalDone', { count: n }) : t('preset.noExclusiveGroups'), n ? 'ok' : 'info');
    }
    case 'mutex':
    case 'require': {
      const [g1, g2] = groups();
      if (!g1 || !g2) return toast(t('preset.twoGroupsRequired'), 'info');
      const a: Target = { kind: 'option', optionId: g1.options[g1.options.length - 1].id };
      const b: Target = { kind: 'option', optionId: g2.options[g2.options.length - 1].id };
      connectConstraint(key === 'mutex' ? 'mutex' : 'require', a, b);
      const an = `${g1.name}：${g1.options[g1.options.length - 1].name}`;
      const bn = `${g2.name}：${g2.options[g2.options.length - 1].name}`;
      return toast(
        key === 'mutex' ? t('preset.mutexDone', { a: an, b: bn }) : t('preset.requireDone', { a: an, b: bn }),
        'ok',
      );
    }
    case 'blank':
      return clearCanvas();
  }
}

/** Add one more item to a rule (another tail in "at most one of these"). */
