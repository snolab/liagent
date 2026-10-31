/**
 * Scrolling over the input scrolls the log, as in mobile chat apps. The log
 * is click-through, so a wheel or a swipe over it reaches the page instead;
 * the box routes the ones over its input to the log.
 *
 * - Input text that fits: the whole delta goes to the log.
 * - Input text that overflows: the input scrolls first. At its top or bottom
 *   end the rest of the same delta (and of the gesture) goes on to the log,
 *   with no dead stop.
 *
 * Deltas are in pixels, positive = the content moves up (scrollTop grows),
 * as a wheel's deltaY or a finger moving up (previous y − new y).
 */

/** The input's scroll position, as its DOM element reports it. */
export type ScrollBox = { scrollTop: number; scrollHeight: number; clientHeight: number };

/** A finger moving less than this is still a tap (the caret goes where it lands). */
export const SWIPE_SLOP_PX = 6;
/** One wheel "line" (deltaMode 1, as Firefox reports a mouse wheel), in pixels. */
export const WHEEL_LINE_PX = 16;

/** Less than this left to scroll counts as none (fractional scrollTop on zoomed pages). */
const EPS = 1;

/** How far `el` can scroll down (positive) and up (negative) from where it is. */
export function scrollRoom(el: ScrollBox): { up: number; down: number } {
  const max = Math.max(0, el.scrollHeight - el.clientHeight);
  const top = Math.min(max, Math.max(0, el.scrollTop));
  const down = max - top;
  return { up: top < EPS ? 0 : top, down: down < EPS ? 0 : down };
}

/**
 * Split one scroll delta between the input and the log: the input takes what
 * it has room for in that direction, and the log the rest.
 */
export function splitScroll(
  input: ScrollBox,
  delta: number,
): { inputDelta: number; logDelta: number } {
  if (!Number.isFinite(delta) || delta === 0) return { inputDelta: 0, logDelta: 0 };
  const room = scrollRoom(input);
  // `+ 0` turns -0 into 0.
  const inputDelta = (delta > 0 ? Math.min(delta, room.down) : Math.max(delta, -room.up)) + 0;
  return { inputDelta, logDelta: delta - inputDelta + 0 };
}

/** A wheel event's vertical delta in pixels (deltaMode 0 pixels, 1 lines, 2 pages). */
export function wheelPixels(deltaY: number, deltaMode: number, pagePx: number): number {
  if (deltaMode === 1) return deltaY * WHEEL_LINE_PX;
  if (deltaMode === 2) return deltaY * pagePx;
  return deltaY;
}

/**
 * One touch gesture over the input, move by move. Until the finger leaves
 * SWIPE_SLOP_PX it is a tap and nothing scrolls. Then each move is split:
 * while the input scrolls natively the box leaves it alone (no
 * preventDefault) and adds only the log's share; once a move had to be
 * cancelled (nothing for the input), the box drives both for the rest of the
 * gesture, since the browser no longer scrolls the input by itself then.
 */
export function createSwipeHandoff() {
  let y = 0;
  let swiping = false;
  let owned = false;
  return {
    start(clientY: number) {
      y = clientY;
      swiping = false;
      owned = false;
    },
    /**
     * A move to `clientY`. `cancelable`: the touchmove can still be cancelled.
     * The answer: what to add to the input's and the log's scrollTop by hand,
     * and whether to preventDefault (null: still a tap, do nothing).
     */
    move(
      input: ScrollBox,
      clientY: number,
      cancelable: boolean,
    ): { inputDelta: number; logDelta: number; prevent: boolean } | null {
      if (!swiping && Math.abs(clientY - y) < SWIPE_SLOP_PX) return null;
      swiping = true;
      const delta = y - clientY;
      y = clientY;
      const { inputDelta, logDelta } = splitScroll(input, delta);
      if (!owned && inputDelta === 0 && cancelable) owned = true;
      if (owned) return { inputDelta, logDelta, prevent: cancelable };
      // The browser scrolls the input itself (and overscroll-behavior keeps it from the page).
      return { inputDelta: 0, logDelta, prevent: false };
    },
  };
}
