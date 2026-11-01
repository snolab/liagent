import { i as EchoScore } from "./echo-BZILwDCE.js";

//#region src/voice-out.d.ts
declare const VOICE_OUT_KEY = "liagent:voice-out";
declare const VOICE_AEC_KEY = "liagent:voice-aec";
type OutMode = "speech" | "cloud";
/** A clip resumed after an interruption starts this much before where it stopped. */
declare const RESUME_REWIND_S = 0.3;
/** The output asked for on this device: "cloud" only when set so. */
declare const outMode: () => OutMode;
/** Echo-cancelled barge-in (default on; "0" = capture held while the agent speaks). */
declare const aecOn: () => boolean;
/** The slice of an HTMLAudioElement the cloud output uses. */
type ElementLike = {
  src: string;
  currentTime: number;
  volume: number;
  preload: string;
  paused: boolean; /** The reading speed; load() resets it to defaultPlaybackRate, so both are set. */
  playbackRate?: number;
  defaultPlaybackRate?: number; /** Keep the voice's pitch at any speed (and Safari's prefixed name). */
  preservesPitch?: boolean;
  webkitPreservesPitch?: boolean;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  onloadedmetadata: (() => void) | null;
  play(): Promise<void>;
  pause(): void;
  load(): void;
};
type GainLike = {
  gain: {
    value: number;
    cancelScheduledValues(t: number): unknown;
    setValueAtTime(v: number, t: number): unknown;
    linearRampToValueAtTime(v: number, t: number): unknown;
  };
  connect(n: unknown): unknown;
};
type CtxLike = {
  currentTime: number;
  destination: unknown;
  state?: string;
  resume?(): Promise<void>;
  createGain(): GainLike;
  createMediaElementSource(el: unknown): {
    connect(n: unknown): unknown;
  };
};
type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  headers: {
    get(k: string): string | null;
  };
  blob(): Promise<Blob>;
}>;
/** The URL of one sentence's audio, from its text and language (e.g. "ja-JP"). */
type TtsUrl = (text: string, lang: string) => string;
/**
 * The host's TTS endpoint: a function building each sentence's URL, or a
 * base URL that gets `lang` (the base language, "ja") and `text` added to its
 * query: GET <base>?lang=ja&text=… answering audio (audio/mpeg, audio/wav…).
 */
type TtsSource = string | TtsUrl;
/** A base URL as a TtsUrl: `?lang=<base language>&text=<text>` added to its query. */
declare function ttsUrlFrom(src: TtsSource): TtsUrl;
/** What the endpoint can voice: languages (base codes; none = any) and a text length cap. */
type TtsLimits = {
  langs?: ReadonlySet<string> | readonly string[];
  maxText?: number;
};
/** Why a sentence cannot be fetched at all (null: try the endpoint). */
declare function cloudSkip(text: string, lang: string, lim?: TtsLimits): string | null;
/**
 * Cloud replies: one `<audio>` element for the whole page (unlocked once in
 * a gesture, so iOS lets later sentences play), routed through the
 * AudioContext and one GainNode. A sentence that cannot be fetched or played
 * calls `onfail` (the session reads it with speechSynthesis instead).
 */
declare function createCloudOut(d: {
  /** Each sentence's URL; read for every fetch, so it may change. */url: () => TtsUrl | null;
  fetch: FetchLike;
  element: () => ElementLike;
  ctx: () => CtxLike | null;
  toUrl?: (b: Blob) => string;
  revoke?: (u: string) => void;
} & TtsLimits): CloudOut & {
  unlock(): void;
  gain(): GainLike | null;
};
/**
 * The page's cloud output (null outside a browser), on fetch, new Audio()
 * and the page's AudioContext. `tts` (and `limits`) set the endpoint; a
 * later call with another one switches to it.
 */
declare function cloudOut(tts?: TtsSource | null, limits?: TtsLimits): (CloudOut & {
  unlock(): void;
  gain(): GainLike | null;
}) | null;
/** The cloud output has an endpoint to fetch from. */
declare const cloudReady: () => boolean;
//#endregion
//#region src/voice.d.ts
/** Capture resumes this long after the last utterance ends (the room's echo; hold mode). */
declare const RESUME_TAIL_MS = 400;
/** An interruption with nothing said (or nothing more) resumes the reading after this. */
declare const IDLE_RESUME_MS = 1500;
/** While the user talks over the agent, the agent plays this loud… */
declare const DUCK_LEVEL = 0.25;
/** …reached over this long (cloud; speechSynthesis takes it from its next sentence)… */
declare const DUCK_ATTACK_MS = 80;
/** …and back to full over this long once the user stops. */
declare const DUCK_RELEASE_MS = 200;
/** The user talking over the agent this long is a barge-in: the reading pauses. */
declare const BARGE_IN_MS = 1500;
/**
 * …and only if it sounds like speech: the VAD's mean speech probability over
 * that window reaches this (above Silero's own 0.5 start threshold, since the
 * echo that leaks through tends to score lower). Weaker speech keeps the
 * agent ducked and is judged again after another BARGE_IN_MS.
 */
declare const BARGE_IN_PROB = 0.7;
/** Sentences are cut to at most this many characters (a TTS endpoint's usual limit). */
declare const CHUNK_MAX = 200;
/** localStorage: the read-aloud toggle ("0" = replies silent), the box's own key. */
declare const SPEAK_KEY = "liagent:speak";
/** globalThis key of the shared session. */
declare const VOICE_SESSION_KEY = "__liagentVoice";
/**
 * A reply as sentences: cut after 。．！？ (with any closing quotes or
 * brackets), after . ! ? followed by a space or the end (so 3.14 and e.g.
 * mid-word stay whole), and at every newline. Blank pieces are dropped.
 */
declare function sentences(text: string): string[];
/** A sentence in pieces of at most `max` chars: after the last clause mark, else a space, else hard. */
declare function chunk(s: string, max?: number): string[];
/** A barge-in, by the VAD's speech probabilities over the window (none known, as with the energy VAD: yes). */
declare function isBargeIn(probs: readonly number[], min?: number): boolean;
/**
 * How natural a voice sounds, higher is better. iOS lists its Eloquence
 * voices (Eddy, Flo, Grandma, …) and the novelty ones (Bahh, Bubbles,
 * Zarvox, …) first for most languages, and marks every voice `default`, so
 * "the first voice of the language" sounds robotic or silly there. Prefer
 * Premium/Enhanced (and Siri), then the regular named voice.
 */
declare function voiceQuality(v: {
  voiceURI?: string;
  name?: string;
}): number;
/**
 * An installed voice for `lang`: the exact locale first, then the same
 * language; among those the most natural (voiceQuality), the default first.
 */
declare function pickNaturalVoice<T extends {
  lang: string;
  default?: boolean;
  voiceURI?: string;
  name?: string;
}>(voices: readonly T[], lang: string): T | undefined;
type UtterLike = {
  text: string;
  volume?: number; /** The reading speed (speech-rate.ts). */
  rate?: number;
  onend: ((e?: unknown) => void) | null;
  onerror: ((e?: unknown) => void) | null;
  onboundary: ((e: {
    charIndex: number;
    name?: string;
  }) => void) | null;
};
type SynthLike = {
  speak(u: UtterLike): void;
  cancel(): void;
};
/** One sentence playing, on either route. */
type Playback = {
  route: "audio" | "speech"; /** Stop now; the place to resume from (seconds into the clip). */
  stop(): {
    at?: number;
  }; /** Ramp the volume (audio route; speechSynthesis cannot change mid-utterance). */
  volume(level: number, ms: number): void;
};
type PlayEvents = {
  onend(): void;
  onerror(): void; /** The cloud could not voice it (fetch, language, length, play refused): read it with speech. */
  onfail?(reason: string): void;
};
/** The cloud output (voice-out.ts createCloudOut). */
type CloudOut = {
  prepare?(text: string, lang: string): void;
  play(s: {
    text: string;
    lang: string;
    at: number;
    volume: number;
    rate?: number;
  }, ev: PlayEvents): Playback;
};
type VoiceState = {
  /** The mic is on (listening, loading or capturing). */mic: boolean; /** An utterance is playing, or just ended (the tail). */
  speaking: boolean; /** The mic holds its capture: speaking, with echo cancellation off. */
  hold: boolean; /** The agent is ducked under the user's voice. */
  ducked: boolean; /** Sentences still to read, the current one included. */
  queued: number; /** The reading waits for an interruption to end. */
  paused: boolean;
};
/** An interruption: the user talking, a tap on the mic, or typing. */
type Why = "speech" | "tap" | "typing";
/** What the echo check says about one transcript. */
type EchoCheck = EchoScore & {
  /** The agent was audible at some point during the utterance. */during: boolean;
};
/** A debug event (voice-out, voice-duck, voice-barge-in…), for a host's log. */
type VoiceLog = (ev: Record<string, unknown>) => void;
declare function createVoice(d: {
  synth: () => SynthLike | null; /** A new utterance for `text` in `lang` (with a voice picked for it). */
  utter: (text: string, lang: string) => UtterLike; /** The read-aloud toggle. */
  enabled: () => boolean; /** Whether a reply arriving now, with the mic off, is for this page (default: yes). */
  here?: () => boolean; /** The cloud output, for `mode() === "cloud"`. */
  cloud?: () => CloudOut | null;
  mode?: () => OutMode; /** Echo-cancelled barge-in (else capture is held while the agent speaks). */
  aec?: () => boolean; /** The reading speed, read for each utterance (speech-rate.ts; 1 if absent). */
  rate?: () => number; /** A forced reading language (e.g. "ja-JP"); unset or empty: from the reply's script. */
  lang?: () => string | undefined; /** In a gesture (the mic's tap): unlock the outputs for later, as iOS needs. */
  unlock?: () => void;
  now?: () => number;
  log?: VoiceLog;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): {
  v: number;
  state: () => VoiceState;
  subscribe(f: (s: VoiceState) => void): () => undefined; /** Where the debug events go. */
  setLog(f: VoiceLog): void;
  log: (ev: Record<string, unknown>) => void; /** The output in use: "speech" or "cloud". */
  mode: () => OutMode;
  aec: () => boolean; /** Whether a reply arriving now is read: always with the mic on, else by the toggle and here(). */
  shouldSpeak: () => boolean; /** The read-aloud toggle as it applies now (forced on while the mic is on). */
  readAloud: () => boolean; /** The mic turned on or off. Off: what the focus rule would not read stops. */
  setMic(on: boolean): void; /** A reply arrived live: queue its sentences (if it should be read). */
  reply(text: string): boolean;
  /**
   * The box's hook: read a live reply (once per message id). The same as
   * reply(), without its answer.
   */
  speak(text: string, id?: string): void;
  /**
   * The box's hook: `stop("typing")` (or "tap", "speech") pauses the
   * reading where it is, until resume(); `stop()` with no reason (or any
   * other) clears the queue ("Stop reading").
   */
  stop(why?: string): void; /** In a gesture: unlock the outputs (the mic's tap calls it). */
  unlock(): void;
  /**
   * The VAD heard the user start. Over the agent with echo cancellation on:
   * duck it, and pause the reading only if they keep going (BARGE_IN_MS).
   * Otherwise as interrupt("speech").
   */
  userSpeech(): void; /** One VAD frame's speech probability while the user is heard (judges a barge-in). */
  userFrame(prob: number): void;
  /**
   * The user cut in: `speech` (a barge-in), `tap` (the mic button while the
   * agent speaks) or `typing`. Only when there is something to interrupt.
   * Speech and taps resume after IDLE_RESUME_MS unless more happens;
   * typing waits for resume().
   */
  interrupt(why: Why): void; /** The user's utterance ended (or misfired): unduck, or read on after a short quiet. */
  userIdle(): void; /** The interruption is over (a line was sent, or the input lost focus): read on. */
  resume: () => void;
  /**
   * Was `transcript` (an utterance `durationMs` long, just ended) the agent's
   * own voice? Checked against what it said in the last ECHO_WINDOW_MS.
   */
  echoCheck(transcript: string, durationMs?: number): EchoCheck;
  /**
   * A transcript was the agent's own echo (echoCheck): a barge-in it caused
   * was no barge-in, so the reading goes on now rather than after the idle.
   */
  echoDropped(): void;
};
type Voice = ReturnType<typeof createVoice>;
/** What the box needs of a voice: read a live reply, and stop (or pause) reading. */
interface VoiceHook {
  speak(text: string, id?: string): void;
  stop(why?: string): void;
}
/** Whether agent replies are read aloud on this device (on unless turned off; the box's toggle). */
declare const speechEnabled: (key?: string) => boolean;
/** The default `here`: this tab is visible. */
declare function speakHere(): boolean;
/** The page session's settings; each may be changed by a later voice(opts). */
type VoiceOptions = {
  /** The host's TTS endpoint, for the "cloud" output (none: speech only). */tts?: TtsSource | null; /** What it can voice: languages (base codes) and a length cap. */
  ttsLimits?: TtsLimits; /** The output (default: `liagent:voice-out`, "cloud" only with a tts endpoint). */
  mode?: () => OutMode; /** The read-aloud toggle (default: `liagent:speak` is not "0"). */
  enabled?: () => boolean; /** Whether a reply is for this page while the mic is off (default: the tab is visible). */
  here?: () => boolean; /** Echo-cancelled barge-in (default: `liagent:voice-aec` is not "0"). */
  aec?: () => boolean; /** The reading speed (default: `liagent:speech-rate`). */
  rate?: () => number; /** The reading language, e.g. "ja-JP" (default: from each reply's script). */
  lang?: string;
  /**
   * Voice names to try first, best first, among the voices of the reply's
   * language: an exact `name`, else a substring of one (default: the most
   * natural installed voice, pickNaturalVoice). Applies to speechSynthesis.
   */
  prefer?: readonly string[];
  log?: VoiceLog;
};
/** The page's voice session, shared by every copy of this module; `opts` (re)configure it. */
declare function voice(opts?: VoiceOptions): Voice & {
  configure(o: VoiceOptions): void;
};
//#endregion
export { voice as A, TtsUrl as B, chunk as C, sentences as D, pickNaturalVoice as E, GainLike as F, cloudReady as G, VOICE_OUT_KEY as H, OutMode as I, outMode as J, cloudSkip as K, RESUME_REWIND_S as L, CtxLike as M, ElementLike as N, speakHere as O, FetchLike as P, TtsLimits as R, Why as S, isBargeIn as T, aecOn as U, VOICE_AEC_KEY as V, cloudOut as W, ttsUrlFrom as Y, Voice as _, DUCK_ATTACK_MS as a, VoiceOptions as b, EchoCheck as c, Playback as d, RESUME_TAIL_MS as f, VOICE_SESSION_KEY as g, UtterLike as h, CloudOut as i, voiceQuality as j, speechEnabled as k, IDLE_RESUME_MS as l, SynthLike as m, BARGE_IN_PROB as n, DUCK_LEVEL as o, SPEAK_KEY as p, createCloudOut as q, CHUNK_MAX as r, DUCK_RELEASE_MS as s, BARGE_IN_MS as t, PlayEvents as u, VoiceHook as v, createVoice as w, VoiceState as x, VoiceLog as y, TtsSource as z };
//# sourceMappingURL=voice-J7V61A7D.d.ts.map