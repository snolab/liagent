/**
 * The mic as one page-wide session, outside any element: the stream, the VAD
 * (createMic, src/mic.ts), the transcripts on their way, and the hooks of a
 * voice output (MicVoiceLink). It lives on globalThis (MIC_SESSION_KEY), so
 * a remounted `<liagent-mic>`, a framework re-render, a client-side route
 * change or a second copy of the module finds it still listening and
 * re-attaches; disconnecting never stops it — only an explicit "mic off"
 * does. One getUserMedia per capture: a live stream is reused.
 *
 * On a real reload the session is new. If this tab had the mic on
 * (sessionStorage MIC_ON_KEY, per tab, surviving a refresh), it tries to
 * resume at once: with the microphone permission granted (or the query not
 * supported, as on iOS) and the AudioContext running, it turns capture back
 * on without a gesture ({path: "auto", ok: true}). Otherwise the button
 * waits in a "tap to resume" state ({path: "tap", reason}). Either outcome
 * goes to `onResume` and to the view's `resumed`.
 *
 * Everything that touches the browser is injected (MicDeps), so this is
 * tested with fakes (test/mic-session.test.ts).
 */
import { type MicState, type UploadInfo, type Vad, type VadEvents, createMic } from "./mic.ts";

/** globalThis key of the session. */
export const MIC_SESSION_KEY = "__liagentMic";
/** Bumped when the session's shape changes; an older one is migrated, its stream kept. */
export const MIC_SESSION_V = 1;
/** sessionStorage: "1" while this tab has the mic on (cleared by an explicit off). */
export const MIC_ON_KEY = "liagent:mic";

/** The slice of a MediaStream the session uses. */
export type StreamLike = {
  id: string;
  getTracks(): { readyState: string; stop(): void }[];
};

/** How a reload with the mic on went: resumed by itself, or waiting for a tap (and why). */
export type ResumeOutcome =
  | { path: "auto"; ok: true; permission: string }
  | { path: "tap"; reason: string };

/** What the mic needs to know of the agent's voice. */
export type VoiceLinkState = {
  /** A reply is being read (or just was: the tail). */
  speaking: boolean;
  /** Capture is held while it is (echo cancellation off). */
  hold: boolean;
};

/**
 * A voice output the mic works with (hands-free): told when the mic is on and
 * when the user starts and stops talking, it ducks, pauses and resumes the
 * reading; it says when capture must be held, and which transcripts were its
 * own echo. liagent/voice's session is one; anything with this shape works.
 */
export interface MicVoiceLink {
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
  echoCheck?(text: string, durationMs: number): { drop: boolean };
  /** A transcript was dropped as echo. */
  echoDropped?(): void;
  /** Called in the tap that turns the mic on (a gesture: iOS lets audio play later). */
  unlock?(): void;
  /** An interruption is over (a spoken line was sent, the input lost focus): read on. */
  resume?(): void;
}

export type MicView = {
  state: MicState;
  /** Transcripts still out, and the dimmed partial text. */
  pending: number;
  interim: string;
  /** The last error, for the button's note (cleared on the next tap). */
  error: unknown;
  /** Reloaded with the mic on, but it could not resume by itself: one tap does. */
  resume: boolean;
  /** The agent is speaking (from the voice link). */
  speaking: boolean;
  /** How the last reload's resume went (once one was tried). */
  resumed?: ResumeOutcome;
};

/** One final utterance, for a host that keeps or inspects them (opt-in). */
export type Utterance = UploadInfo & {
  wav: Uint8Array;
  text: string;
  /** The voice link's echo check, when there is one. */
  echo?: { drop: boolean };
};

/**
 * The browser side. `C` is the element's configuration (the STT endpoint, the
 * VAD source…), handed to every call so a session made by one element follows
 * the configuration of the element attached now.
 */
export type MicDeps<C = unknown> = {
  /** getUserMedia with the session's constraints. */
  getStream: (cfg: C | undefined) => Promise<StreamLike>;
  /** The VAD on a stream (Silero), and the fallback (an energy gate). Neither stops the stream. */
  load: (ev: VadEvents, stream: StreamLike, cfg: C | undefined) => Promise<Vad>;
  fallback?: (ev: VadEvents, stream: StreamLike, cfg: C | undefined) => Promise<Vad>;
  /** Transcribe one recording (the host's STT endpoint). */
  upload: (wav: Uint8Array, info: UploadInfo, cfg: C | undefined) => Promise<string>;
  onState?: (s: MicState, prev: MicState) => void;
  /** Each final utterance, after its echo check. */
  onUtterance?: (u: Utterance, cfg: C | undefined) => void;
  /** A reload's resume attempt, once it is decided. */
  onResume?: (r: ResumeOutcome) => void;
  /** sessionStorage, guarded (iOS private mode throws). */
  storage?: {
    get(k: string): string | null;
    set(k: string, v: string): void;
    remove(k: string): void;
  };
  /** The sessionStorage key (MIC_ON_KEY). */
  storageKey?: string;
  /** navigator.permissions' microphone state, or "unknown" where it can't be asked. */
  permission?: () => Promise<"granted" | "denied" | "prompt" | "unknown">;
  /** Try to get the AudioContext running without a gesture; false if it stays suspended. */
  resumeAudio?: () => Promise<boolean>;
};

type Listener = (v: MicView) => void;
/** Where transcripts go: the attached element. */
export type MicSink = {
  onText: (t: string) => void;
  onPending: (n: number, interim: string) => void;
};

export type MicSession<C = unknown> = ReturnType<typeof createMicSession<C>>;

const live = (s: StreamLike | null) =>
  !!s && s.getTracks().length > 0 && s.getTracks().every((t) => t.readyState === "live");

export function createMicSession<C = unknown>(
  deps: MicDeps<C>,
  from?: { stream: StreamLike | null; on: boolean },
) {
  const key = deps.storageKey ?? MIC_ON_KEY;
  let stream: StreamLike | null = from?.stream ?? null;
  let view: MicView = {
    state: "off",
    pending: 0,
    interim: "",
    error: null,
    resume: false,
    speaking: false,
  };
  let cfg: C | undefined;
  let voice: MicVoiceLink | null = null;
  let unvoice: (() => void) | null = null;
  const listeners = new Set<Listener>();
  let sink: MicSink | null = null;
  /** Transcripts that landed while nothing was attached (mid-remount): handed over on attach. */
  let held: string[] = [];
  let gumCalls = 0;
  const emit = (patch: Partial<MicView>) => {
    view = { ...view, ...patch };
    for (const f of listeners) f(view);
  };
  const store = {
    on: () => {
      try {
        deps.storage?.set(key, "1");
      } catch {}
    },
    clear: () => {
      try {
        deps.storage?.remove(key);
      } catch {}
    },
    get: () => {
      try {
        return deps.storage?.get(key) === "1";
      } catch {
        return false;
      }
    },
  };
  /** The live stream, or a new one (the only getUserMedia). */
  const ensureStream = async () => {
    if (stream && live(stream)) return stream;
    gumCalls++;
    stream = await deps.getStream(cfg);
    return stream;
  };
  const stopStream = () => {
    for (const t of stream?.getTracks() ?? []) t.stop();
    stream = null;
  };
  const fallback = deps.fallback;
  let prev: MicState = "off";
  const mic = createMic({
    load: async (ev) => deps.load(ev, await ensureStream(), cfg),
    fallback: fallback ? async (ev) => fallback(ev, await ensureStream(), cfg) : undefined,
    upload: async (wav, info) => {
      const text = await deps.upload(wav, info, cfg);
      // The text guard: the agent's own words that leaked past the echo canceller are dropped.
      const echo = text && voice?.echoCheck ? voice.echoCheck(text, info.durationMs) : undefined;
      if (!info.partial) deps.onUtterance?.({ ...info, wav, text, echo }, cfg);
      if (echo?.drop) {
        if (!info.partial) voice?.echoDropped?.();
        return "";
      }
      return text;
    },
    onState: (s) => {
      const was = prev;
      prev = s;
      emit({ state: s, ...(s !== "off" ? { resume: false } : {}) });
      if (voice) {
        voice.setMic(s !== "off");
        // The user starts talking: over the agent it ducks (a barge-in if they
        // keep going), else the reading pauses; it reads on once they are done.
        if (s === "capturing") voice.userSpeech();
        else if (was === "capturing") voice.userIdle();
      }
      deps.onState?.(s, was);
    },
    onText: (t) => (sink ? sink.onText(t) : void held.push(t)),
    onPending: (n, interim) => {
      emit({ pending: n, interim });
      sink?.onPending(n, interim);
    },
    onError: (e) => emit({ error: e }),
    onProb: (p) => voice?.userFrame?.(p),
  });

  const session = {
    v: MIC_SESSION_V,
    view: () => view,
    stream: () => stream,
    /** How many times this session asked for the microphone. */
    gumCalls: () => gumCalls,
    subscribe(f: Listener) {
      listeners.add(f);
      f(view);
      return () => void listeners.delete(f);
    },
    /** The connected element takes the transcripts; detaching never stops the mic. */
    attach(s: MicSink) {
      sink = s;
      const t = held;
      held = [];
      for (const x of t) s.onText(x);
      s.onPending(view.pending, view.interim);
      return () => {
        if (sink === s) sink = null;
      };
    },
    configure(c: C) {
      cfg = c;
    },
    config: () => cfg,
    /** The voice output to work with (null: none). Its hold state holds capture. */
    setVoice(link: MicVoiceLink | null) {
      if (link === voice) return;
      unvoice?.();
      unvoice = null;
      voice = link;
      if (!link) {
        mic.hold(false);
        emit({ speaking: false });
        return;
      }
      const follow = (s: VoiceLinkState) => {
        mic.hold(s.hold);
        if (s.speaking !== view.speaking) emit({ speaking: s.speaking });
      };
      follow(link.state());
      unvoice = link.subscribe(follow);
      if (mic.state() !== "off") link.setMic(true);
    },
    voice: () => voice,
    /** A tap: on (remembered for a reload), or an explicit off. */
    async toggle() {
      emit({ error: null });
      if (mic.state() === "off") {
        store.on();
        await mic.toggle();
      } else await session.off();
    },
    /** The explicit off: the VAD, the stream and the reload flag all go. */
    async off() {
      store.clear();
      emit({ resume: false });
      await mic.off();
      stopStream();
    },
    hold: (on: boolean) => mic.hold(on),
    /**
     * Replaced by a newer session: the VAD goes, the stream stays (the new
     * session builds its VAD on it).
     */
    async retire() {
      unvoice?.();
      unvoice = null;
      voice = null;
      listeners.clear();
      sink = null;
      const s = stream;
      stream = null; // so the off below can't stop it
      await mic.off();
      return s;
    },
    /** After a reload with the mic on: resume without a gesture if we may, else wait for a tap. */
    async autoResume() {
      if (!store.get()) return;
      const done = (r: ResumeOutcome) => {
        emit({ resumed: r, ...(r.path === "tap" ? { resume: true } : {}) });
        deps.onResume?.(r);
      };
      const tap = (reason: string) => done({ path: "tap", reason });
      let perm: string = "unknown";
      try {
        perm = (await deps.permission?.()) ?? "unknown";
      } catch {}
      if (perm !== "granted" && perm !== "unknown") return tap(`permission ${perm}`);
      let audio = true;
      try {
        audio = (await deps.resumeAudio?.()) ?? true;
      } catch {
        audio = false;
      }
      if (!audio) return tap("audio context suspended");
      await mic.toggle();
      if (mic.state() === "off") {
        const e = view.error as { name?: string; message?: string } | null;
        return tap(e?.name || e?.message || "capture did not start");
      }
      done({ path: "auto", ok: true, permission: perm });
    },
  };
  if (from?.on) void mic.toggle();
  return session;
}

/**
 * The page's mic session, made once: an element that connects later (a
 * remount, another copy of the module) gets the same one. An older version
 * is retired and its stream handed to the new session, which resumes
 * listening if it was.
 */
export function micSession<C = unknown>(deps: MicDeps<C>): MicSession<C> {
  const g = globalThis as unknown as Record<string, MicSession<C> | undefined>;
  const have = g[MIC_SESSION_KEY];
  if (have && have.v === MIC_SESSION_V) return have;
  if (have) {
    // Migrate: the old VAD goes, its stream stays and the new one listens on it.
    const on = (have.view?.().state ?? "off") !== "off";
    const kept = have.stream?.() ?? null;
    void have.retire?.();
    const next = createMicSession(deps, { stream: kept, on });
    g[MIC_SESSION_KEY] = next;
    return next;
  }
  const s = createMicSession(deps);
  g[MIC_SESSION_KEY] = s;
  // A fresh page: if this tab had the mic on, try to pick it up again.
  queueMicrotask(() => void s.autoResume());
  return s;
}
