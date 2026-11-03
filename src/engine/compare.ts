/**
 * Per-pixel difference between a render and the merged image stored in a PSD.
 *
 * The merged image may carry transparency. Where it is opaque, colours are
 * compared directly (the render flattened on white if it is not opaque, which
 * is what Photoshop stores for documents without transparency). Where it is
 * transparent, alpha is compared, and colour only matters where both have
 * coverage (accepting a straight or white-matted colour).
 */
export function pixelDiff(img: Uint8ClampedArray | Uint8Array, ref: Uint8ClampedArray | Uint8Array, p: number): number {
  const ra = ref[p + 3];
  const ea = img[p + 3];
  if (ra === 255) {
    const a = ea / 255;
    let d = 0;
    for (let c = 0; c < 3; c++) {
      const v = Math.round(img[p + c] * a + 255 * (1 - a));
      const e = Math.abs(v - ref[p + c]);
      if (e > d) d = e;
    }
    return d;
  }
  let d = Math.abs(ea - ra);
  if (ra === 0 || ea === 0) return d;
  const a = ra / 255;
  for (let c = 0; c < 3; c++) {
    const straight = Math.abs(img[p + c] - ref[p + c]);
    const matted = Math.abs(Math.round(img[p + c] * a + 255 * (1 - a)) - ref[p + c]);
    const e = Math.min(straight, matted);
    if (e > d) d = e;
  }
  return d;
}
