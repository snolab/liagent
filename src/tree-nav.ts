/**
 * Navigating a tree by detents: a pure reducer, `treeNav(state, event)`.
 * Generic: any tree (the chat box's tree view uses it).
 *
 * The view: at each level the collapsed siblings sit in a row of chips; one
 * node is expanded at a time along one branch (an accordion), its subtree
 * shown `expanded[id]` levels deep. A focused node takes the gestures.
 *
 * - Dragging right by k cells expands the focused node one level per cell,
 *   up to `maxDetent` (min(3, its subtree's height)); a leaf can't expand.
 * - Dragging left collapses one level per cell: first the focused node's own
 *   depth, deepest level first; past its own level the focus moves to its
 *   parent, whose depth then drops by one; at a top-level chip with nothing
 *   expanded there is nothing left to collapse.
 * - At either limit the reducer stops: no wrap-around, the SAME state object
 *   back (or once, the state with `atLimit` set), so the view can rubber-band.
 * - A drag previews (`preview`) and commits only on `dragEnd`.
 *
 * It is not a counter: the result depends on the path (the focus moves, and
 * each node has its own depth), so "expand 2 then collapse 1" and "collapse 1
 * then expand 2" can differ.
 */

import { detentLevel, snapDetent } from "./detent.ts";

/** The tree as the reducer sees it: ids, parents, children in order. */
export type NavIndex = {
  roots: string[];
  parent: Map<string, string | null>;
  children: Map<string, string[]>;
};

/** Build a NavIndex from any tree. */
export function indexTree<N>(
  roots: readonly N[],
  childrenOf: (n: N) => readonly N[],
  idOf: (n: N, parentId: string | null, i: number) => string,
): NavIndex {
  const ix: NavIndex = { roots: [], parent: new Map(), children: new Map() };
  const go = (n: N, parent: string | null, i: number): string => {
    const id = idOf(n, parent, i);
    ix.parent.set(id, parent);
    ix.children.set(
      id,
      childrenOf(n).map((c, j) => go(c, id, j)),
    );
    return id;
  };
  ix.roots = roots.map((r, i) => go(r, null, i));
  return ix;
}

/** Levels below a node: 0 for a leaf. */
export function height(ix: NavIndex, id: string): number {
  const kids = ix.children.get(id) ?? [];
  return kids.length ? 1 + Math.max(...kids.map((k) => height(ix, k))) : 0;
}

/** How deep a node can open: min(3, its subtree's height); 0 for a leaf. */
export const MAX_DETENT = 3;
export function maxDetent(ix: NavIndex, id: string): number {
  return Math.min(MAX_DETENT, height(ix, id));
}

export type TreeNavState = {
  focusId: string | null;
  /** Depth per node, along one branch (the accordion). */
  expanded: Readonly<Record<string, number>>;
  /** The drag's cells so far (signed), 0 when not dragging. */
  detent: number;
  /** Hit a limit on the last step: the view resists. */
  atLimit?: "max" | "min";
  /** While dragging: the committed state the drag started from. */
  base?: TreeNavState;
};

export type TreeNavEvent =
  | { type: "dragStart" }
  | { type: "dragMove"; cells: number }
  | { type: "dragEnd" }
  | { type: "dragCancel" }
  | { type: "tapChip"; id: string }
  | { type: "key"; key: string }
  | { type: "collapseAll" };

export const initialNav = (ix: NavIndex): TreeNavState => ({
  focusId: ix.roots[0] ?? null,
  expanded: {},
  detent: 0,
});

/** The ancestors of a node, nearest first. */
function ancestors(ix: NavIndex, id: string): string[] {
  const out: string[] = [];
  for (let p = ix.parent.get(id) ?? null; p !== null; p = ix.parent.get(p) ?? null) out.push(p);
  return out;
}
const topOf = (ix: NavIndex, id: string) => ancestors(ix, id).at(-1) ?? id;

/** Is a node on screen: a top-level chip, or within an expanded ancestor's depth. */
export function isVisible(ix: NavIndex, s: Pick<TreeNavState, "expanded">, id: string): boolean {
  const up = ancestors(ix, id);
  if (!up.length) return true;
  // The parent's row shows if the parent is visible and some ancestor (or it)
  // opens far enough to reach this node.
  if (!isVisible(ix, s, up[0]!)) return false;
  return up.some((a, i) => (s.expanded[a] ?? 0) >= i + 1);
}

/** Drop depths of nodes no longer on screen, and anything outside `top`'s branch. */
function prune(ix: NavIndex, e: Record<string, number>, top: string | null) {
  const out: Record<string, number> = {};
  for (const [id, d] of Object.entries(e))
    if (d > 0 && (top === null || topOf(ix, id) === top)) out[id] = d;
  // Visibility depends on the others: repeat until stable.
  for (let changed = true; changed;) {
    changed = false;
    for (const id of Object.keys(out))
      if (!isVisible(ix, { expanded: out }, id)) {
        delete out[id];
        changed = true;
      }
  }
  return out;
}

type Step = { s: TreeNavState; limit?: "max" | "min" };

function expandStep(ix: NavIndex, s: TreeNavState): Step {
  const f = s.focusId;
  if (f === null) return { s, limit: "max" };
  const d = s.expanded[f] ?? 0;
  if (d >= maxDetent(ix, f)) return { s, limit: "max" };
  const e = prune(ix, { ...s.expanded, [f]: d + 1 }, topOf(ix, f));
  return { s: { ...s, expanded: e } };
}

function collapseStep(ix: NavIndex, s: TreeNavState): Step {
  const f = s.focusId;
  if (f === null) return { s, limit: "min" };
  const d = s.expanded[f] ?? 0;
  if (d > 0) {
    const e = { ...s.expanded, [f]: d - 1 };
    return { s: { ...s, expanded: prune(ix, e, topOf(ix, f)) } };
  }
  const p = ix.parent.get(f) ?? null;
  if (p === null) return { s, limit: "min" };
  // Past its own level: the focus goes up, and the parent folds one level.
  const pd = s.expanded[p] ?? 1;
  const e = { ...s.expanded, [p]: Math.max(0, pd - 1) };
  return { s: { ...s, focusId: p, expanded: prune(ix, e, topOf(ix, p)) } };
}

/** `n` steps (signed) from `s`, stopping at a limit. */
function steps(ix: NavIndex, s: TreeNavState, n: number): Step {
  let cur: Step = { s };
  for (let i = 0; i < Math.abs(n); i++) {
    const next = n > 0 ? expandStep(ix, cur.s) : collapseStep(ix, cur.s);
    if (next.limit) return { s: cur.s, limit: next.limit };
    cur = next;
  }
  return cur;
}

/** The same object when nothing changes; else the new one. */
function settle(prev: TreeNavState, next: TreeNavState, limit?: "max" | "min"): TreeNavState {
  const out = limit
    ? { ...next, atLimit: limit }
    : next.atLimit
      ? { ...next, atLimit: undefined }
      : next;
  if (
    out.focusId === prev.focusId &&
    out.detent === prev.detent &&
    out.atLimit === prev.atLimit &&
    out.base === prev.base &&
    sameDepths(out.expanded, prev.expanded)
  )
    return prev;
  return out;
}
const sameDepths = (a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

/** Siblings of a node, in order. */
const siblings = (ix: NavIndex, id: string) => {
  const p = ix.parent.get(id) ?? null;
  return p === null ? ix.roots : (ix.children.get(p) ?? []);
};

export function treeNav(ix: NavIndex, s: TreeNavState, ev: TreeNavEvent): TreeNavState {
  switch (ev.type) {
    case "dragStart":
      return { ...s, base: s.base ?? { ...s, base: undefined }, detent: 0, atLimit: undefined };
    case "dragMove": {
      const base = s.base ?? s;
      const r = steps(ix, base, ev.cells);
      return settle(s, { ...r.s, base, detent: ev.cells }, r.limit);
    }
    case "dragEnd": {
      if (!s.base) return s;
      return { ...s, base: undefined, detent: 0, atLimit: undefined };
    }
    case "dragCancel":
      return s.base ? { ...s.base, base: undefined, detent: 0, atLimit: undefined } : s;
    case "tapChip": {
      if (!ix.parent.has(ev.id)) return s;
      // Focus it; a collapsed branch opens one level (the accordion closes others).
      const top = topOf(ix, ev.id);
      const d = s.expanded[ev.id] ?? 0;
      const want = d === 0 && maxDetent(ix, ev.id) > 0 ? 1 : d;
      const e = prune(ix, { ...s.expanded, [ev.id]: want }, top);
      return settle(s, { ...s, focusId: ev.id, expanded: e, base: undefined, detent: 0 });
    }
    case "collapseAll": {
      const f = s.focusId === null ? null : topOf(ix, s.focusId);
      return settle(s, { focusId: f, expanded: {}, detent: 0 });
    }
    case "key": {
      const f = s.focusId;
      if (f === null) return s;
      const sib = siblings(ix, f);
      const i = sib.indexOf(f);
      const step = (n: number) => {
        const r = steps(ix, s, n);
        return settle(s, r.s, r.limit);
      };
      switch (ev.key) {
        case "ArrowRight":
          // Along the row; at its end, expand.
          return i < sib.length - 1 ? settle(s, { ...s, focusId: sib[i + 1]! }) : step(1);
        case "ArrowLeft":
          // Along the row; at its start, collapse.
          return i > 0 ? settle(s, { ...s, focusId: sib[i - 1]! }) : step(-1);
        case "Enter":
          return step(1);
        case "Escape":
          return step(-1);
        case "ArrowDown": {
          // Into the expanded node's children.
          const kid = (ix.children.get(f) ?? [])[0];
          return kid && (s.expanded[f] ?? 0) > 0 ? settle(s, { ...s, focusId: kid }) : s;
        }
        case "ArrowUp": {
          const p = ix.parent.get(f) ?? null;
          return p === null ? s : settle(s, { ...s, focusId: p });
        }
        default:
          return s;
      }
    }
  }
}

/** One detent of the tree button's drag: about the button's width. */
export const TREE_DETENT_PX = 40;
/** How many cells a single drag can reach each way. */
export const TREE_DRAG_CELLS = 6;
/** The tree drag's feel: the card swipe's snap and hysteresis (detent.ts). */
export const TREE_HYSTERESIS = 0.1;
export const TREE_SNAP = 0.6;
export const TREE_STRETCH = 0.3;

/** Cells of a horizontal drag `dx`, from the cells it was at (hysteresis). */
export function dragCells(dx: number, from: number): number {
  return detentLevel(dx / TREE_DETENT_PX, from, {
    min: -TREE_DRAG_CELLS,
    max: TREE_DRAG_CELLS,
    hysteresis: TREE_HYSTERESIS,
  });
}

/**
 * Where the tree button's preview sits for a drag `dx`: snapping to the
 * detents, and past a limit only rubber-banding (STRETCH of the travel
 * beyond `limitCells`), released back to the detent.
 */
export function dragOffset(dx: number, limitCells?: number): number {
  const feel = {
    cell: TREE_DETENT_PX,
    unit: TREE_DETENT_PX,
    max: TREE_DRAG_CELLS,
    snap: TREE_SNAP,
    stretch: TREE_STRETCH,
    stop: TREE_DRAG_CELLS * TREE_DETENT_PX,
  };
  if (limitCells === undefined) return snapDetent(dx, feel);
  const edge = limitCells * TREE_DETENT_PX;
  const past = dx - edge;
  if (Math.sign(past) !== Math.sign(limitCells || dx) || past === 0) return snapDetent(dx, feel);
  return snapDetent(edge, feel) + past * TREE_STRETCH;
}
