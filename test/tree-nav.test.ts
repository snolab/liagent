import { describe, expect, it } from "bun:test";
import {
  TREE_DETENT_PX,
  TREE_DRAG_CELLS,
  dragCells,
  dragOffset,
  type NavIndex,
  type TreeNavState,
  height,
  indexTree,
  initialNav,
  isVisible,
  maxDetent,
  treeNav,
} from "../src/tree-nav.ts";

type T = { id: string; kids?: T[] };
const t = (id: string, ...kids: T[]): T => ({ id, kids });
const build = (...roots: T[]) =>
  indexTree(
    roots,
    (n) => n.kids ?? [],
    (n) => n.id,
  );

/**
 *   A ─ A1 ─ A1a ─ A1a1
 *     └ A2
 *   B
 *   C ─ C1
 */
const ix = build(t("A", t("A1", t("A1a", t("A1a1"))), t("A2")), t("B"), t("C", t("C1")));
const run = (s: TreeNavState, ...evs: Parameters<typeof treeNav>[2][]) =>
  evs.reduce((x, e) => treeNav(ix, x, e), s);
const drag = (cells: number) =>
  [{ type: "dragStart" }, { type: "dragMove", cells }, { type: "dragEnd" }] as const;
const at = (focusId: string, expanded: Record<string, number> = {}): TreeNavState => ({
  focusId,
  expanded,
  detent: 0,
});

describe("maxDetent", () => {
  const chain = (n: number): T => (n === 0 ? t(`d${n}`) : t(`d${n}`, chain(n - 1)));
  const deep = build(chain(5), t("leaf"), t("one", t("x")), t("two", t("y", t("z"))));
  it("is min(3, the subtree's height): leaf 0, depth 1, depth 2, depth 5 → 3", () => {
    expect(maxDetent(deep, "leaf")).toBe(0);
    expect(maxDetent(deep, "one")).toBe(1);
    expect(maxDetent(deep, "two")).toBe(2);
    expect(height(deep, "d5")).toBe(5);
    expect(maxDetent(deep, "d5")).toBe(3);
  });
});

describe("treeNav: drags", () => {
  it("expands the focused node one level per cell, previewing until the drag ends", () => {
    let s = initialNav(ix);
    expect(s.focusId).toBe("A");
    s = run(s, { type: "dragStart" }, { type: "dragMove", cells: 2 });
    expect(s.expanded).toEqual({ A: 2 });
    expect(s.base?.expanded).toEqual({}); // not committed yet
    const cancelled = run(s, { type: "dragCancel" });
    expect(cancelled.expanded).toEqual({});
    const done = run(s, { type: "dragEnd" });
    expect(done.expanded).toEqual({ A: 2 });
    expect(done.base).toBeUndefined();
    expect(isVisible(ix, done, "A1a")).toBe(true);
    expect(isVisible(ix, done, "A1a1")).toBe(false);
  });

  it("is not commutative: expand 2 then collapse 1 ≠ collapse 1 then expand 2", () => {
    const start = at("A1", { A: 1 });
    const x = run(start, ...drag(2), ...drag(-1));
    const y = run(start, ...drag(-1), ...drag(2));
    expect(x).toMatchObject({ focusId: "A1", expanded: { A: 1, A1: 1 } });
    expect(y).toMatchObject({ focusId: "A", expanded: { A: 2 } });
    expect(x.expanded).not.toEqual(y.expanded);
  });

  it("clamps at the focused node's own height", () => {
    const s = run(at("C"), ...drag(3));
    expect(s.expanded).toEqual({ C: 1 });
  });

  it("collapsing past the focused node's level moves the focus to its parent", () => {
    const s = run(at("A1a", { A: 2 }), ...drag(-1));
    expect(s.focusId).toBe("A1");
    expect(s.expanded).toEqual({ A: 2 }); // A1 had no depth of its own: A still shows it
    const s2 = run(s, ...drag(-1));
    expect(s2.focusId).toBe("A");
    expect(s2.expanded).toEqual({ A: 1 }); // and A folds one level
    const s3 = run(s2, ...drag(-2));
    expect(s3).toMatchObject({ focusId: "A", expanded: {} });
  });

  it("keeps one branch open (the accordion)", () => {
    const s = run(at("A", { A: 2 }), { type: "tapChip", id: "C" });
    expect(s).toMatchObject({ focusId: "C", expanded: { C: 1 } });
    const leaf = run(s, { type: "tapChip", id: "B" });
    expect(leaf).toMatchObject({ focusId: "B", expanded: {} });
  });
});

describe("treeNav: end-stops", () => {
  it("a leaf can't expand: a hard stop, then the same state", () => {
    const s = at("B");
    const once = treeNav(ix, s, { type: "key", key: "Enter" });
    expect(once.atLimit).toBe("max");
    expect(once.expanded).toEqual({});
    const twice = treeNav(ix, once, { type: "key", key: "Enter" });
    expect(twice).toBe(once); // the same object
  });

  it("repeated expand at max leaves it unchanged, atLimit max", () => {
    const s = run(at("A"), ...drag(3)); // A's height is 3
    expect(s.expanded).toEqual({ A: 3 });
    const a = treeNav(ix, s, { type: "key", key: "Enter" });
    expect(a).toMatchObject({ atLimit: "max", expanded: { A: 3 } });
    expect(treeNav(ix, a, { type: "key", key: "Enter" })).toBe(a);
  });

  it("repeated collapse at the top row leaves it unchanged, atLimit min", () => {
    const s = at("A");
    const a = treeNav(ix, s, { type: "key", key: "Escape" });
    expect(a.atLimit).toBe("min");
    expect(treeNav(ix, a, { type: "key", key: "Escape" })).toBe(a);
  });

  it("a drag that hits the limit stops there, and reverses from it", () => {
    let s = run(at("C"), { type: "dragStart" }, { type: "dragMove", cells: 3 });
    expect(s).toMatchObject({ expanded: { C: 1 }, atLimit: "max", detent: 3 });
    s = run(s, { type: "dragMove", cells: 0 });
    expect(s).toMatchObject({ expanded: {}, detent: 0 });
    expect(s.atLimit).toBeUndefined();
    s = run(s, { type: "dragMove", cells: -2 });
    expect(s).toMatchObject({ expanded: {}, atLimit: "min" });
    s = run(s, { type: "dragEnd" });
    expect(s).toMatchObject({ focusId: "C", expanded: {}, detent: 0 });
  });
});

describe("treeNav: keys and taps", () => {
  it("←/→ move along the row; → at its end expands, ← at its start collapses", () => {
    let s = at("A");
    s = run(s, { type: "key", key: "ArrowRight" });
    expect(s.focusId).toBe("B");
    s = run(s, { type: "key", key: "ArrowRight" }, { type: "key", key: "ArrowRight" });
    expect(s).toMatchObject({ focusId: "C", expanded: { C: 1 } });
    s = run(s, { type: "key", key: "ArrowDown" });
    expect(s.focusId).toBe("C1");
    s = run(s, { type: "key", key: "ArrowUp" }, { type: "key", key: "ArrowLeft" });
    expect(s.focusId).toBe("B");
    s = run(at("A", { A: 1 }), { type: "key", key: "ArrowLeft" });
    expect(s.expanded).toEqual({});
  });

  it("collapseAll folds everything back to the focused branch's chip", () => {
    const s = run(at("A1a", { A: 2 }), { type: "collapseAll" });
    expect(s).toMatchObject({ focusId: "A", expanded: {} });
  });

  it("ignores unknown ids, keys and stray drag ends", () => {
    const s = at("A");
    expect(treeNav(ix, s, { type: "tapChip", id: "nope" })).toBe(s);
    expect(treeNav(ix, s, { type: "key", key: "x" })).toBe(s);
    expect(treeNav(ix, s, { type: "dragEnd" })).toBe(s);
    expect(treeNav(ix, s, { type: "dragCancel" })).toBe(s);
    expect(treeNav(ix, at("C"), { type: "key", key: "ArrowDown" }).focusId).toBe("C");
    const empty: NavIndex = build();
    const e = initialNav(empty);
    expect(treeNav(empty, e, { type: "key", key: "Enter" })).toBe(e);
    expect(run(e, ...drag(1), ...drag(-1)).expanded).toEqual({});
  });
});

describe("tree drag detents", () => {
  it("quantises the drag into cells of TREE_DETENT_PX, with hysteresis both ways", () => {
    expect(TREE_DETENT_PX).toBe(40);
    expect(dragCells(0, 0)).toBe(0);
    expect(dragCells(23, 0)).toBe(0); // 0.575 cells: not past 0.6
    expect(dragCells(25, 0)).toBe(1);
    expect(dragCells(2 * 40, 1)).toBe(2);
    expect(dragCells(-25, 0)).toBe(-1);
    // Resting on a boundary never flickers: from 1, back to 0.45 cells stays 1…
    expect(dragCells(18, 1)).toBe(1);
    // …only under 0.4 does it drop.
    expect(dragCells(15, 1)).toBe(0);
    expect(dragCells(10_000, 0)).toBe(TREE_DRAG_CELLS);
  });

  it("maps cells to depth through the reducer (2 cells right → depth 2)", () => {
    const s = run(at("A"), { type: "dragStart" }, { type: "dragMove", cells: dragCells(80, 0) });
    expect(s.expanded).toEqual({ A: 2 });
  });

  it("snaps the preview to the detents, and only rubber-bands past a limit", () => {
    expect(dragOffset(40)).toBeCloseTo(40, 5); // on a detent
    expect(dragOffset(-80)).toBeCloseTo(-80, 5);
    // Between detents it lags (the magnet), then catches up.
    expect(dragOffset(10)).toBeLessThan(10);
    // Limit at 1 cell: 30px past it moves only 9px.
    expect(dragOffset(70, 1)).toBeCloseTo(40 + 30 * 0.3, 5);
    expect(dragOffset(-60, -1)).toBeCloseTo(-40 - 20 * 0.3, 5);
    // Before the limit: plain detents.
    expect(dragOffset(20, 1)).toBeCloseTo(dragOffset(20), 5);
    // A leaf (limit 0): any expand drag resists at once.
    expect(dragOffset(30, 0)).toBeCloseTo(9, 5);
  });
});
