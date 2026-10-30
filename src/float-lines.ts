/**
 * The minimized chat's floating lines: a message that arrives while the chat is
 * minimized floats above the bar for as long as it takes to read it twice,
 * then fades. Hovering or touching the lines pauses their timers.
 */

/** Characters per second read in CJK scripts (Han, kana, Hangul). */
export const READ_RATE_CJK = 6;
/** Characters per second for everything else (~180 words per minute). */
export const READ_RATE_LATIN = 15;
/** A line stays up for this many reading times... */
export const DWELL_FACTOR = 2;
/** ...and never less than this. */
export const DWELL_MIN_MS = 2_500;
/** The slow fade-out once the dwell is over (gone at once under reduced motion). */
export const FADE_MS = 10_000;
/** At most this many lines float at once; the oldest goes first. */
export const FLOAT_MAX = 6;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Seconds to read `text` once: CJK characters at 6/s, the rest at 15/s. */
export function readTime(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text.trim()) {
    if (CJK.test(ch)) cjk++;
    else other++;
  }
  return cjk / READ_RATE_CJK + other / READ_RATE_LATIN;
}

/** How long a floating line stays before it fades, in ms. */
export function dwellMs(text: string): number {
  return Math.max(DWELL_MIN_MS, Math.round(readTime(text) * 1000 * DWELL_FACTOR));
}

/**
 * One line's countdown: a single setTimeout, stopped by `pause` and restarted
 * by `resume` with the time that was left. Clock and timers are injected for
 * tests.
 */
export function createDwellTimer(d: {
  ms: number;
  onDone: () => void;
  now?: () => number;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}) {
  const now = d.now ?? (() => Date.now());
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let left = d.ms;
  let started = now();
  let timer: unknown = null;
  let done = false;
  const start = () => {
    started = now();
    timer = setTimer(() => {
      timer = null;
      done = true;
      d.onDone();
    }, left);
  };
  start();
  return {
    pause() {
      if (timer === null || done) return;
      clearTimer(timer);
      timer = null;
      left = Math.max(0, left - (now() - started));
    },
    resume() {
      if (timer !== null || done) return;
      start();
    },
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      done = true;
    },
    /** The time left, in ms (frozen while paused). */
    remaining: () => (timer === null ? left : Math.max(0, left - (now() - started))),
  };
}

/** The latest message floats on minimize only if it arrived at most this long ago. */
export const MINIMIZE_FLOAT_MAX_AGE_MS = 10 * 60_000;

/**
 * When this widget first saw each message, by id — this device's clock, never
 * the message's own `at` (another clock, which may be skewed). New messages
 * are told by id, not by the list's length: the host caps its history, so
 * once full the list stays the same length as new lines push old ones out.
 */
export function createArrivals() {
  const seen = new Map<string, number>();
  /** Arrival order, by id: 1, 2, 3… (never a clock, so never a tie). */
  const order = new Map<string, number>();
  let count = 0;
  let loaded = false;
  return {
    /**
     * The messages not seen before, in order. The first non-empty list is the
     * history: it is recorded, but `history` says not to float it.
     */
    see<M extends { id: string }>(messages: M[], now: number): { fresh: M[]; history: boolean } {
      const fresh = messages.filter((m) => !seen.has(m.id));
      for (const m of fresh) {
        seen.set(m.id, now);
        order.set(m.id, ++count);
      }
      const history = !loaded;
      if (messages.length) loaded = true;
      // Forget ids long gone from the list, so the map stays small.
      if (seen.size > 2 * messages.length + 100) {
        const ids = new Set(messages.map((m) => m.id));
        for (const id of seen.keys())
          if (!ids.has(id)) {
            seen.delete(id);
            order.delete(id);
          }
      }
      return { fresh, history };
    },
    /** When it was first seen here (undefined: never). */
    at: (id: string) => seen.get(id),
    /** Its place in arrival order (undefined: never seen). */
    seqOf: (id: string) => order.get(id),
    /** The last place handed out: everything up to here has arrived. */
    seq: () => count,
  };
}

/**
 * The minimized bar's unread badge: the agent's messages that arrived after
 * `readSeq` (the arrival order when the chat was last open, or the history
 * loaded). By arrival, not by list position: a capped list keeps its length.
 */
export function countUnread<M extends { id: string; from: string }>(
  messages: M[],
  seqOf: (id: string) => number | undefined,
  readSeq: number,
): number {
  return messages.filter((m) => m.from === "agent" && (seqOf(m.id) ?? 0) > readSeq).length;
}

/**
 * At the moment the chat is minimized, the latest message (from anyone) is
 * treated as unread and floats, unless it arrived here more than
 * MINIMIZE_FLOAT_MAX_AGE_MS ago. Its dwell starts then, not when it arrived.
 */
export function minimizeFloat<M extends { id: string }>(
  messages: M[],
  now: number,
  arrivedAt: (id: string) => number | undefined,
): M | null {
  const last = messages.at(-1);
  if (!last) return null;
  const at = arrivedAt(last.id);
  return at !== undefined && now - at <= MINIMIZE_FLOAT_MAX_AGE_MS ? last : null;
}

/**
 * A floating line's life: "dwell" (fully visible) → "fade" (FADE_MS of
 * opacity going down) → "gone". Paused (hovered, touched, a scrub) during the
 * dwell, its time is frozen; paused during the fade, it is "held" at full
 * opacity, and the fade starts over from full once released. Under reduced
 * motion the dwell's end is the end. Timers are injected for tests.
 */
export type FloatPhase = "dwell" | "fade" | "held" | "gone";
export function createFloatLife(d: {
  ms: number;
  fadeMs?: number;
  reducedMotion?: boolean;
  paused?: boolean;
  onPhase: (p: FloatPhase) => void;
  now?: () => number;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}) {
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let phase: FloatPhase = "dwell";
  let paused = false;
  let fade: unknown = null;
  const set = (p: FloatPhase) => {
    phase = p;
    d.onPhase(p);
  };
  const startFade = () => {
    set("fade");
    fade = setTimer(() => {
      fade = null;
      set("gone");
    }, d.fadeMs ?? FADE_MS);
  };
  const dwell = createDwellTimer({
    ms: d.ms,
    onDone: () => (d.reducedMotion ? set("gone") : startFade()),
    now: d.now,
    setTimer,
    clearTimer,
  });
  const life = {
    pause() {
      if (paused) return;
      paused = true;
      if (phase === "dwell") dwell.pause();
      else if (phase === "fade") {
        clearTimer(fade);
        fade = null;
        set("held");
      }
    },
    resume() {
      if (!paused) return;
      paused = false;
      if (phase === "dwell") dwell.resume();
      else if (phase === "held") startFade();
    },
    cancel() {
      dwell.cancel();
      if (fade !== null) clearTimer(fade);
      fade = null;
    },
    phase: () => phase,
  };
  if (d.paused) life.pause();
  return life;
}
