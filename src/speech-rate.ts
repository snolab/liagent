/**
 * How fast the agent's replies are read aloud: a per-device setting
 * (localStorage `liagent:speech-rate`), picked in the chat's menu. Applied
 * from the next utterance, on both outputs (the speech utterance's rate, or a cloud
 * voice's playbackRate with the pitch kept).
 */
export const SPEECH_RATE_KEY = "liagent:speech-rate";
export const SPEECH_RATES = [1, 1.25, 1.5, 2] as const;
export const DEFAULT_SPEECH_RATE = 1.5;

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const store = (): Store | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** The saved rate, if it is one of SPEECH_RATES; else the default. */
export function speechRate(s: Store | null = store()): number {
  let raw: string | null = null;
  try {
    raw = s?.getItem(SPEECH_RATE_KEY) ?? null;
  } catch {}
  const n = Number(raw);
  return raw !== null && (SPEECH_RATES as readonly number[]).includes(n) ? n : DEFAULT_SPEECH_RATE;
}

/** Save a rate (one of SPEECH_RATES; anything else is ignored). */
export function setSpeechRate(rate: number, s: Store | null = store()): void {
  if (!(SPEECH_RATES as readonly number[]).includes(rate)) return;
  try {
    s?.setItem(SPEECH_RATE_KEY, String(rate));
  } catch {}
}
