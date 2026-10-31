//#region src/voice-pick.d.ts
/** What the host prefers for read-aloud. */
type VoicePreference = {
  /** The reading language, e.g. "ja-JP" (default: from the reply's script). */lang?: string; /** Voice names, best first: an exact `name`, else a substring of one. */
  prefer?: readonly string[];
};
/** What a voice needs to have for the choice (SpeechSynthesisVoice has it all). */
type VoiceLike = {
  lang: string;
  name?: string;
  default?: boolean;
  voiceURI?: string;
};
/** The first voice `prefer` names among those of `lang`: exact names in order, then substrings. */
declare function preferredVoice<V extends VoiceLike>(voices: readonly V[], lang: string, prefer: readonly string[] | undefined): V | undefined;
/** The voice for `lang`: the preferred one if installed, else `fallback`'s pick. */
declare function chooseVoice<V extends VoiceLike>(voices: readonly V[], lang: string, pref?: VoicePreference | null, fallback?: (voices: readonly V[], lang: string) => V | undefined): V | undefined;
/** The reading language: the preference's `lang` if set, else `guess` (from the text). */
declare function readingLang(pref: VoicePreference | null | undefined, guess: () => string): string;
/**
 * The choice, kept per language and preference until the device's voices
 * change. `watch(f)` calls f on each change (speechSynthesis `voiceschanged`)
 * and returns its unsubscribe; it is set up on the first pick.
 */
declare function createVoicePicker<V extends VoiceLike>(d: {
  voices: () => readonly V[];
  watch?: (onChange: () => void) => () => void;
  fallback?: (voices: readonly V[], lang: string) => V | undefined;
}): {
  pick(lang: string, pref?: VoicePreference | null): V | undefined; /** Forget the choices (the preference changed). */
  reset(): void;
  stop(): void;
};
type VoicePicker<V extends VoiceLike = VoiceLike> = ReturnType<typeof createVoicePicker<V>>;
/** speechSynthesis `voiceschanged`, for createVoicePicker's `watch` (no-op without it). */
declare function watchVoices(onChange: () => void): () => void;
//#endregion
export { createVoicePicker as a, watchVoices as c, chooseVoice as i, VoicePicker as n, preferredVoice as o, VoicePreference as r, readingLang as s, VoiceLike as t };
//# sourceMappingURL=voice-pick-BL3ttnwt.d.ts.map