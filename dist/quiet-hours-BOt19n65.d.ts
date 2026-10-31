import { o as TreeStrings } from "./tree-CZ50sZNq.js";

//#region src/ui-strings.d.ts
type UiStrings = {
  stateTree: string;
  closeTree: string;
  noTreeSource: string;
  lastDone: string;
  nowDoing: string;
  upNext: string;
  needsYou: string;
  items: string; /** The mark on a voice line the agent polished (its tooltip and label). */
  polished: string;
};
declare const UI_EN: UiStrings;
declare const UI_ZH: UiStrings;
/** The tree's strings in Chinese (tree.ts TreeStrings). */
declare const TREE_ZH: TreeStrings;
/** The page's language is Chinese. */
declare function isZh(lang?: string | null | undefined): boolean;
/** The box's strings for the page's language. */
declare const uiStrings: (lang?: string | null) => UiStrings;
/** The tree's defaults for the page's language, under the host's own. */
declare const treeDefaults: (lang?: string | null) => Partial<TreeStrings>;
//#endregion
//#region src/quiet-hours.d.ts
/**
 * Quiet lines and quiet hours: which agent lines are read aloud. Every line
 * is shown in the log; this decides only whether it is also spoken. In
 * order:
 *
 * 1. A hidden page (another tab, the app in the background, the screen
 *    locked: `document.visibilityState` "hidden") never speaks, not even a
 *    loud line. The box also stops a reading under way when the page hides.
 * 2. A loud line (`loud: true`, `liagent say --loud`) is read by the usual
 *    rules, quiet hours or not. The user's mute (read-aloud off in the
 *    menu, with no mic on) still silences it.
 * 3. A quiet line (`quiet: true`, `liagent say --quiet`: FYI, progress,
 *    notices) is never read, even with a mic on.
 * 4. Inside quiet hours nothing else is read. They are a device-local
 *    setting (localStorage `liagent:quiet-hours`, under the box's
 *    storage-key), on by default, 23:00–08:00 in the device's own time
 *    zone; a window whose end is before its start wraps past midnight.
 *
 * Pure apart from the storage helpers, which take a store (tests pass a
 * plain object): test/quiet-hours.test.ts.
 */
/** localStorage: `{on, from, to}` as JSON. Device-local, never synced. */
declare const QUIET_HOURS_KEY = "liagent:quiet-hours";
/** Fired on window when this tab saves the quiet hours (other tabs hear `storage`). */
declare const QUIET_HOURS_EVENT = "liagent:quiet-hours";
/** Quiet hours: on/off, and the window as local "HH:MM" times (from inclusive, to exclusive). */
type QuietHours = {
  on: boolean;
  from: string;
  to: string;
};
declare const DEFAULT_QUIET_HOURS: QuietHours;
/** "HH:MM" (24 h) as minutes after midnight; anything else is null. */
declare function parseHm(s: unknown): number | null;
/** Minutes after local midnight, in the device's time zone. */
declare const minuteOfDay: (d: Date) => number;
/**
 * Whether `minute` (after midnight) lies in [from, to). A window whose end
 * is before its start wraps past midnight (23:00–08:00 holds 23:30 and
 * 07:59, not 08:00). from = to is an empty window.
 */
declare function inQuietWindow(minute: number, from: number, to: number): boolean;
/** Whether quiet hours hold at `now` (on the device's clock and time zone). */
declare function quietNow(q: QuietHours, now: Date): boolean;
/** Quiet hours from any value, each field checked; anything missing or broken is the default. */
declare function cleanQuietHours(v: unknown): QuietHours;
/** The saved quiet hours (JSON, or null), as cleanQuietHours. */
declare function readQuietHours(raw: string | null): QuietHours;
type Store = {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
};
/** This device's quiet hours. */
declare function quietHours(s?: Store | null): QuietHours;
/**
 * Save this device's quiet hours: the fields given replace the saved ones,
 * times normalised to "HH:MM". Tells this tab's listeners (QUIET_HOURS_EVENT).
 */
declare function setQuietHours(q: Partial<QuietHours>, s?: Store | null): QuietHours;
/** What a line says about being read aloud (ChatMessage's `quiet` and `loud`). */
type SpeakMeta = {
  quiet?: unknown;
  loud?: unknown;
};
/** Loud: `say --loud`. Only boolean true counts. */
declare const isLoud: (m: SpeakMeta) => boolean;
/** Quiet: `say --quiet`, unless it is loud too. */
declare const isQuiet: (m: SpeakMeta) => boolean;
/** Why a line is not read aloud; null = read it (by the usual rules). */
type Silence = "hidden" | "quiet" | "quiet-hours";
/** The rules in order: hidden, then loud (read), then quiet, then quiet hours. */
declare function silenceFor(m: SpeakMeta, at: {
  now: Date;
  hidden: boolean;
  hours: QuietHours;
}): Silence | null;
/** The page is hidden or the screen is locked (true without a document: never speak there). */
declare const pageHidden: () => boolean;
//#endregion
export { isZh as C, UiStrings as S, uiStrings as T, setQuietHours as _, Silence as a, UI_EN as b, inQuietWindow as c, minuteOfDay as d, pageHidden as f, readQuietHours as g, quietNow as h, QuietHours as i, isLoud as l, quietHours as m, QUIET_HOURS_EVENT as n, SpeakMeta as o, parseHm as p, QUIET_HOURS_KEY as r, cleanQuietHours as s, DEFAULT_QUIET_HOURS as t, isQuiet as u, silenceFor as v, treeDefaults as w, UI_ZH as x, TREE_ZH as y };
//# sourceMappingURL=quiet-hours-BOt19n65.d.ts.map