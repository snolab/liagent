import { T as Frontier, w as Assignee } from "./tree-HB9RhX_H.js";
import { a as isZh, i as UiStrings, n as UI_EN, o as treeDefaults, r as UI_ZH, s as uiStrings, t as TREE_ZH } from "./ui-strings-B03le3fh.js";
import { a as dice, c as normalizeEcho, i as EchoScore, n as ECHO_SIMILARITY, o as echoScore, r as ECHO_WINDOW_MS, s as grams, t as ECHO_MIN_CHARS } from "./echo-W2RcMEny.js";

//#region src/tree-nav.d.ts
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
/** The tree as the reducer sees it: ids, parents, children in order. */
type NavIndex = {
  roots: string[];
  parent: Map<string, string | null>;
  children: Map<string, string[]>;
};
/** Build a NavIndex from any tree. */
declare function indexTree<N>(roots: readonly N[], childrenOf: (n: N) => readonly N[], idOf: (n: N, parentId: string | null, i: number) => string): NavIndex;
/** Levels below a node: 0 for a leaf. */
declare function height(ix: NavIndex, id: string): number;
/** How deep a node can open: min(3, its subtree's height); 0 for a leaf. */
declare const MAX_DETENT = 3;
declare function maxDetent(ix: NavIndex, id: string): number;
type TreeNavState = {
  focusId: string | null; /** Depth per node, along one branch (the accordion). */
  expanded: Readonly<Record<string, number>>; /** The drag's cells so far (signed), 0 when not dragging. */
  detent: number; /** Hit a limit on the last step: the view resists. */
  atLimit?: "max" | "min"; /** While dragging: the committed state the drag started from. */
  base?: TreeNavState;
};
type TreeNavEvent = {
  type: "dragStart";
} | {
  type: "dragMove";
  cells: number;
} | {
  type: "dragEnd";
} | {
  type: "dragCancel";
} | {
  type: "tapChip";
  id: string;
} | {
  type: "key";
  key: string;
} | {
  type: "collapseAll";
};
declare const initialNav: (ix: NavIndex) => TreeNavState;
/** Is a node on screen: a top-level chip, or within an expanded ancestor's depth. */
declare function isVisible(ix: NavIndex, s: Pick<TreeNavState, "expanded">, id: string): boolean;
declare function treeNav(ix: NavIndex, s: TreeNavState, ev: TreeNavEvent): TreeNavState;
/** One detent of the tree button's drag: about the button's width. */
declare const TREE_DETENT_PX = 40;
/** How many cells a single drag can reach each way. */
declare const TREE_DRAG_CELLS = 6;
/** The tree drag's feel: the card swipe's snap and hysteresis (detent.ts). */
declare const TREE_HYSTERESIS = 0.1;
declare const TREE_SNAP = 0.6;
declare const TREE_STRETCH = 0.3;
/** Cells of a horizontal drag `dx`, from the cells it was at (hysteresis). */
declare function dragCells(dx: number, from: number): number;
/**
 * Where the tree button's preview sits for a drag `dx`: snapping to the
 * detents, and past a limit only rubber-banding (STRETCH of the travel
 * beyond `limitCells`), released back to the detent.
 */
declare function dragOffset(dx: number, limitCells?: number): number;
//#endregion
//#region src/detent.d.ts
/**
 * Detents: a drag quantised into levels, each one a cell of travel, with a
 * light magnetic hold and hysteresis: the feel of a card swipe, and of the
 * chat's tree button.
 *
 * While dragging, the thing follows a smooth staircase of the finger:
 *   t = f / cell,   x = unit · (t − snap·sin(2πt) / 2π)
 * whose slope is 1 − snap on a level (it holds, yet gives a little) and
 * 1 + snap between levels (it slides into the next one). Past the last level
 * it stretches at `stretch` (rubber band) up to `stop`.
 */
type DetentFeel = {
  /** Finger travel per level, px. */cell: number; /** The visual unit (px moved per level). */
  unit: number; /** Levels each way (or `[min, max]` levels when the two sides differ). */
  max: number;
  min?: number; /** How strongly a level holds (0..<1). */
  snap: number; /** Past the last level the thing follows this much of the finger… */
  stretch: number; /** …up to this far out, px. */
  stop: number;
};
/** The thing's position for a finger travel: the snapping staircase, then the rubber band. */
declare function snapDetent(finger: number, o: DetentFeel): number;
/**
 * The level after `t` cells of travel, from level `from`, with hysteresis
 * both ways: it moves on only `hysteresis` past a midpoint, so a finger
 * resting on a boundary never flickers.
 */
declare function detentLevel(t: number, from: number, o: {
  min: number;
  max: number;
  hysteresis: number;
}): number;
//#endregion
//#region src/float-lines.d.ts
/**
 * The minimized chat's floating lines: a message that arrives while the chat is
 * minimized floats above the bar for as long as it takes to read it twice,
 * then fades. Hovering or touching the lines pauses their timers.
 */
/** Characters per second read in CJK scripts (Han, kana, Hangul). */
declare const READ_RATE_CJK = 6;
/** Characters per second for everything else (~180 words per minute). */
declare const READ_RATE_LATIN = 15;
/** A line stays up for this many reading times... */
declare const DWELL_FACTOR = 2;
/** ...and never less than this. */
declare const DWELL_MIN_MS = 2500;
/** The slow fade-out once the dwell is over (gone at once under reduced motion). */
declare const FADE_MS = 10000;
/** At most this many lines float at once; the oldest goes first. */
declare const FLOAT_MAX = 6;
/** Seconds to read `text` once: CJK characters at 6/s, the rest at 15/s. */
declare function readTime(text: string): number;
/** How long a floating line stays before it fades, in ms. */
declare function dwellMs(text: string): number;
/**
 * One line's countdown: a single setTimeout, stopped by `pause` and restarted
 * by `resume` with the time that was left. Clock and timers are injected for
 * tests.
 */
declare function createDwellTimer(d: {
  ms: number;
  onDone: () => void;
  now?: () => number;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): {
  pause(): void;
  resume(): void;
  cancel(): void; /** The time left, in ms (frozen while paused). */
  remaining: () => number;
};
/** The latest message floats on minimize only if it arrived at most this long ago. */
declare const MINIMIZE_FLOAT_MAX_AGE_MS: number;
/**
 * When this widget first saw each message, by id — this device's clock, never
 * the message's own `at` (another clock, which may be skewed). New messages
 * are told by id, not by the list's length: the host caps its history, so
 * once full the list stays the same length as new lines push old ones out.
 */
declare function createArrivals(): {
  /**
   * The messages not seen before, in order. The first non-empty list is the
   * history: it is recorded, but `history` says not to float it.
   */
  see<M extends {
    id: string;
  }>(messages: M[], now: number): {
    fresh: M[];
    history: boolean;
  }; /** When it was first seen here (undefined: never). */
  at: (id: string) => number | undefined; /** Its place in arrival order (undefined: never seen). */
  seqOf: (id: string) => number | undefined; /** The last place handed out: everything up to here has arrived. */
  seq: () => number;
};
/**
 * The minimized bar's unread badge: the agent's messages that arrived after
 * `readSeq` (the arrival order when the chat was last open, or the history
 * loaded). By arrival, not by list position: a capped list keeps its length.
 */
declare function countUnread<M extends {
  id: string;
  from: string;
}>(messages: M[], seqOf: (id: string) => number | undefined, readSeq: number): number;
/**
 * At the moment the chat is minimized, the latest message (from anyone) is
 * treated as unread and floats, unless it arrived here more than
 * MINIMIZE_FLOAT_MAX_AGE_MS ago. Its dwell starts then, not when it arrived.
 */
declare function minimizeFloat<M extends {
  id: string;
}>(messages: M[], now: number, arrivedAt: (id: string) => number | undefined): M | null;
/**
 * A floating line's life: "dwell" (fully visible) → "fade" (FADE_MS of
 * opacity going down) → "gone". Paused (hovered, touched, a scrub) during the
 * dwell, its time is frozen; paused during the fade, it is "held" at full
 * opacity, and the fade starts over from full once released. Under reduced
 * motion the dwell's end is the end. Timers are injected for tests.
 */
type FloatPhase = "dwell" | "fade" | "held" | "gone";
declare function createFloatLife(d: {
  ms: number;
  fadeMs?: number;
  reducedMotion?: boolean;
  paused?: boolean;
  onPhase: (p: FloatPhase) => void;
  now?: () => number;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): {
  pause(): void;
  resume(): void;
  cancel(): void;
  phase: () => FloatPhase;
};
//#endregion
//#region src/anchor.d.ts
/**
 * Where the minimized chat's floating box (its floating lines, the frontier,
 * the tree) goes: on the side of the bar it hangs from. The bar in the right
 * third of the screen: the box's right edge on the bar's; the left third: left
 * edges together; the middle: centred on it. Always inside the viewport less
 * the safe areas and an 8px gutter.
 */
type AnchorSide = "left" | "center" | "right";
declare const ANCHOR_GUTTER_PX = 8;
/** The bar's side of the screen, by its centre: thirds. */
declare function anchorSide(barLeft: number, barRight: number, vw: number): AnchorSide;
/** The box's left edge (viewport px) for its width, anchored to the bar and clamped. */
declare function placeBox(d: {
  barLeft: number;
  barRight: number;
  boxWidth: number;
  vw: number;
  insetLeft?: number;
  insetRight?: number;
  gutter?: number;
}): {
  side: AnchorSide;
  left: number;
};
//#endregion
//#region src/frontier-view.d.ts
declare const FRONTIER_ROWS: readonly [{
  readonly key: "done";
  readonly mark: "✓";
  readonly label: "Last done";
}, {
  readonly key: "doing";
  readonly mark: "▶";
  readonly label: "In progress";
}, {
  readonly key: "next";
  readonly mark: "›";
  readonly label: "Next";
}];
/** Visible characters of an agent id at the line's end. */
declare const SHORT_ID_LEN = 6;
/** Longer than this, an "id" is more likely a token than a slug: hidden. */
declare const MAX_ID_LEN = 64;
/** How long a touch must rest on the id to show the full one. */
declare const LONG_PRESS_MS = 500;
/**
 * The agent id to show, or null. Only agents have one shown, and only an
 * opaque slug: anything that looks like a host, a path, a pid:port or a
 * token (a dot, colon or slash, or over 64 characters) is dropped.
 */
declare function shownAgentId(a: Assignee | undefined): string | null;
/** The last SHORT_ID_LEN characters, for the line's end. */
declare const shortId: (id: string) => string;
/** The `〔N〕` after a group's summary; nothing for a single item. */
declare const countBadge: (n: number | undefined) => string;
/** One frontier line as the minimized bar draws it. */
type FrontierLine = {
  /** A group's ≈ summary (several items), else the one item's title. */text: string;
  count: number;
  assignee?: Assignee; /** A group's members (only when count > 1), each with its breadcrumb. */
  items?: {
    title: string;
    path: string;
    assignee?: Assignee;
  }[];
};
type FrontierView = {
  done?: FrontierLine;
  doing?: FrontierLine;
  next?: FrontierLine;
};
/**
 * The bar's lines from state-tree.ts frontier(): a group as its summary (or,
 * without one, its first item's title) and count, its items with breadcrumbs;
 * one item as its title. Undefined when there is nothing to show.
 */
declare function frontierView(f: Frontier): FrontierView | undefined;
//#endregion
//#region src/speech-rate.d.ts
/**
 * How fast the agent's replies are read aloud: a per-device setting
 * (localStorage `liagent:speech-rate`), picked in the chat's menu. Applied
 * from the next utterance, on both outputs (the speech utterance's rate, or a cloud
 * voice's playbackRate with the pitch kept).
 */
declare const SPEECH_RATE_KEY = "liagent:speech-rate";
declare const SPEECH_RATES: readonly [1, 1.25, 1.5, 2];
declare const DEFAULT_SPEECH_RATE = 1.5;
type Store = {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
};
/** The saved rate, if it is one of SPEECH_RATES; else the default. */
declare function speechRate(s?: Store | null): number;
/** Save a rate (one of SPEECH_RATES; anything else is ignored). */
declare function setSpeechRate(rate: number, s?: Store | null): void;
//#endregion
//#region src/tap-gesture.d.ts
/**
 * One tap or two (the chat box's grip): a single tap acts only once
 * `delayMs` pass without a second; a second tap inside that window cancels it
 * and acts as a double tap. Timers are injected for tests.
 */
declare const DOUBLE_TAP_MS = 280;
declare function createTapper(d: {
  onSingle: () => void;
  onDouble: () => void;
  delayMs?: number;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): {
  tap(): void; /** Drop a single tap still waiting (unmount). */
  cancel(): void;
};
/** How long after a drag ends its click is still "the click that ended a drag". */
declare const DRAG_CLICK_MS = 400;
/**
 * Tells the click that ends a drag from a real tap. The flag is cleared by
 * the next pointerdown and expires after DRAG_CLICK_MS, so a browser that
 * sends no click after a touch drag (iOS) never swallows the next tap.
 */
declare function createDragFlag(now?: () => number): {
  /** A press starts: whatever came before is over. */down(): void; /** A press that moved has ended. */
  dragEnded(): void; /** For the click that follows: was it the end of a drag? (Read once.) */
  wasDrag(): boolean;
};
/** A press must move this far before it counts as a drag, and its axis is locked. */
declare const AXIS_LOCK_PX = 8;
/**
 * One press on the mic, told apart by its first AXIS_LOCK_PX of movement:
 * under that it stays a tap (the mic toggles); then it locks to an axis for
 * the rest of the press — "y" scrubs the chat history, "x" moves the bar.
 * `up` says whether the click that follows must be swallowed (any lock).
 */
declare function createAxisLock(lockPx?: number): {
  down(x: number, y: number): void; /** The locked axis and the movement since the press, or null while still a tap. */
  move(x: number, y: number): {
    axis: "x" | "y";
    dx: number;
    dy: number;
  } | null; /** The press ends: the axis it locked to (null = it was a tap). */
  up(): "x" | "y" | null;
  axis: () => "x" | "y" | null;
};
/** Pixels of vertical drag per message line scrubbed. */
declare const SCRUB_STEP_PX = 28;
/**
 * Where a scrub lands: `back` lines from the newest, from where it started and
 * the finger's vertical travel. Finger down = older (as the expanded log's
 * swipe: the content follows the finger), clamped to [0, max].
 */
declare function scrubBack(startBack: number, dy: number, max: number, step?: number): number;
/**
 * A press held for `ms` (500 by default) without moving off: `onLong` fires
 * once. `down` starts it; `up` or `cancel` (the press ended or moved away)
 * stops it. Timers are injected for tests.
 */
declare function createLongPress(d: {
  onLong: () => void;
  ms?: number;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): {
  down(): void; /** The press ended: whether it was a long press. */
  up(): boolean;
  cancel: () => void;
};
//#endregion
export { ANCHOR_GUTTER_PX, AXIS_LOCK_PX, AnchorSide, DEFAULT_SPEECH_RATE, DOUBLE_TAP_MS, DRAG_CLICK_MS, DWELL_FACTOR, DWELL_MIN_MS, DetentFeel, ECHO_MIN_CHARS, ECHO_SIMILARITY, ECHO_WINDOW_MS, EchoScore, FADE_MS, FLOAT_MAX, FRONTIER_ROWS, FloatPhase, FrontierLine, FrontierView, LONG_PRESS_MS, MAX_DETENT, MAX_ID_LEN, MINIMIZE_FLOAT_MAX_AGE_MS, NavIndex, READ_RATE_CJK, READ_RATE_LATIN, SCRUB_STEP_PX, SHORT_ID_LEN, SPEECH_RATES, SPEECH_RATE_KEY, TREE_DETENT_PX, TREE_DRAG_CELLS, TREE_HYSTERESIS, TREE_SNAP, TREE_STRETCH, TREE_ZH, TreeNavEvent, TreeNavState, UI_EN, UI_ZH, UiStrings, anchorSide, countBadge, countUnread, createArrivals, createAxisLock, createDragFlag, createDwellTimer, createFloatLife, createLongPress, createTapper, detentLevel, dice, dragCells, dragOffset, dwellMs, echoScore, frontierView, grams, height, indexTree, initialNav, isVisible, isZh, maxDetent, minimizeFloat, normalizeEcho, placeBox, readTime, scrubBack, setSpeechRate, shortId, shownAgentId, snapDetent, speechRate, treeDefaults, treeNav, uiStrings };
//# sourceMappingURL=ui.d.ts.map