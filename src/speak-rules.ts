/**
 * Which agent lines are read aloud. Every line is shown in the log; this
 * decides only whether it is also spoken. There is no time of day in it.
 *
 * 1. A quiet line (`quiet: true`, `liagent say --quiet`: FYI, progress,
 *    notices) is never read, even with a mic on.
 * 2. A hidden page (another tab, the app in the background, the screen
 *    locked: `document.visibilityState` "hidden") never speaks; browsers
 *    would not let it. The box also stops a reading under way when the page
 *    hides.
 *
 * Everything else is read by the usual rules (read-aloud on, or a mic on).
 * Pure: test/speak-rules.test.ts.
 */

/**
 * What a line says about being read aloud (ChatMessage's `quiet` and
 * `lang`). `lang` (a BCP-47 tag, checked with protocol's langTag) picks the
 * reading language; it never silences a line.
 */
export type SpeakMeta = { quiet?: unknown; lang?: unknown };

/** Quiet: `say --quiet`. Only boolean true counts. */
export const isQuiet = (m: SpeakMeta) => m.quiet === true;

/** Why a line is not read aloud; null = read it (by the usual rules). */
export type Silence = "hidden" | "quiet";

/** The rules: a quiet line, then a hidden page. */
export function silenceFor(m: SpeakMeta, at: { hidden: boolean }): Silence | null {
  if (isQuiet(m)) return "quiet";
  if (at.hidden) return "hidden";
  return null;
}

/** The page is hidden or the screen is locked (true without a document: never speak there). */
export const pageHidden = () =>
  typeof document === "undefined" || document.visibilityState === "hidden";

/**
 * Per-device setting names an older version saved (under the box's
 * storage-key) that mean nothing now. The box removes them when it attaches.
 */
export const RETIRED_SETTINGS = ["quiet-hours"] as const;
