/**
 * Layer-name tag syntax, compatible with the original psd-export CLI:
 *
 *   scene [1]            primary tag "1"
 *   [thing@]             secondary tag "thing", exclusion group ""
 *   [jp@text]            secondary tag "jp", exclusion group "text"
 *   [#censor 50]         ignored (filter marker), name "censor", args ["50"]
 *   [1:4]                range expansion: 1,2,3,4
 *   [+logo]              fixed: always visible, never enumerated
 */

export interface Tag {
  ignore: boolean;
  /** `[+name]` marks a layer that is always shown. */
  fixed: boolean;
  name: string;
  /** null for a primary tag; a string (possibly empty) names the exclusion group. */
  group: string | null;
  args: string[];
}

const TAG_RE = /\[(.*?)\]/g;
const RANGE_RE = /^(\d+):(\d+)$/;

export function parseTag(raw: string): Tag {
  const parts = raw.split(/\s+/).filter((s) => s.length > 0);
  if (parts.length === 0) return { ignore: false, fixed: false, name: '', group: '', args: [] };

  let ignore = false;
  let fixed = false;
  let head = parts[0];
  if (head.startsWith('#')) {
    ignore = true;
    head = head.replace(/^#+/, '');
  } else if (head.startsWith('+')) {
    fixed = true;
    head = head.replace(/^\+/, '');
  }

  let name = head;
  let group: string | null = null;
  const at = head.indexOf('@');
  if (at >= 0) {
    name = head.slice(0, at);
    group = head.slice(at + 1);
  }

  return { ignore, fixed, name, group, args: parts.slice(1) };
}

export function parseTags(layerName: string): Tag[] {
  const out: Tag[] = [];
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(layerName)) !== null) {
    const tag = parseTag(m[1]);
    const range = RANGE_RE.exec(tag.name);
    if (range) {
      const from = parseInt(range[1], 10);
      const to = parseInt(range[2], 10);
      for (let i = from; i <= to; i++) out.push({ ...tag, name: String(i) });
    } else {
      out.push(tag);
    }
  }
  return out;
}

export function stripTags(layerName: string): string {
  return layerName.replace(TAG_RE, '').replace(/\s+/g, ' ').trim();
}

export function tagKey(t: Tag): string {
  return `${t.name}\u0000${t.group ?? ''}`;
}
