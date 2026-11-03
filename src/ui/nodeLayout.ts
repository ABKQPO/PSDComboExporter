import type { Project, Target } from '../core/model';

export type Pos = { x: number; y: number };
export type Size = { w: number; h: number };

export function autoLayout(p: Project, sizes: Map<string, Size>, viewportWidth: number, viewportHeight: number, gap: number): Record<string, Pos> {
  const out: Record<string, Pos> = {};
  const size = (id: string) => sizes.get(id) ?? { w: 220, h: 120 };
  const narrow = viewportWidth > 0 && viewportWidth < 600;
  const colW = Math.max(220, ...p.rules.map((r) => size(r.id).w));
  const place = (k: number) => {
    const cols: { ids: string[]; h: number }[] = Array.from({ length: k }, () => ({ ids: [], h: 0 }));
    const per = p.rules.reduce((a, r) => a + size(r.id).h + gap, 0) / k;
    let c = 0;
    for (const r of p.rules) {
      if (cols[c].h > 0 && cols[c].h + size(r.id).h / 2 > per && c < k - 1) c++;
      cols[c].ids.push(r.id);
      cols[c].h += size(r.id).h + gap;
    }
    return cols;
  };
  let best = place(1);
  if (!narrow && p.rules.length > 2) {
    const vw = Math.max(1, viewportWidth);
    const vh = Math.max(1, viewportHeight);
    const extra = 90 + 260 + 70 + 200 + (p.constraints.length ? 330 : 0);
    let bestScale = 0;
    for (let k = 1; k <= Math.min(4, p.rules.length); k++) {
      const cols = place(k);
      const w = k * colW + (k - 1) * 60 + extra;
      const h = Math.max(...cols.map((c) => c.h));
      const scale = Math.min(1, vw / w, vh / h);
      if (scale > bestScale + 0.02) {
        bestScale = scale;
        best = cols;
      }
    }
  }
  const groupTop: Record<string, number> = {};
  best.forEach((col, ci) => {
    let y = 0;
    for (const id of col.ids) {
      out[id] = { x: ci * (colW + 60), y };
      groupTop[id] = y;
      y += size(id).h + gap;
    }
  });
  const groupsBottom = Math.max(0, ...best.map((c) => c.h - gap));
  const groupsRight = (best.length - 1) * (colW + 60) + colW;
  const x2 = groupsRight + (narrow ? 34 : 90);

  if (narrow) {
    let y = 0;
    for (const id of ['combine', 'export', ...p.constraints.map((c) => c.id)]) {
      out[id] = { x: x2, y };
      y += size(id).h + gap;
    }
    return out;
  }

  const rowY = (target: Target): number | undefined => {
    if (target.kind === 'rule' && target.ruleId) return groupTop[target.ruleId];
    if (target.kind !== 'option') return undefined;
    const rule = p.rules.find((r) => r.options.some((o) => o.id === target.optionId));
    if (!rule) return undefined;
    const index = rule.options.findIndex((o) => o.id === target.optionId) + (rule.kind === 'optional' ? 1 : 0);
    return groupTop[rule.id] + 70 + index * 34;
  };
  const wanted = p.constraints.map((c) => {
    const ys = [c.a, c.b, ...(c.more ?? [])].map(rowY).filter((v): v is number => v !== undefined);
    return { c, y: ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length - size(c.id).h / 2 : 0 };
  });
  wanted.sort((a, b) => a.y - b.y);
  let floor = 0;
  let col2W = 0;
  for (const { c, y: wantedY } of wanted) {
    const y = Math.max(floor, wantedY);
    out[c.id] = { x: x2, y };
    floor = y + size(c.id).h + gap;
    col2W = Math.max(col2W, size(c.id).w);
  }
  const x3 = p.constraints.length ? x2 + col2W + 90 : x2;
  out.combine = { x: x3, y: Math.max(0, groupsBottom / 2 - size('combine').h / 2) };
  out.export = { x: x3 + size('combine').w + 70, y: out.combine.y };
  return out;
}
