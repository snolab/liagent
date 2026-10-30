//#region src/echo.d.ts
/**
 * The text-level echo guard: with the
 * mic left open while the agent speaks, what leaks past the browser's echo
 * canceller comes back from STT as the agent's own words. A transcript that
 * closely matches a sentence the agent spoke in the last ECHO_WINDOW_MS is
 * dropped. Pure functions, tested in test/echo-guard.test.ts.
 */
/** Dropped from this similarity (Dice over character n-grams) to one recent agent sentence. */
declare const ECHO_SIMILARITY = 0.6;
/** Agent sentences still playing, or ended at most this long before the utterance, count. */
declare const ECHO_WINDOW_MS = 10000;
/**
 * Shorter transcripts (normalized) are dropped only when they equal a whole
 * sentence: "OK" or "はい" said by the user must not vanish because the
 * agent's sentence contained it.
 */
declare const ECHO_MIN_CHARS = 4;
/** Case, width, punctuation, symbols and spaces gone: "Hello, World!" → "helloworld". */
declare function normalizeEcho(s: string): string;
/** Character n-grams with counts (the whole string when it is shorter than n). */
declare function grams(s: string, n: number): Map<string, number>;
/** Dice coefficient of two n-gram bags: 2·|A∩B| / (|A|+|B|), in [0, 1]. */
declare function dice(a: Map<string, number>, b: Map<string, number>): number;
type EchoScore = {
  /** 0 … 1: 1 for a substring, else the best Dice similarity. */score: number; /** The agent text it matched best (null when nothing did). */
  against: string | null; /** score ≥ ECHO_SIMILARITY. */
  drop: boolean;
};
/**
 * How much `transcript` looks like the agent's own speech: compared with each
 * recent sentence, and each pair of consecutive ones (a transcript can span
 * a sentence break). Bigrams for CJK, trigrams otherwise, after normalizeEcho.
 */
declare function echoScore(transcript: string, spoken: readonly string[]): EchoScore;
//#endregion
export { dice as a, normalizeEcho as c, EchoScore as i, ECHO_SIMILARITY as n, echoScore as o, ECHO_WINDOW_MS as r, grams as s, ECHO_MIN_CHARS as t };
//# sourceMappingURL=echo-W2RcMEny.d.ts.map