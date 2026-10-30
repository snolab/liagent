import { describe, expect, it } from "bun:test";
import { anchorSide, placeBox } from "../src/anchor.ts";

describe("anchorSide", () => {
  it("splits the screen in thirds by the bar's centre", () => {
    expect(anchorSide(0, 120, 390)).toBe("left");
    expect(anchorSide(140, 260, 390)).toBe("center");
    expect(anchorSide(270, 382, 390)).toBe("right");
  });
});

describe("placeBox", () => {
  const vw = 390;
  it("right third: the box's right edge on the bar's", () => {
    const r = placeBox({ barLeft: 262, barRight: 382, boxWidth: 200, vw });
    expect(r).toEqual({ side: "right", left: 182 });
  });
  it("left third: left edges together", () => {
    expect(placeBox({ barLeft: 8, barRight: 128, boxWidth: 200, vw })).toEqual({
      side: "left",
      left: 8,
    });
  });
  it("middle: centred on the bar", () => {
    expect(placeBox({ barLeft: 135, barRight: 255, boxWidth: 200, vw })).toEqual({
      side: "center",
      left: 95,
    });
  });
  it("clamps inside the viewport, the safe areas and the gutter", () => {
    // Wide box, bar at the right edge: kept off the left edge.
    expect(placeBox({ barLeft: 300, barRight: 388, boxWidth: 374, vw }).left).toBe(8);
    // Bar near the left edge, box centred would go off: clamped to the gutter + inset.
    expect(placeBox({ barLeft: 100, barRight: 220, boxWidth: 300, vw, insetLeft: 44 }).left).toBe(
      52,
    );
    // Right inset (landscape notch).
    const r = placeBox({ barLeft: 280, barRight: 386, boxWidth: 200, vw, insetRight: 30 });
    expect(r.left + 200).toBeLessThanOrEqual(vw - 30 - 8);
    // Wider than the screen: pinned left.
    expect(placeBox({ barLeft: 0, barRight: 100, boxWidth: 500, vw }).left).toBe(8);
  });
});
