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
export const QUIET_HOURS_KEY = "liagent:quiet-hours";
/** Fired on window when this tab saves the quiet hours (other tabs hear `storage`). */
export const QUIET_HOURS_EVENT = "liagent:quiet-hours";

/** Quiet hours: on/off, and the window as local "HH:MM" times (from inclusive, to exclusive). */
export type QuietHours = { on: boolean; from: string; to: string };
export const DEFAULT_QUIET_HOURS: QuietHours = { on: true, from: "23:00", to: "08:00" };

/** "HH:MM" (24 h) as minutes after midnight; anything else is null. */
export function parseHm(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Minutes after local midnight, in the device's time zone. */
export const minuteOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();

/**
 * Whether `minute` (after midnight) lies in [from, to). A window whose end
 * is before its start wraps past midnight (23:00–08:00 holds 23:30 and
 * 07:59, not 08:00). from = to is an empty window.
 */
export function inQuietWindow(minute: number, from: number, to: number): boolean {
  if (from === to) return false;
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

/** Whether quiet hours hold at `now` (on the device's clock and time zone). */
export function quietNow(q: QuietHours, now: Date): boolean {
  if (!q.on) return false;
  const from = parseHm(q.from);
  const to = parseHm(q.to);
  if (from === null || to === null) return false;
  return inQuietWindow(minuteOfDay(now), from, to);
}

/** "HH:MM" from any time-like value, else the fallback. */
const hm = (v: unknown, fallback: string) => {
  const n = parseHm(v);
  return n === null
    ? fallback
    : `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
};

/** Quiet hours from any value, each field checked; anything missing or broken is the default. */
export function cleanQuietHours(v: unknown): QuietHours {
  if (!v || typeof v !== "object") return { ...DEFAULT_QUIET_HOURS };
  const q = v as Partial<Record<keyof QuietHours, unknown>>;
  return {
    on: typeof q.on === "boolean" ? q.on : DEFAULT_QUIET_HOURS.on,
    from: hm(q.from, DEFAULT_QUIET_HOURS.from),
    to: hm(q.to, DEFAULT_QUIET_HOURS.to),
  };
}

/** The saved quiet hours (JSON, or null), as cleanQuietHours. */
export function readQuietHours(raw: string | null): QuietHours {
  if (!raw) return { ...DEFAULT_QUIET_HOURS };
  try {
    return cleanQuietHours(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_QUIET_HOURS };
  }
}

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const store = (): Store | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** This device's quiet hours. */
export function quietHours(s: Store | null = store()): QuietHours {
  let raw: string | null = null;
  try {
    raw = s?.getItem(QUIET_HOURS_KEY) ?? null;
  } catch {}
  return readQuietHours(raw);
}

/**
 * Save this device's quiet hours: the fields given replace the saved ones,
 * times normalised to "HH:MM". Tells this tab's listeners (QUIET_HOURS_EVENT).
 */
export function setQuietHours(q: Partial<QuietHours>, s: Store | null = store()): QuietHours {
  const clean = cleanQuietHours({ ...quietHours(s), ...q });
  try {
    s?.setItem(QUIET_HOURS_KEY, JSON.stringify(clean));
  } catch {}
  try {
    globalThis.dispatchEvent?.(new Event(QUIET_HOURS_EVENT));
  } catch {}
  return clean;
}

/** What a line says about being read aloud (ChatMessage's `quiet` and `loud`). */
export type SpeakMeta = { quiet?: unknown; loud?: unknown };

/** Loud: `say --loud`. Only boolean true counts. */
export const isLoud = (m: SpeakMeta) => m.loud === true;
/** Quiet: `say --quiet`, unless it is loud too. */
export const isQuiet = (m: SpeakMeta) => m.quiet === true && !isLoud(m);

/** Why a line is not read aloud; null = read it (by the usual rules). */
export type Silence = "hidden" | "quiet" | "quiet-hours";

/** The rules in order: hidden, then loud (read), then quiet, then quiet hours. */
export function silenceFor(
  m: SpeakMeta,
  at: { now: Date; hidden: boolean; hours: QuietHours },
): Silence | null {
  if (at.hidden) return "hidden";
  if (isLoud(m)) return null;
  if (isQuiet(m)) return "quiet";
  if (quietNow(at.hours, at.now)) return "quiet-hours";
  return null;
}

/** The page is hidden or the screen is locked (true without a document: never speak there). */
export const pageHidden = () =>
  typeof document === "undefined" || document.visibilityState === "hidden";
