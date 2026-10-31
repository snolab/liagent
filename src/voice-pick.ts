/**
 * Which installed voice reads a reply: the host's preference first, then the
 * automatic pick.
 *
 *   voice({ lang: "ja-JP", prefer: ["Google 日本語", "Microsoft Nanami", "Kyoko"] })
 *   box.voicePrefer = { prefer: ["Samantha"] };   // the box's own speechSynthesis path
 *
 * - `lang` forces the reading language (else it comes from the script, pickLang).
 * - `prefer` lists voice names, in order, tried among the voices of that
 *   language (same base language: "ja-JP" takes any "ja-*"): an exact
 *   `name` first, for each entry in order, then a case-insensitive
 *   substring. None installed: the automatic pick.
 * - Chrome lists its voices late (getVoices() is empty at first), so the
 *   choice is kept per language only until `voiceschanged`, then made again.
 */
import { pickVoice } from "./protocol.ts";

/** What the host prefers for read-aloud. */
export type VoicePreference = {
  /** The reading language, e.g. "ja-JP" (default: from the reply's script). */
  lang?: string;
  /** Voice names, best first: an exact `name`, else a substring of one. */
  prefer?: readonly string[];
};

/** What a voice needs to have for the choice (SpeechSynthesisVoice has it all). */
export type VoiceLike = { lang: string; name?: string; default?: boolean; voiceURI?: string };

const norm = (l: string) => l.replace(/_/g, "-").toLowerCase();
const base = (l: string) => norm(l).split("-")[0];

/** The first voice `prefer` names among those of `lang`: exact names in order, then substrings. */
export function preferredVoice<V extends VoiceLike>(
  voices: readonly V[],
  lang: string,
  prefer: readonly string[] | undefined,
): V | undefined {
  const names = (prefer ?? []).filter((n) => typeof n === "string" && n.trim());
  if (!names.length) return undefined;
  const pool = voices.filter((v) => base(v.lang) === base(lang));
  for (const n of names) {
    const hit = pool.find((v) => v.name === n);
    if (hit) return hit;
  }
  for (const n of names) {
    const want = n.trim().toLowerCase();
    const hit = pool.find((v) => (v.name ?? "").toLowerCase().includes(want));
    if (hit) return hit;
  }
  return undefined;
}

/** The voice for `lang`: the preferred one if installed, else `fallback`'s pick. */
export function chooseVoice<V extends VoiceLike>(
  voices: readonly V[],
  lang: string,
  pref?: VoicePreference | null,
  fallback: (voices: readonly V[], lang: string) => V | undefined = pickVoice,
): V | undefined {
  return preferredVoice(voices, lang, pref?.prefer) ?? fallback(voices, lang);
}

/** The reading language: the preference's `lang` if set, else `guess` (from the text). */
export function readingLang(pref: VoicePreference | null | undefined, guess: () => string): string {
  const l = pref?.lang?.trim();
  return l ? l : guess();
}

/**
 * The choice, kept per language and preference until the device's voices
 * change. `watch(f)` calls f on each change (speechSynthesis `voiceschanged`)
 * and returns its unsubscribe; it is set up on the first pick.
 */
export function createVoicePicker<V extends VoiceLike>(d: {
  voices: () => readonly V[];
  watch?: (onChange: () => void) => () => void;
  fallback?: (voices: readonly V[], lang: string) => V | undefined;
}) {
  const kept = new Map<string, V | undefined>();
  let unwatch: (() => void) | undefined;
  let watching = false;
  return {
    pick(lang: string, pref?: VoicePreference | null): V | undefined {
      if (!watching && d.watch) {
        watching = true;
        unwatch = d.watch(() => kept.clear());
      }
      const key = `${norm(lang)}\n${(pref?.prefer ?? []).join("\n")}`;
      if (kept.has(key)) return kept.get(key);
      const list = d.voices();
      const v = chooseVoice(list, lang, pref, d.fallback);
      // None listed yet (Chrome loads them late): ask again next time.
      if (list.length) kept.set(key, v);
      return v;
    },
    /** Forget the choices (the preference changed). */
    reset() {
      kept.clear();
    },
    stop() {
      unwatch?.();
      unwatch = undefined;
      watching = false;
      kept.clear();
    },
  };
}

export type VoicePicker<V extends VoiceLike = VoiceLike> = ReturnType<typeof createVoicePicker<V>>;

/** speechSynthesis `voiceschanged`, for createVoicePicker's `watch` (no-op without it). */
export function watchVoices(onChange: () => void): () => void {
  const s = typeof speechSynthesis === "undefined" ? null : speechSynthesis;
  if (!s || typeof s.addEventListener !== "function") return () => {};
  s.addEventListener("voiceschanged", onChange);
  return () => s.removeEventListener("voiceschanged", onChange);
}
