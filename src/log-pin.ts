/**
 * Keeping the log on its newest line while things around it change size.
 *
 * The log follows new lines only from its end (src/box.ts atEnd). When the
 * log or its lines change size — the input grows or shrinks, the on-screen
 * keyboard opens, the text size changes, the box is moved or a panel opens —
 * a log that was at its end must stay there, and the scroll the re-pin itself
 * causes (it lands a frame later, sometimes after the log shrank again) must
 * not count as the user leaving the end. Only the user's own scrolling does.
 *
 * Pure, so it is unit tested (test/log-pin.test.ts).
 */

/** Within this many px of the end, the log counts as at its end. */
export const END_SLACK_PX = 4;

/**
 * The scrollTop that keeps a log at its end after a size change, or null
 * when nothing needs to move (scrolled up: never pinned).
 */
export function repinEnd(d: {
  atEnd: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): number | null {
  if (!d.atEnd) return null;
  const max = Math.max(0, d.scrollHeight - d.clientHeight);
  return Math.abs(max - d.scrollTop) > 1 ? max : null;
}

/**
 * Whether the log is at its end after a scroll event: within END_SLACK_PX
 * of it, or the scroll was the re-pin's own (and the user did not scroll
 * since).
 */
export function stillAtEnd(d: { gap: number; ownPin: boolean; userScrolled: boolean }): boolean {
  if (d.gap < END_SLACK_PX) return true;
  return d.ownPin && !d.userScrolled;
}
