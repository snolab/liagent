import { C as MicState, I as UploadInfo, M as SttResult, R as Vad, S as MicErrorStrings, o as VadSource, w as MicStatus, z as VadEvents } from "./mic-audio-CxDpbJGf.js";

//#region src/mic-session.d.ts
/** globalThis key of the session. */
declare const MIC_SESSION_KEY = "__liagentMic";
/** Bumped when the session's shape changes; an older one is migrated, its stream kept. */
declare const MIC_SESSION_V = 1;
/** sessionStorage: "1" while this tab has the mic on (cleared by an explicit off). */
declare const MIC_ON_KEY = "liagent:mic";
/** The slice of a MediaStream the session uses. */
type StreamLike = {
  id: string;
  getTracks(): {
    readyState: string;
    stop(): void;
  }[];
};
/** How a reload with the mic on went: resumed by itself, or waiting for a tap (and why). */
type ResumeOutcome = {
  path: "auto";
  ok: true;
  permission: string;
} | {
  path: "tap";
  reason: string;
};
/** What the mic needs to know of the agent's voice. */
type VoiceLinkState = {
  /** A reply is being read (or just was: the tail). */speaking: boolean; /** Capture is held while it is (echo cancellation off). */
  hold: boolean;
};
/**
 * A voice output the mic works with (hands-free): told when the mic is on and
 * when the user starts and stops talking, it ducks, pauses and resumes the
 * reading; it says when capture must be held, and which transcripts were its
 * own echo. liagent/voice's session is one; anything with this shape works.
 */
interface MicVoiceLink {
  /** The mic turned on (listening, loading or capturing) or off. */
  setMic(on: boolean): void;
  /** The VAD heard the user start. */
  userSpeech(): void;
  /** The user's utterance ended (or misfired). */
  userIdle(): void;
  /** One frame's speech probability while the user is heard. */
  userFrame?(prob: number): void;
  state(): VoiceLinkState;
  subscribe(f: (s: VoiceLinkState) => void): () => void;
  /** A tap on the mic while the agent speaks. */
  interrupt?(why: "tap"): void;
  /** Was this transcript the agent's own voice? (`drop`: yes.) */
  echoCheck?(text: string, durationMs: number): {
    drop: boolean;
  };
  /** A transcript was dropped as echo. */
  echoDropped?(): void;
  /** Called in the tap that turns the mic on (a gesture: iOS lets audio play later). */
  unlock?(): void;
  /** An interruption is over (a spoken line was sent, the input lost focus): read on. */
  resume?(): void;
}
type MicView = {
  state: MicState; /** Transcripts still out, and the dimmed partial text. */
  pending: number;
  interim: string; /** The last error, for the button's note (cleared on the next tap). */
  error: unknown; /** Reloaded with the mic on, but it could not resume by itself: one tap does. */
  resume: boolean; /** The agent is speaking (from the voice link). */
  speaking: boolean; /** How the last reload's resume went (once one was tried). */
  resumed?: ResumeOutcome;
};
/** One final utterance, for a host that keeps or inspects them (opt-in). */
type Utterance = UploadInfo & {
  wav: Uint8Array;
  text: string; /** The voice link's echo check, when there is one. */
  echo?: {
    drop: boolean;
  };
};
/**
 * The browser side. `C` is the element's configuration (the STT endpoint, the
 * VAD source…), handed to every call so a session made by one element follows
 * the configuration of the element attached now.
 */
type MicDeps<C = unknown> = {
  /** getUserMedia with the session's constraints. */getStream: (cfg: C | undefined) => Promise<StreamLike>; /** The VAD on a stream (Silero), and the fallback (an energy gate). Neither stops the stream. */
  load: (ev: VadEvents, stream: StreamLike, cfg: C | undefined) => Promise<Vad>;
  fallback?: (ev: VadEvents, stream: StreamLike, cfg: C | undefined) => Promise<Vad>; /** Transcribe one recording (the host's STT endpoint). */
  upload: (wav: Uint8Array, info: UploadInfo, cfg: C | undefined) => Promise<string>;
  onState?: (s: MicState, prev: MicState) => void; /** Each final utterance, after its echo check. */
  onUtterance?: (u: Utterance, cfg: C | undefined) => void; /** A reload's resume attempt, once it is decided. */
  onResume?: (r: ResumeOutcome) => void; /** sessionStorage, guarded (iOS private mode throws). */
  storage?: {
    get(k: string): string | null;
    set(k: string, v: string): void;
    remove(k: string): void;
  }; /** The sessionStorage key (MIC_ON_KEY). */
  storageKey?: string; /** navigator.permissions' microphone state, or "unknown" where it can't be asked. */
  permission?: () => Promise<"granted" | "denied" | "prompt" | "unknown">; /** Try to get the AudioContext running without a gesture; false if it stays suspended. */
  resumeAudio?: () => Promise<boolean>;
};
type Listener = (v: MicView) => void;
/** Where transcripts go: the attached element. */
type MicSink = {
  onText: (t: string) => void;
  onPending: (n: number, interim: string) => void;
};
type MicSession<C = unknown> = ReturnType<typeof createMicSession<C>>;
declare function createMicSession<C = unknown>(deps: MicDeps<C>, from?: {
  stream: StreamLike | null;
  on: boolean;
}): {
  v: number;
  view: () => MicView;
  stream: () => StreamLike | null; /** How many times this session asked for the microphone. */
  gumCalls: () => number;
  subscribe(f: Listener): () => undefined; /** The connected element takes the transcripts; detaching never stops the mic. */
  attach(s: MicSink): () => void;
  configure(c: C): void;
  config: () => C | undefined; /** The voice output to work with (null: none). Its hold state holds capture. */
  setVoice(link: MicVoiceLink | null): void;
  voice: () => MicVoiceLink | null; /** A tap: on (remembered for a reload), or an explicit off. */
  toggle(): Promise<void>; /** The explicit off: the VAD, the stream and the reload flag all go. */
  off(): Promise<void>;
  hold: (on: boolean) => void;
  /**
   * Replaced by a newer session: the VAD goes, the stream stays (the new
   * session builds its VAD on it).
   */
  retire(): Promise<StreamLike | null>; /** After a reload with the mic on: resume without a gesture if we may, else wait for a tap. */
  autoResume(): Promise<void>;
};
/**
 * The page's mic session, made once: an element that connects later (a
 * remount, another copy of the module) gets the same one. An older version
 * is retired and its stream handed to the new session, which resumes
 * listening if it was.
 */
declare function micSession<C = unknown>(deps: MicDeps<C>): MicSession<C>;
//#endregion
//#region src/mic-button.d.ts
/**
 * What the mic types into: `<liagent-chat>` has this shape, and so can any
 * host's own input. The mic reads `draft`, writes the dictated draft with
 * `setDraft(next, { source: "stt" })`, shows partial transcripts with
 * `setPartial(text)` (null: none left), sends with `submit()` when a spoken
 * sentence is complete (false: it did not go out), and sets `micActive` while
 * it listens (a box should not send by its typing debounce meanwhile).
 */
interface DictationTarget {
  readonly draft: string;
  setDraft(next: string, opts?: {
    source?: "stt";
  }): void;
  setPartial(text: string | null): void;
  submit(): boolean | void;
  micActive: boolean;
}
/** Is `x` something the mic can type into? */
declare const isDictationTarget: (x: unknown) => x is DictationTarget;
/**
 * One final transcript into the target: appended to its draft, punctuated,
 * and sent at once when it ends a sentence with words in it. True if it went
 * out.
 */
declare function dictate(box: DictationTarget, text: string): boolean;
/** The STT call the element makes: the host's own, or a POST to `stt-url`. */
type SttHandler = (wav: Uint8Array, info: UploadInfo) => Promise<SttResult | string>;
/** What the element hands the page's session (src/mic-session.ts). */
type MicConfig = {
  stt?: SttHandler;
  vad?: VadSource;
  aec: boolean;
  onUtterance?: (u: Utterance) => void;
};
type MicStrings = MicErrorStrings & {
  dictate: string;
  resume: string;
  speaking: string;
  recording: string;
  listening: string;
  rec: string;
  noStt: string;
};
declare const MIC_STRINGS_EN: MicStrings;
/** The button's label for a view. */
declare function micLabel(v: Pick<MicView, "state" | "resume">, status: MicStatus, t?: MicStrings): string;
declare const Base: typeof HTMLElement;
/** The mic button. See the header for its attributes, properties and events. */
declare class MicElement extends Base {
  static observedAttributes: string[];
  /** The host's own STT call (else a POST to stt-url). */
  stt?: SttHandler;
  sttHeaders?: Record<string, string>;
  sttCredentials?: RequestCredentials;
  /** Silero VAD's source (else vad-src/ort-src; else the energy gate). */
  vad?: VadSource;
  strings: Partial<MicStrings>;
  private _box;
  private _voice;
  private _session?;
  private shadow?;
  private btn?;
  private path?;
  private recEl?;
  private noteEl?;
  private off;
  private last;
  private lastResume?;
  get sttUrl(): string;
  set sttUrl(v: string);
  get lang(): string;
  set lang(v: string);
  get storageKey(): string;
  set storageKey(v: string);
  /** Echo-cancelled barge-in (default: on unless localStorage `liagent:voice-aec` is "0"; `aec="off"` turns it off). */
  get aec(): boolean;
  set aec(v: boolean);
  /** A soft tick when a spoken sentence is sent. */
  get tick(): boolean;
  set tick(v: boolean);
  /** The target; null: the closest <liagent-chat>. */
  get box(): DictationTarget | null;
  set box(v: DictationTarget | null);
  /** The voice output for hands-free replies (undefined: leave the session's as it is). */
  get voice(): MicVoiceLink | null;
  set voice(v: MicVoiceLink | null);
  /** The page's mic session (undefined until connected where the browser can capture). */
  get session(): MicSession<MicConfig> | undefined;
  private get t();
  private config;
  attributeChangedCallback(): void;
  connectedCallback(): void;
  disconnectedCallback(): void;
  /** Turn listening on or off, as a tap does (call it in a gesture). */
  toggle(): void;
  private fire;
  private onText;
  /** The soft tick, on the mic's AudioContext; never while the agent speaks. */
  private playTick;
  private syncActive;
  private build;
  private render;
}
/** Register the element (once) under `tag`. Returns the class. */
declare function defineMic(tag?: string): typeof MicElement;
//#endregion
export { createMicSession as C, VoiceLinkState as S, MicView as _, MicStrings as a, StreamLike as b, dictate as c, MIC_ON_KEY as d, MIC_SESSION_KEY as f, MicSink as g, MicSession as h, MicElement as i, isDictationTarget as l, MicDeps as m, MIC_STRINGS_EN as n, SttHandler as o, MIC_SESSION_V as p, MicConfig as r, defineMic as s, DictationTarget as t, micLabel as u, MicVoiceLink as v, micSession as w, Utterance as x, ResumeOutcome as y };
//# sourceMappingURL=mic-button-DwmBe1nt.d.ts.map