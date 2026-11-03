import { t } from '../i18n';

const MODES = [
  'normal', 'multiply', 'screen', 'overlay', 'soft light', 'hard light', 'vivid light', 'linear light',
  'pin light', 'hard mix', 'color dodge', 'color burn', 'linear dodge', 'linear burn', 'darken', 'lighten',
  'darker color', 'lighter color', 'difference', 'exclusion', 'subtract', 'divide', 'hue', 'saturation',
  'color', 'luminosity', 'pass through', 'dissolve',
] as const;

export function blendLabel(mode: string): string | undefined {
  if (!MODES.includes(mode as (typeof MODES)[number])) return undefined;
  return t(`blend.${mode.replaceAll(' ', '-')}`);
}
