//#region src/mic.d.ts
/**
 * The mic, without the browser: a listening mode in which a voice-activity
 * detector cuts speech into utterances, each one sent to the host's STT
 * endpoint as soon as it ends. Requests run in parallel; transcripts are
 * appended in the order spoken. A long utterance also sends rolling partial
 * chunks, whose text shows dimmed until the final one replaces it. Nothing is
 * sent as a chat message here: the text lands in the draft, and the rules
 * below (appendDictation) say when it goes out. The VAD, the upload and the
 * timers are injected, so all of this is tested with fakes (test/mic.test.ts);
 * src/mic-audio.ts has the browser pieces and src/mic-button.ts the element.
 */
/** Longest utterance: past this it is cut and sent, and listening goes on. */
declare const MAX_UTTERANCE_MS = 30000;
/** The VADs hand over 16 kHz mono. */
declare const RATE = 16000;
/** Partials: one every PARTIAL_EVERY_MS of speech, once it is PARTIAL_MIN_MS long… */
declare const PARTIAL_EVERY_MS = 2500;
declare const PARTIAL_MIN_MS = 3000;
/** …each chunk overlapping the one before by this much, so a word cut at its edge is heard whole. */
declare const PARTIAL_OVERLAP_MS = 1500;
/** Shown in the input for an utterance still being transcribed. */
declare const PENDING_MARK = "\u2026";
type MicState = "off" | "loading" | "listening" | "capturing";
/** What the button shows, from the state and the transcripts still out. */
type MicStatus = "idle" | "loading" | "listening" | "capturing" | "transcribing" | "speaking";
/**
 * `speaking`: the agent's reply is being read while the mic is on. Capturing
 * wins: with echo cancellation the user can talk over the agent.
 */
declare function micStatus(state: MicState, pending: number, speaking?: boolean): MicStatus;
/** What a VAD must do. `flush` ends the current utterance now (the 30 s cap). */
type Vad = {
  start(): Promise<void> | void;
  pause(): Promise<void> | void;
  flush(): Promise<void> | void;
  destroy(): Promise<void> | void;
};
type VadEvents = {
  onSpeechStart(): void; /** One utterance, 16 kHz mono samples in [-1, 1]. */
  onSpeechEnd(samples: Float32Array): void; /** Speech seemed to start but was too short to keep. */
  onMisfire(): void;
  /**
   * Every frame heard (16 kHz), for the partials; only those while capturing
   * are kept. `prob`: the VAD's speech probability for it (Silero only).
   */
  onFrame?(frame: Float32Array, prob?: number): void;
};
type VadFactory = (ev: VadEvents) => Promise<Vad>;
/** A non-2xx answer from the STT endpoint. */
declare class SttError extends Error {
  readonly status: number;
  constructor(status: number, message: string);
}
/** getUserMedia refused or found nothing: the fallback needs the mic too, so it is not tried. */
declare function isMicDenied(e: unknown): boolean;
/** The notes' wording; a host can translate it (`<liagent-mic>.strings`). */
type MicErrorStrings = {
  denied: string;
  noMic: string;
  signIn: string;
  tooMuch: string; /** `{status}` is replaced by the HTTP status. */
  failed: string; /** `{message}` is replaced by the error's message. */
  other: string;
};
declare const MIC_ERROR_STRINGS_EN: MicErrorStrings;
/** The short note by the button for an error. */
declare function micErrorNote(e: unknown, t?: Partial<MicErrorStrings>): string;
/**
 * Utterances in flight, in the order they were spoken. `take()` hands back
 * the text of every finished one that has nothing unfinished before it.
 */
declare class UtteranceQueue {
  private next;
  private head;
  private done;
  private partials;
  add(): number;
  resolve(seq: number, text: string | null): void;
  /** Interim text for one not yet resolved (ignored once it is). */
  partial(seq: number, text: string): void;
  getPartial(seq: number): string;
  /** Text now in order (failed ones are skipped), joined with joinText. */
  take(): string;
  /** Utterances still being transcribed. */
  pending(): number;
  /**
   * What the input shows, dimmed, after the draft: for each utterance not yet
   * taken, its text (done, waiting on an earlier one), its partial, or
   * PENDING_MARK (one mark for a run of them).
   */
  interim(): string;
}
/** Append `b` to `a`: a space between them, except between CJK characters or at a line start. */
declare function joinText(a: string, b: string): string;
/** A draft ending a sentence (any script's full stop, ! or ?). */
declare const ENDS_SENTENCE: RegExp;
/**
 * Spoken (or IME-dictated) sentences go out at once from this many characters
 * (trimmed): typing arrives a character at a time, so 3 at once is dictation.
 */
declare const AUTO_SEND_MIN = 3;
/**
 * Typed text that arrived at once (an outside dictation IME): AUTO_SEND_MIN
 * or more characters since the draft last settled, and the draft now ends a
 * sentence. Then it is sent at once.
 */
declare function isDictationBurst(settledLen: number, draft: string): boolean;
/**
 * Spoken text always ends a sentence ("auto-punctuate, then commit"): Whisper
 * usually adds the stop itself; when it doesn't, add one that fits the text —
 * 。/？ for CJK, ./? otherwise, a question by its particle or opening word.
 * Text that already ends in any punctuation (…, ～, quotes) is left alone.
 */
declare function punctuate(text: string): string;
/**
 * A final transcript lands in the draft, punctuated, and is committed at once
 * (shown, then sent) whenever it carries any words — a short "好" or "OK"
 * too. Partials never come here; typing never does (see isDictationBurst).
 */
declare function appendDictation(draft: string, text: string): {
  draft: string;
  send: boolean;
};
/**
 * Two overlapping chunks' transcripts as one: the longest run of words that
 * ends `a` and starts `b` is kept once ("the quick brown" + "brown fox" →
 * "the quick brown fox"). With no overlap they are just joined.
 */
declare function mergeOverlap(a: string, b: string): string;
/** Linear resampling to `to` Hz (the fallback VAD records at the device's rate). */
declare function resample(input: Float32Array, from: number, to: number): Float32Array;
/** 16-bit PCM WAV, mono: what every STT model takes, and every browser can make. */
declare function encodeWav(samples: Float32Array, rate?: number): Uint8Array;
/** The RMS level of a frame, for the energy fallback. */
declare function rms(frame: Float32Array): number;
/**
 * The energy-threshold VAD the mic falls back to when Silero is not given or
 * cannot load: feed it frames; it says when speech starts (two frames over
 * `on`) and ends (`hangMs` under `off`), keeping a frame of audio from before
 * the start.
 */
declare function energyGate(opts: {
  rate: number;
  on?: number;
  off?: number;
  hangMs?: number;
  minMs?: number;
}): {
  /** null: nothing happened; "start"; or the finished utterance (or "misfire"). */push(frame: Float32Array): null | "start" | "misfire" | Float32Array; /** End the utterance now (the cap, or listening turned off). */
  flush(): null | "misfire" | Float32Array;
};
type UploadInfo = {
  seq: number;
  durationMs: number;
  partial: boolean;
};
/**
 * Listening mode. `toggle()` turns it on (loading the VAD, or the fallback if
 * that fails, unless the mic itself was refused) and off. Each utterance is
 * encoded and uploaded at once; its transcript (in order) goes to `onText`,
 * and `onPending` counts those still out, with the interim text to show
 * dimmed. A capture longer than MAX_UTTERANCE_MS is cut and sent. A 401 turns
 * listening off; a 429 on a partial stops partials until the next turn-on.
 */
declare function createMic(d: {
  load: VadFactory;
  fallback?: VadFactory;
  upload: (wav: Uint8Array, info: UploadInfo) => Promise<string>;
  onState: (s: MicState) => void;
  onText: (text: string) => void;
  onPending: (n: number, interim: string) => void;
  onError?: (e: unknown) => void; /** Each frame's speech probability while capturing (a voice output's barge-in judge). */
  onProb?: (prob: number) => void; /** Rolling partial chunks for long utterances (on unless false). */
  partials?: boolean;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): {
  toggle: () => Promise<void>;
  hold: (on: boolean) => void;
  held: () => boolean;
  off: () => Promise<void>;
  state: () => MicState;
};
/** What the STT endpoint answers: JSON with the transcript, and anything else it likes. */
type SttResult = {
  text: string;
  model?: string;
  ms?: number;
  language?: string;
};
/** Where and how to POST an utterance (docs/embed.md, "Voice input"). */
type SttRequest = {
  /** The endpoint, absolute or relative to the page, e.g. "/api/stt". */url: string; /** A language hint, sent as `?lang=` (none: the endpoint detects it). */
  lang?: string; /** Extra request headers (an API key, a CSRF token…). */
  headers?: Record<string, string>; /** fetch's credentials mode (default "same-origin"; "include" for a cookie on another origin). */
  credentials?: RequestCredentials; /** The audio's type (default "audio/wav"). */
  type?: string;
};
/** The URL with `lang` added to its query, when a hint is given. */
declare function sttUrl(url: string, lang?: string): string;
/**
 * POST one recording to the host's STT endpoint: the raw audio as the body
 * (16 kHz mono 16-bit PCM WAV) and its type as `content-type`. Answers the
 * endpoint's JSON (`text` defaults to ""). Throws SttError on non-2xx, with
 * the JSON's `error` as its message when there is one.
 */
declare function postStt(wav: Uint8Array, req: SttRequest | string, f?: typeof fetch): Promise<SttResult>;
/** The send tick: two soft sine tones, this loud at their peak, this long in all. */
declare const TICK_GAIN = 0.08;
declare const TICK_MS = 80;
/** The slice of an AudioContext the tick uses (a fake in the tests). */
type TickContext = {
  currentTime: number;
  destination: unknown;
  createOscillator(): {
    type: string;
    frequency: {
      setValueAtTime(v: number, t: number): unknown;
    };
    connect(n: unknown): unknown;
    start(t: number): void;
    stop(t: number): void;
  };
  createGain(): {
    gain: {
      setValueAtTime(v: number, t: number): unknown;
      linearRampToValueAtTime(v: number, t: number): unknown;
      exponentialRampToValueAtTime(v: number, t: number): unknown;
    };
    connect(n: unknown): unknown;
  };
};
/**
 * A short, soft "tick" when a spoken sentence goes out (opt-in on the
 * element: the `tick` attribute): two sine tones (the second a fifth up,
 * 30 ms later) through one gain with a 5 ms attack and an exponential decay,
 * TICK_MS long, peaking at TICK_GAIN. Web Audio only — no <audio> element —
 * so iOS keeps it silent when the ringer is muted.
 */
declare function scheduleTick(ctx: TickContext, at?: number): number;
//#endregion
//#region src/mic-audio.d.ts
/** The mic with echo cancellation on (the default: the user may talk over the agent). */
declare const AEC_CONSTRAINTS: {
  readonly echoCancellation: true;
  readonly noiseSuppression: true;
  readonly autoGainControl: true;
  readonly channelCount: 1;
};
/** Echo cancellation's "off" mode: capture is held while the agent speaks; no auto gain. */
declare const LEGACY_CONSTRAINTS: {
  readonly echoCancellation: true;
  readonly noiseSuppression: true;
  readonly channelCount: 1;
};
declare const micConstraints: (aec?: boolean) => MediaTrackConstraints;
declare function noteTrack(stream: {
  getAudioTracks(): {
    getSettings?(): object;
  }[];
}): void;
declare const appliedSettings: () => Record<string, unknown> | null;
declare function audioCtx(): AudioContext | null;
/** The AudioContext if one was made (never makes one). */
declare const existingCtx: () => AudioContext | null;
/** The browser can capture: getUserMedia and Web Audio. */
declare const canCapture: () => boolean;
/** The mic stream, with the constraints for `aec`; what was applied is noted. */
declare function micStream(aec?: boolean): Promise<MediaStream>;
/** The slice of vad-web's MicVAD the mic uses. */
type MicVADLike = {
  start(): Promise<void> | void;
  pause(): Promise<void> | void;
  destroy(): Promise<void> | void;
};
/** vad-web's module (or its UMD global, `window.vad`). */
type VadWebModule = {
  MicVAD: {
    new: (o: Record<string, unknown>) => Promise<MicVADLike>;
  };
};
/** Hands over vad-web: `() => import("@ricky0123/vad-web")`, or anything resolving to its module. */
type VadLoader = () => Promise<VadWebModule | {
  default: VadWebModule;
}>;
/** Silero VAD's source: a loader and where its model and onnxruntime's wasm are served from. */
type VadConfig = {
  load: VadLoader; /** vad-web's `baseAssetPath`: the directory with silero_vad_*.onnx and the worklet. */
  baseAssetPath?: string; /** vad-web's `onnxWASMBasePath`: the directory with onnxruntime-web's .wasm files. */
  onnxWASMBasePath?: string; /** Silero's model (default "v5"). */
  model?: "v5" | "legacy"; /** More MicVAD options (thresholds, redemption frames…), passed through. */
  options?: Record<string, unknown>;
};
type VadSource = VadLoader | VadConfig;
/**
 * vad-web from its UMD builds, by <script> tags: `vadBase` is vad-web's dist
 * directory (bundle.min.js, the model, the worklet) and `ortBase`
 * onnxruntime-web's (ort.wasm.min.js and the wasm). E.g. pinned on a CDN:
 *
 *   vadFromScripts("https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/",
 *                  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/")
 *
 * The page's CSP must allow both origins (script-src, connect-src, and
 * 'wasm-unsafe-eval').
 */
declare function vadFromScripts(vadBase: string, ortBase: string): VadConfig;
/**
 * Silero on the session's stream (never stops it): ends an utterance after
 * ~0.8 s of silence; each frame's speech probability goes to onFrame.
 */
declare function sileroVad(ev: VadEvents, stream: MediaStream, src: VadSource): Promise<Vad>;
/** The fallback: an energy threshold on the raw signal (energyGate), on the session's stream. */
declare function energyVad(ev: VadEvents, stream: MediaStream): Promise<Vad>;
//#endregion
export { resample as $, SttError as A, VadFactory as B, MicState as C, PARTIAL_OVERLAP_MS as D, PARTIAL_MIN_MS as E, TickContext as F, isDictationBurst as G, createMic as H, UploadInfo as I, mergeOverlap as J, isMicDenied as K, UtteranceQueue as L, SttResult as M, TICK_GAIN as N, PENDING_MARK as O, TICK_MS as P, punctuate as Q, Vad as R, MicErrorStrings as S, PARTIAL_EVERY_MS as T, encodeWav as U, appendDictation as V, energyGate as W, micStatus as X, micErrorNote as Y, postStt as Z, vadFromScripts as _, VadLoader as a, MAX_UTTERANCE_MS as b, appliedSettings as c, energyVad as d, rms as et, existingCtx as f, sileroVad as g, noteTrack as h, VadConfig as i, SttRequest as j, RATE as k, audioCtx as l, micStream as m, LEGACY_CONSTRAINTS as n, sttUrl as nt, VadSource as o, micConstraints as p, joinText as q, MicVADLike as r, VadWebModule as s, AEC_CONSTRAINTS as t, scheduleTick as tt, canCapture as u, AUTO_SEND_MIN as v, MicStatus as w, MIC_ERROR_STRINGS_EN as x, ENDS_SENTENCE as y, VadEvents as z };
//# sourceMappingURL=mic-audio-CxDpbJGf.d.ts.map