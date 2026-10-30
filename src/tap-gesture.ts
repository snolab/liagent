/**
 * One tap or two (the chat box's grip): a single tap acts only once
 * `delayMs` pass without a second; a second tap inside that window cancels it
 * and acts as a double tap. Timers are injected for tests.
 */
export const DOUBLE_TAP_MS = 280;

export function createTapper(d: {
  onSingle: () => void;
  onDouble: () => void;
  delayMs?: number;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}) {
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let waiting: unknown = null;
  return {
    tap() {
      if (waiting !== null) {
        clearTimer(waiting);
        waiting = null;
        return d.onDouble();
      }
      waiting = setTimer(() => {
        waiting = null;
        d.onSingle();
      }, d.delayMs ?? DOUBLE_TAP_MS);
    },
    /** Drop a single tap still waiting (unmount). */
    cancel() {
      if (waiting !== null) clearTimer(waiting);
      waiting = null;
    },
  };
}

/** How long after a drag ends its click is still "the click that ended a drag". */
export const DRAG_CLICK_MS = 400;

/**
 * Tells the click that ends a drag from a real tap. The flag is cleared by
 * the next pointerdown and expires after DRAG_CLICK_MS, so a browser that
 * sends no click after a touch drag (iOS) never swallows the next tap.
 */
export function createDragFlag(now: () => number = Date.now) {
  let endedAt: number | null = null;
  return {
    /** A press starts: whatever came before is over. */
    down() {
      endedAt = null;
    },
    /** A press that moved has ended. */
    dragEnded() {
      endedAt = now();
    },
    /** For the click that follows: was it the end of a drag? (Read once.) */
    wasDrag() {
      const d = endedAt !== null && now() - endedAt < DRAG_CLICK_MS;
      endedAt = null;
      return d;
    },
  };
}

/** A press must move this far before it counts as a drag, and its axis is locked. */
export const AXIS_LOCK_PX = 8;

/**
 * One press on the mic, told apart by its first AXIS_LOCK_PX of movement:
 * under that it stays a tap (the mic toggles); then it locks to an axis for
 * the rest of the press — "y" scrubs the chat history, "x" moves the bar.
 * `up` says whether the click that follows must be swallowed (any lock).
 */
export function createAxisLock(lockPx = AXIS_LOCK_PX) {
  let start: { x: number; y: number } | null = null;
  let axis: "x" | "y" | null = null;
  return {
    down(x: number, y: number) {
      start = { x, y };
      axis = null;
    },
    /** The locked axis and the movement since the press, or null while still a tap. */
    move(x: number, y: number): { axis: "x" | "y"; dx: number; dy: number } | null {
      if (!start) return null;
      const dx = x - start.x;
      const dy = y - start.y;
      if (!axis) {
        if (Math.hypot(dx, dy) < lockPx) return null;
        axis = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
      }
      return { axis, dx, dy };
    },
    /** The press ends: the axis it locked to (null = it was a tap). */
    up(): "x" | "y" | null {
      const a = axis;
      start = null;
      axis = null;
      return a;
    },
    axis: () => axis,
  };
}

/** Pixels of vertical drag per message line scrubbed. */
export const SCRUB_STEP_PX = 28;

/**
 * Where a scrub lands: `back` lines from the newest, from where it started and
 * the finger's vertical travel. Finger down = older (as the expanded log's
 * swipe: the content follows the finger), clamped to [0, max].
 */
export function scrubBack(startBack: number, dy: number, max: number, step = SCRUB_STEP_PX) {
  return Math.max(0, Math.min(max, startBack + Math.trunc(dy / step)));
}

/**
 * A press held for `ms` (500 by default) without moving off: `onLong` fires
 * once. `down` starts it; `up` or `cancel` (the press ended or moved away)
 * stops it. Timers are injected for tests.
 */
export function createLongPress(d: {
  onLong: () => void;
  ms?: number;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}) {
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let t: unknown = null;
  let fired = false;
  const stop = () => {
    if (t !== null) clearTimer(t);
    t = null;
  };
  return {
    down() {
      stop();
      fired = false;
      t = setTimer(() => {
        t = null;
        fired = true;
        d.onLong();
      }, d.ms ?? 500);
    },
    /** The press ended: whether it was a long press. */
    up() {
      stop();
      return fired;
    },
    cancel: stop,
  };
}
