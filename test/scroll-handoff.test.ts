import { describe, expect, it } from "bun:test";
import {
  SWIPE_SLOP_PX,
  WHEEL_LINE_PX,
  createSwipeHandoff,
  scrollRoom,
  splitScroll,
  wheelPixels,
} from "../src/scroll-handoff.ts";

/** An input 40px tall: `text` px of content, scrolled to `top`. */
const input = (text: number, top = 0) => ({ scrollTop: top, scrollHeight: text, clientHeight: 40 });

describe("splitScroll", () => {
  it("sends the whole delta to the log when the text fits the input (empty or not)", () => {
    expect(splitScroll(input(40), 30)).toEqual({ inputDelta: 0, logDelta: 30 });
    expect(splitScroll(input(40), -30)).toEqual({ inputDelta: 0, logDelta: -30 });
    expect(splitScroll(input(20), 5)).toEqual({ inputDelta: 0, logDelta: 5 });
  });

  it("scrolls overflowing text first, inside its room", () => {
    expect(splitScroll(input(200, 50), 30)).toEqual({ inputDelta: 30, logDelta: 0 });
    expect(splitScroll(input(200, 50), -30)).toEqual({ inputDelta: -30, logDelta: 0 });
  });

  it("hands the rest of a delta on to the log at the input's end", () => {
    // 160px of room down from the top; 10px left at 150.
    expect(splitScroll(input(200, 150), 30)).toEqual({ inputDelta: 10, logDelta: 20 });
    expect(splitScroll(input(200, 20), -50)).toEqual({ inputDelta: -20, logDelta: -30 });
    // At the bottom end: all of a downward delta is the log's, an upward one the input's.
    expect(splitScroll(input(200, 160), 25)).toEqual({ inputDelta: 0, logDelta: 25 });
    expect(splitScroll(input(200, 160), -25)).toEqual({ inputDelta: -25, logDelta: 0 });
    // At the top end: the reverse.
    expect(splitScroll(input(200, 0), -25)).toEqual({ inputDelta: 0, logDelta: -25 });
  });

  it("treats sub-pixel room as none, and a zero or bad delta as nothing", () => {
    expect(splitScroll(input(200, 159.6), 10)).toEqual({ inputDelta: 0, logDelta: 10 });
    expect(splitScroll(input(40.5), 10)).toEqual({ inputDelta: 0, logDelta: 10 });
    expect(splitScroll(input(200, 50), 0)).toEqual({ inputDelta: 0, logDelta: 0 });
    expect(splitScroll(input(200, 50), Number.NaN)).toEqual({ inputDelta: 0, logDelta: 0 });
  });

  it("clamps a scrollTop out of range", () => {
    expect(scrollRoom(input(200, 999))).toEqual({ up: 160, down: 0 });
    expect(scrollRoom(input(200, -5))).toEqual({ up: 0, down: 160 });
  });
});

describe("wheelPixels", () => {
  it("converts lines and pages to pixels", () => {
    expect(wheelPixels(12, 0, 300)).toBe(12);
    expect(wheelPixels(3, 1, 300)).toBe(3 * WHEEL_LINE_PX);
    expect(wheelPixels(-1, 2, 300)).toBe(-300);
  });
});

describe("createSwipeHandoff", () => {
  it("is still a tap under the slop: nothing scrolls, nothing is cancelled", () => {
    const s = createSwipeHandoff();
    s.start(100);
    expect(s.move(input(40), 100 - (SWIPE_SLOP_PX - 1), true)).toBeNull();
    expect(s.move(input(200, 50), 100 + (SWIPE_SLOP_PX - 1), true)).toBeNull();
  });

  it("scrolls the log by hand (and cancels) when the text fits", () => {
    const s = createSwipeHandoff();
    s.start(100);
    // The finger moves up 20px: the content moves up, the log scrolls down.
    expect(s.move(input(40), 80, true)).toEqual({ inputDelta: 0, logDelta: 20, prevent: true });
    expect(s.move(input(40), 90, true)).toEqual({ inputDelta: 0, logDelta: -10, prevent: true });
  });

  it("leaves a native input scroll alone, and adds the overflow to the log", () => {
    const s = createSwipeHandoff();
    s.start(100);
    // Room in the input: the browser scrolls it, the box does nothing.
    expect(s.move(input(200, 100), 80, true)).toEqual({
      inputDelta: 0,
      logDelta: 0,
      prevent: false,
    });
    // Near the end (10px left), while the native scroll runs (no longer cancelable).
    expect(s.move(input(200, 150), 50, false)).toEqual({
      inputDelta: 0,
      logDelta: 20,
      prevent: false,
    });
    // At the end: the rest of the gesture goes to the log, no dead stop.
    expect(s.move(input(200, 160), 30, false)).toEqual({
      inputDelta: 0,
      logDelta: 20,
      prevent: false,
    });
  });

  it("drives both by hand once a move had to be cancelled", () => {
    const s = createSwipeHandoff();
    s.start(100);
    // At the bottom end, moving on down: the log's, cancelled.
    expect(s.move(input(200, 160), 80, true)).toEqual({
      inputDelta: 0,
      logDelta: 20,
      prevent: true,
    });
    // Reversing: the browser will not scroll the input now, so the box does.
    expect(s.move(input(200, 160), 110, true)).toEqual({
      inputDelta: -30,
      logDelta: 0,
      prevent: true,
    });
    // A new gesture starts afresh.
    s.start(100);
    expect(s.move(input(200, 100), 80, true)).toEqual({
      inputDelta: 0,
      logDelta: 0,
      prevent: false,
    });
  });
});
