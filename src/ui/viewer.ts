/**
 * Pan / pinch-zoom / two-finger-rotate viewer for the main preview.
 *
 * One finger or mouse drag pans, two fingers zoom and rotate around their
 * midpoint, the mouse wheel zooms around the cursor, a double tap / double
 * click toggles between "fit" and 2× at that point. The element is created
 * once and kept across re-renders so a gesture is never interrupted by a
 * preview update.
 */

interface View {
  x: number; // canvas centre offset from the viewport centre, CSS px
  y: number;
  s: number; // zoom relative to "fit"
  r: number; // rotation, radians
}

const MIN_S = 0.2;
const MAX_S = 40;

export interface Viewer {
  el: HTMLElement;
  /** re-apply after the canvas size or the viewport size changed */
  apply(): void;
  reset(): void;
  rotate(deg: number): void;
  /** zoom relative to the original document, for the label */
  docZoom(docWidth: number): number;
  onChange: (() => void) | null;
}

export function createViewer(canvas: HTMLCanvasElement): Viewer {
  const el = document.createElement('div');
  el.className = 'viewer';
  el.appendChild(canvas);
  const v: View = { x: 0, y: 0, s: 1, r: 0 };

  const fit = (): number => {
    const w = el.clientWidth - 24;
    const h = el.clientHeight - 24;
    if (!canvas.width || !canvas.height || w <= 0 || h <= 0) return 1;
    // a quarter turn swaps the box the picture has to fit in
    const quarter = Math.abs(Math.round(v.r / (Math.PI / 2))) % 2 === 1;
    const cw = quarter ? canvas.height : canvas.width;
    const ch = quarter ? canvas.width : canvas.height;
    return Math.min(w / cw, h / ch);
  };

  let lastFit = 1;
  const apply = () => {
    lastFit = fit();
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;
    canvas.style.transform = `translate(-50%, -50%) translate(${v.x}px, ${v.y}px) rotate(${v.r}rad) scale(${lastFit * v.s})`;
    viewer.onChange?.();
  };

  /** viewport point (CSS px, relative to the viewport centre) */
  const local = (e: { clientX: number; clientY: number }) => {
    const b = el.getBoundingClientRect();
    return { x: e.clientX - b.left - b.width / 2, y: e.clientY - b.top - b.height / 2 };
  };

  /** zoom by k and rotate by da so that point m0 ends up under m1 */
  const transform = (m0: { x: number; y: number }, m1: { x: number; y: number }, k: number, da: number) => {
    const ns = Math.min(MAX_S, Math.max(MIN_S, v.s * k));
    k = ns / v.s;
    const dx = m0.x - v.x;
    const dy = m0.y - v.y;
    const c = Math.cos(da);
    const s = Math.sin(da);
    v.x = m1.x - k * (c * dx - s * dy);
    v.y = m1.y - k * (s * dx + c * dy);
    v.s = ns;
    v.r += da;
  };

  const pts = new Map<number, { x: number; y: number }>();
  let pinch: { m: { x: number; y: number }; d: number; a: number } | null = null;
  let lastTap = 0;
  let moved = false;

  const pinchState = () => {
    const [a, b] = [...pts.values()];
    return { m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, d: Math.hypot(b.x - a.x, b.y - a.y) || 1, a: Math.atan2(b.y - a.y, b.x - a.x) };
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic / already released pointer */
    }
    pts.set(e.pointerId, local(e));
    moved = false;
    if (pts.size === 2) pinch = pinchState();
    el.classList.add('grabbing');
  });
  el.addEventListener('pointermove', (e) => {
    const prev = pts.get(e.pointerId);
    if (!prev) return;
    const cur = local(e);
    if (Math.hypot(cur.x - prev.x, cur.y - prev.y) > 2) moved = true;
    pts.set(e.pointerId, cur);
    if (pts.size >= 2 && pinch) {
      const now = pinchState();
      let da = now.a - pinch.a;
      if (da > Math.PI) da -= 2 * Math.PI;
      if (da < -Math.PI) da += 2 * Math.PI;
      transform(pinch.m, now.m, now.d / pinch.d, da);
      pinch = now;
    } else if (pts.size === 1) {
      v.x += cur.x - prev.x;
      v.y += cur.y - prev.y;
    }
    apply();
  });
  const up = (e: PointerEvent) => {
    if (!pts.has(e.pointerId)) return;
    const p = pts.get(e.pointerId)!;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 0) {
      el.classList.remove('grabbing');
      snapRotation();
      // double tap / double click: fit <-> 2× at that point
      if (!moved && e.type === 'pointerup') {
        const t = performance.now();
        if (t - lastTap < 320) {
          if (v.s > 1.05 || v.x || v.y || v.r) reset();
          else {
            transform(p, p, 2.5, 0);
            apply();
          }
          lastTap = 0;
        } else lastTap = t;
      }
    }
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const m = local(e);
      if (e.altKey || e.shiftKey) transform(m, m, 1, (e.deltaY > 0 ? 1 : -1) * (Math.PI / 36));
      else transform(m, m, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), 0);
      apply();
    },
    { passive: false },
  );
  // keep it fitted when the window / panel changes size
  new ResizeObserver(() => apply()).observe(el);

  /** rotations within 4° of a quarter turn snap to it */
  const snapRotation = () => {
    const q = Math.PI / 2;
    const near = Math.round(v.r / q) * q;
    if (Math.abs(v.r - near) < (4 * Math.PI) / 180 && v.r !== near) {
      v.r = near;
      apply();
    }
  };

  const reset = () => {
    v.x = v.y = 0;
    v.s = 1;
    v.r = 0;
    apply();
  };

  const viewer: Viewer = {
    el,
    apply,
    reset,
    rotate(deg: number) {
      transform({ x: 0, y: 0 }, { x: 0, y: 0 }, 1, (deg * Math.PI) / 180);
      apply();
    },
    docZoom(docWidth: number) {
      return docWidth ? (canvas.width * lastFit * v.s) / docWidth : 1;
    },
    onChange: null,
  };
  return viewer;
}
