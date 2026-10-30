/**
 * Where the minimized chat's floating box (its floating lines, the frontier,
 * the tree) goes: on the side of the bar it hangs from. The bar in the right
 * third of the screen: the box's right edge on the bar's; the left third: left
 * edges together; the middle: centred on it. Always inside the viewport less
 * the safe areas and an 8px gutter.
 */
export type AnchorSide = "left" | "center" | "right";
export const ANCHOR_GUTTER_PX = 8;

/** The bar's side of the screen, by its centre: thirds. */
export function anchorSide(barLeft: number, barRight: number, vw: number): AnchorSide {
  const mid = (barLeft + barRight) / 2;
  return mid < vw / 3 ? "left" : mid > (2 * vw) / 3 ? "right" : "center";
}

/** The box's left edge (viewport px) for its width, anchored to the bar and clamped. */
export function placeBox(d: {
  barLeft: number;
  barRight: number;
  boxWidth: number;
  vw: number;
  insetLeft?: number;
  insetRight?: number;
  gutter?: number;
}): { side: AnchorSide; left: number } {
  const g = d.gutter ?? ANCHOR_GUTTER_PX;
  const side = anchorSide(d.barLeft, d.barRight, d.vw);
  const want =
    side === "left"
      ? d.barLeft
      : side === "right"
        ? d.barRight - d.boxWidth
        : (d.barLeft + d.barRight) / 2 - d.boxWidth / 2;
  const min = (d.insetLeft ?? 0) + g;
  const max = d.vw - (d.insetRight ?? 0) - g - d.boxWidth;
  // Too wide to fit at all: pinned to the left gutter.
  return { side, left: Math.round(max < min ? min : Math.min(max, Math.max(min, want))) };
}
