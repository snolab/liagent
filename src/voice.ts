/**
 * Hands-free voice out: the one place that decides when agent replies are
 * read aloud, how loud, and how the mic treats them. The page has one
 * session (`voice()`, kept on globalThis), so every copy of the module — a
 * bundled box, a hot-loaded one — reads through the same queue.
 *
 *   import { voice } from "liagent/voice";
 *   const v = voice({ tts: "/api/tts" });   // tts: only for the "cloud" output
 *   box.voice = v;                           // the box calls v.speak(text, id) / v.stop(why)
 *   mic.voice = v;                           // <liagent-mic>: ducking, barge-in, the echo guard
 *
 * - Replies go in a FIFO queue, one utterance per sentence (sentences longer
 *   than CHUNK_MAX are cut at a clause or a space); a new reply waits behind
 *   the one being read and never cuts it off.
 * - Output (src/voice-out.ts, `liagent:voice-out`): the device's
 *   speechSynthesis ("speech", the default; the most natural installed voice,
 *   voiceQuality), or "cloud": each sentence from the host's TTS endpoint,
 *   played through the page's own audio so the echo canceller hears it. A
 *   sentence the cloud cannot voice is read by speechSynthesis instead.
 * - The speed (src/speech-rate.ts, `liagent:speech-rate`) applies from the
 *   next utterance, on both outputs.
 * - Mic on: every reply is read, whatever the read-aloud toggle says (the
 *   toggle itself is never changed, so it is "restored" when the mic stops).
 *   Mic off: a reply is read only with the toggle on (`liagent:speak`, the
 *   box's) and `here()` (default: this tab is visible).
 * - Echo (`liagent:voice-aec`, default on): the mic stays open while the
 *   agent speaks — echo cancellation, then the text guard (src/echo.ts)
 *   drops what leaks through. The user speaking over the agent ducks it to
 *   DUCK_LEVEL; speech that goes on for BARGE_IN_MS (and sounds like speech:
 *   isBargeIn) is a barge-in and pauses the reading. With
 *   `liagent:voice-aec` = "0": `hold` is true while an utterance plays (and
 *   RESUME_TAIL_MS after), and the mic holds its capture.
 * - An interruption (a barge-in, a tap on the mic, typing) stops the utterance
 *   and remembers where: the clip's time (cloud), else the last word boundary
 *   the browser reported, else the start of that sentence. Speech or a tap
 *   resumes once the user's line was sent, or after IDLE_RESUME_MS of quiet;
 *   typing waits for resume() (a send, or a blur). `stop()` clears the queue.
 *
 * Everything browser-shaped is injected, so this is tested with fakes
 * (test/voice-session.test.ts). Event-driven only: utterance and clip
 * events and one-shot timers, never polling.
 */
import { ECHO_WINDOW_MS, type EchoScore, echoScore } from "./echo.ts";
import { pickLang } from "./protocol.ts";
import { speechRate } from "./speech-rate.ts";
import {
  type OutMode,
  type TtsLimits,
  type TtsSource,
  aecOn,
  cloudOut,
  cloudReady,
  outMode,
} from "./voice-out.ts";

export * from "./voice-out.ts";

/** Capture resumes this long after the last utterance ends (the room's echo; hold mode). */
export const RESUME_TAIL_MS = 400;
/** An interruption with nothing said (or nothing more) resumes the reading after this. */
export const IDLE_RESUME_MS = 1_500;
/** While the user talks over the agent, the agent plays this loud… */
export const DUCK_LEVEL = 0.25;
/** …reached over this long (cloud; speechSynthesis takes it from its next sentence)… */
export const DUCK_ATTACK_MS = 80;
/** …and back to full over this long once the user stops. */
export const DUCK_RELEASE_MS = 200;
/** The user talking over the agent this long is a barge-in: the reading pauses. */
export const BARGE_IN_MS = 1_500;
/**
 * …and only if it sounds like speech: the VAD's mean speech probability over
 * that window reaches this (above Silero's own 0.5 start threshold, since the
 * echo that leaks through tends to score lower). Weaker speech keeps the
 * agent ducked and is judged again after another BARGE_IN_MS.
 */
export const BARGE_IN_PROB = 0.7;
/** Sentences are cut to at most this many characters (a TTS endpoint's usual limit). */
export const CHUNK_MAX = 200;
/** localStorage: the read-aloud toggle ("0" = replies silent), the box's own key. */
export const SPEAK_KEY = "liagent:speak";
/** globalThis key of the shared session. */
export const VOICE_SESSION_KEY = "__liagentVoice";
/** The session's version: a copy on the page with another one is replaced. */
const V = 1;
/** Message ids already read, so a replayed message is not read twice. */
const SPOKEN_IDS = 200;

const CJK_STOP = "。．！？";
const LATIN_STOP = ".!?";
const CLOSERS = "」』）】〕〉》\"'”’)]";

/**
 * A reply as sentences: cut after 。．！？ (with any closing quotes or
 * brackets), after . ! ? followed by a space or the end (so 3.14 and e.g.
 * mid-word stay whole), and at every newline. Blank pieces are dropped.
 */
export function sentences(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  const push = () => {
    const t = cur.trim();
    if (t) out.push(t);
    cur = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (c === "\n" || c === "\r") {
      push();
      continue;
    }
    cur += c;
    const cjk = CJK_STOP.includes(c);
    if (!cjk && !LATIN_STOP.includes(c)) continue;
    while (i + 1 < text.length && (CJK_STOP + LATIN_STOP + CLOSERS).includes(text[i + 1] ?? "\n"))
      cur += text[++i];
    if (cjk || i + 1 >= text.length || /\s/.test(text[i + 1] ?? "")) push();
  }
  push();
  return out;
}

const CLAUSE = /[、，,;；:：]/;

/** A sentence in pieces of at most `max` chars: after the last clause mark, else a space, else hard. */
export function chunk(s: string, max = CHUNK_MAX): string[] {
  const out: string[] = [];
  let rest = s.trim();
  while (rest.length > max) {
    const head = rest.slice(0, max);
    let cut = -1;
    for (let i = head.length - 1; i > max / 3; i--)
      if (CLAUSE.test(head[i] ?? "")) {
        cut = i + 1;
        break;
      }
    if (cut < 0) {
      const sp = head.lastIndexOf(" ");
      cut = sp > max / 3 ? sp + 1 : max;
    }
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** A barge-in, by the VAD's speech probabilities over the window (none known, as with the energy VAD: yes). */
export function isBargeIn(probs: readonly number[], min = BARGE_IN_PROB): boolean {
  if (!probs.length) return true;
  return probs.reduce((a, b) => a + b, 0) / probs.length >= min;
}

/**
 * How natural a voice sounds, higher is better. iOS lists its Eloquence
 * voices (Eddy, Flo, Grandma, …) and the novelty ones (Bahh, Bubbles,
 * Zarvox, …) first for most languages, and marks every voice `default`, so
 * "the first voice of the language" sounds robotic or silly there. Prefer
 * Premium/Enhanced (and Siri), then the regular named voice.
 */
export function voiceQuality(v: { voiceURI?: string; name?: string }): number {
  const uri = (v.voiceURI ?? "").toLowerCase();
  if (uri.includes("eloquence") || uri.includes("speech.synthesis.voice.")) return 0;
  if (uri.includes("premium")) return 4;
  if (uri.includes("enhanced")) return 3;
  if (uri.includes("siri")) return 3;
  return 2;
}

/**
 * An installed voice for `lang`: the exact locale first, then the same
 * language; among those the most natural (voiceQuality), the default first.
 */
export function pickNaturalVoice<
  T extends { lang: string; default?: boolean; voiceURI?: string; name?: string },
>(voices: readonly T[], lang: string): T | undefined {
  const norm = (l: string) => l.replace(/_/g, "-").toLowerCase();
  const want = norm(lang);
  const base = want.split("-")[0];
  const exact = voices.filter((v) => norm(v.lang) === want);
  const same = voices.filter((v) => norm(v.lang).split("-")[0] === base);
  const pool = exact.length ? exact : same;
  const best = Math.max(-1, ...pool.map(voiceQuality));
  const top = pool.filter((v) => voiceQuality(v) === best);
  return top.find((v) => v.default) ?? top[0];
}

export type UtterLike = {
  text: string;
  volume?: number;
  /** The reading speed (speech-rate.ts). */
  rate?: number;
  onend: ((e?: unknown) => void) | null;
  onerror: ((e?: unknown) => void) | null;
  onboundary: ((e: { charIndex: number; name?: string }) => void) | null;
};
export type SynthLike = { speak(u: UtterLike): void; cancel(): void };

/** One sentence playing, on either route. */
export type Playback = {
  route: "audio" | "speech";
  /** Stop now; the place to resume from (seconds into the clip). */
  stop(): { at?: number };
  /** Ramp the volume (audio route; speechSynthesis cannot change mid-utterance). */
  volume(level: number, ms: number): void;
};
export type PlayEvents = {
  onend(): void;
  onerror(): void;
  /** The cloud could not voice it (fetch, language, length, play refused): read it with speech. */
  onfail?(reason: string): void;
};
/** The cloud output (voice-out.ts createCloudOut). */
export type CloudOut = {
  prepare?(text: string, lang: string): void;
  play(
    s: { text: string; lang: string; at: number; volume: number; rate?: number },
    ev: PlayEvents,
  ): Playback;
};

export type VoiceState = {
  /** The mic is on (listening, loading or capturing). */
  mic: boolean;
  /** An utterance is playing, or just ended (the tail). */
  speaking: boolean;
  /** The mic holds its capture: speaking, with echo cancellation off. */
  hold: boolean;
  /** The agent is ducked under the user's voice. */
  ducked: boolean;
  /** Sentences still to read, the current one included. */
  queued: number;
  /** The reading waits for an interruption to end. */
  paused: boolean;
};

/** An interruption: the user talking, a tap on the mic, or typing. */
export type Why = "speech" | "tap" | "typing";
export type { OutMode };

type Sentence = { text: string; lang: string; from: number; at: number };
/** What the agent said, and when (for the echo guard). */
type Said = { text: string; start: number; end?: number };

/** What the echo check says about one transcript. */
export type EchoCheck = EchoScore & {
  /** The agent was audible at some point during the utterance. */
  during: boolean;
};

/** A debug event (voice-out, voice-duck, voice-barge-in…), for a host's log. */
export type VoiceLog = (ev: Record<string, unknown>) => void;

const WHYS: readonly string[] = ["speech", "tap", "typing"];

export function createVoice(d: {
  synth: () => SynthLike | null;
  /** A new utterance for `text` in `lang` (with a voice picked for it). */
  utter: (text: string, lang: string) => UtterLike;
  /** The read-aloud toggle. */
  enabled: () => boolean;
  /** Whether a reply arriving now, with the mic off, is for this page (default: yes). */
  here?: () => boolean;
  /** The cloud output, for `mode() === "cloud"`. */
  cloud?: () => CloudOut | null;
  mode?: () => OutMode;
  /** Echo-cancelled barge-in (else capture is held while the agent speaks). */
  aec?: () => boolean;
  /** The reading speed, read for each utterance (speech-rate.ts; 1 if absent). */
  rate?: () => number;
  /** In a gesture (the mic's tap): unlock the outputs for later, as iOS needs. */
  unlock?: () => void;
  now?: () => number;
  log?: VoiceLog;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}) {
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const now = d.now ?? (() => Date.now());
  const cloud = () => d.cloud?.() ?? null;
  const mode = (): OutMode => (d.mode?.() === "cloud" && cloud() ? "cloud" : "speech");
  const aec = () => d.aec?.() ?? true;
  let log: VoiceLog = d.log ?? (() => {});
  let mic = false;
  let speaking = false;
  const queue: Sentence[] = [];
  /** Interruptions under way; the reading waits while any is. */
  const pauses = new Set<Why>();
  /** The sentence playing: how, (speech) the char of the last word boundary heard, and its record. */
  let current: { p: Playback; mark: number; said: Said } | null = null;
  let tail: unknown;
  let idle: unknown;
  /** Bumped whenever the utterance playing is dropped: its late events are ignored. */
  let epoch = 0;
  /** The agent's volume: 1, or DUCK_LEVEL while the user talks over it. */
  let level = 1;
  /** Ducked: the barge-in timer, and the speech probabilities heard since it was armed. */
  let duck: { timer: unknown; probs: number[] } | null = null;
  const said: Said[] = [];
  const spokenIds: string[] = [];
  const subs = new Set<(s: VoiceState) => void>();

  const state = (): VoiceState => ({
    mic,
    speaking,
    hold: speaking && !aec(),
    ducked: !!duck,
    queued: queue.length,
    paused: pauses.size > 0,
  });
  const emit = () => {
    const s = state();
    for (const f of subs) f(s);
  };
  const focusRule = () => d.enabled() && (d.here?.() ?? true);
  const canSpeak = () => !!d.synth() || mode() === "cloud";

  const ended = () => {
    if (current && current.said.end === undefined) current.said.end = now();
  };

  /** Read one sentence with speechSynthesis (from its last word boundary). */
  const speech = (head: Sentence, ev: PlayEvents, e: number): Playback | null => {
    const s = d.synth();
    if (!s) return null;
    const from = head.from;
    const u = d.utter(head.text.slice(from), head.lang);
    // iOS cannot change it mid-utterance: a duck applies from the next sentence.
    if (level !== 1) u.volume = level;
    // The speed, as set now: a change applies from the next utterance.
    u.rate = d.rate?.() ?? 1;
    u.onboundary = (b) => {
      if (e !== epoch || !current) return;
      if (b.name && b.name !== "word") return;
      current.mark = from + Math.max(0, b.charIndex | 0);
    };
    u.onend = () => ev.onend();
    u.onerror = () => ev.onerror();
    s.speak(u);
    return {
      route: "speech",
      stop: () => {
        s.cancel();
        return {};
      },
      volume: () => {},
    };
  };

  /** Speak the head of the queue, if nothing is playing and nothing waits (the caller emits). */
  const next = () => {
    if (current || pauses.size || !canSpeak()) return;
    const head = queue[0];
    if (!head) return;
    const e = epoch;
    const done = () => {
      if (e !== epoch) return;
      ended();
      current = null;
      queue.shift();
      next();
      if (!current) {
        // Queue dry: capture resumes after the tail.
        clearTimer(tail);
        tail = setTimer(() => {
          if (e !== epoch || current) return;
          speaking = false;
          emit();
        }, RESUME_TAIL_MS);
      }
      emit();
    };
    const info = { lang: head.lang, chars: head.text.length };
    // A failure that is not ours (we only cancel after bumping the epoch) moves on too.
    const ev: PlayEvents = {
      onend: done,
      onerror: done,
      onfail: (reason) => {
        if (e !== epoch || !current) return;
        log({ ev: "voice-out", out: "cloud", route: "speech", fallback: reason, ...info });
        const p = speech(head, ev, e);
        if (!p) return done();
        current.p = p;
      },
    };
    const rec: Said = { text: head.text, start: now() };
    const c = mode() === "cloud" ? cloud() : null;
    current = { p: null as unknown as Playback, mark: head.from, said: rec };
    const p = c
      ? c.play(
          { text: head.text, lang: head.lang, at: head.at, volume: level, rate: d.rate?.() ?? 1 },
          ev,
        )
      : speech(head, ev, e);
    if (!p) {
      current = null;
      return;
    }
    current.p = p;
    said.push(rec);
    if (said.length > 50) said.shift();
    log({
      ev: "voice-out",
      out: c ? "cloud" : "speech",
      route: p.route,
      ...info,
      volume: level,
      at: head.at || undefined,
      from: head.from || undefined,
    });
    // Fetch the next one while this plays.
    const after = queue[1];
    if (c && after) c.prepare?.(after.text, after.lang);
    clearTimer(tail);
    speaking = true;
  };

  /** Drop the utterance playing (keeping where it got to) and release the mic at once. */
  const halt = (keepPlace: boolean) => {
    epoch++;
    clearTimer(tail);
    if (current) {
      ended();
      const place = current.p.stop();
      const head = queue[0];
      if (keepPlace && head) {
        if (current.p.route === "audio") head.at = place.at ?? head.at;
        else {
          head.from = current.mark;
          head.at = 0;
        }
      }
      current = null;
    }
    speaking = false;
  };

  const setLevel = (l: number, ms: number) => {
    level = l;
    current?.p.volume(l, ms);
  };
  /** Back to full volume: ramped (the user stopped) or at once (the reading stopped). */
  const unduck = (ms: number) => {
    if (!duck) return;
    clearTimer(duck.timer);
    duck = null;
    setLevel(1, ms);
  };
  const armBarge = () => {
    const dk = duck;
    if (!dk) return;
    clearTimer(dk.timer);
    dk.timer = setTimer(() => {
      if (duck !== dk) return;
      const probs = dk.probs;
      dk.probs = [];
      const prob = probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : undefined;
      if (!isBargeIn(probs)) {
        log({ ev: "voice-duck-hold", prob });
        return armBarge();
      }
      log({ ev: "voice-barge-in", prob });
      api.interrupt("speech");
    }, BARGE_IN_MS);
  };

  const resume = () => {
    clearTimer(idle);
    if (!pauses.size) return;
    pauses.clear();
    next();
    emit();
  };

  const clear = () => {
    halt(false);
    unduck(0);
    clearTimer(idle);
    queue.length = 0;
    pauses.clear();
    emit();
  };

  const api = {
    v: V,
    state,
    subscribe(f: (s: VoiceState) => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
    /** Where the debug events go. */
    setLog(f: VoiceLog) {
      log = f;
    },
    log: (ev: Record<string, unknown>) => log(ev),
    /** The output in use: "speech" or "cloud". */
    mode,
    aec,
    /** Whether a reply arriving now is read: always with the mic on, else by the toggle and here(). */
    shouldSpeak: () => mic || focusRule(),
    /** The read-aloud toggle as it applies now (forced on while the mic is on). */
    readAloud: () => mic || d.enabled(),
    /** The mic turned on or off. Off: what the focus rule would not read stops. */
    setMic(on: boolean) {
      if (mic === on) return;
      mic = on;
      if (!on && !focusRule()) return clear();
      emit();
    },
    /** A reply arrived live: queue its sentences (if it should be read). */
    reply(text: string): boolean {
      if (!canSpeak() || !api.shouldSpeak()) return false;
      const lang = pickLang(text);
      const add = sentences(text)
        .flatMap((s) => chunk(s))
        .map((t) => ({ text: t, lang, from: 0, at: 0 }));
      const first = add[0];
      if (!first) return false;
      const c = mode() === "cloud" ? cloud() : null;
      if (c && !queue.length) c.prepare?.(first.text, lang);
      queue.push(...add);
      next();
      emit();
      return true;
    },
    /**
     * The box's hook: read a live reply (once per message id). The same as
     * reply(), without its answer.
     */
    speak(text: string, id?: string): void {
      if (id) {
        if (spokenIds.includes(id)) return;
        spokenIds.push(id);
        if (spokenIds.length > SPOKEN_IDS) spokenIds.shift();
      }
      api.reply(text);
    },
    /**
     * The box's hook: `stop("typing")` (or "tap", "speech") pauses the
     * reading where it is, until resume(); `stop()` with no reason (or any
     * other) clears the queue ("Stop reading").
     */
    stop(why?: string): void {
      if (why && WHYS.includes(why)) return api.interrupt(why as Why);
      clear();
    },
    /** In a gesture: unlock the outputs (the mic's tap calls it). */
    unlock() {
      d.unlock?.();
    },
    /**
     * The VAD heard the user start. Over the agent with echo cancellation on:
     * duck it, and pause the reading only if they keep going (BARGE_IN_MS).
     * Otherwise as interrupt("speech").
     */
    userSpeech() {
      if (current && aec()) {
        if (!duck) {
          duck = { timer: undefined, probs: [] };
          setLevel(DUCK_LEVEL, DUCK_ATTACK_MS);
          log({ ev: "voice-duck", route: current.p.route });
          emit();
        }
        armBarge();
        return;
      }
      api.interrupt("speech");
    },
    /** One VAD frame's speech probability while the user is heard (judges a barge-in). */
    userFrame(prob: number) {
      duck?.probs.push(prob);
    },
    /**
     * The user cut in: `speech` (a barge-in), `tap` (the mic button while the
     * agent speaks) or `typing`. Only when there is something to interrupt.
     * Speech and taps resume after IDLE_RESUME_MS unless more happens;
     * typing waits for resume().
     */
    interrupt(why: Why) {
      if (!queue.length && !current) {
        unduck(0);
        // Only the tail is left: release the mic now.
        if (speaking) {
          halt(false);
          emit();
        }
        return;
      }
      halt(true);
      unduck(0); // after the halt: what stopped is not turned back up first
      pauses.add(why);
      clearTimer(idle);
      if (why === "tap") idle = setTimer(resume, IDLE_RESUME_MS);
      emit();
    },
    /** The user's utterance ended (or misfired): unduck, or read on after a short quiet. */
    userIdle() {
      if (duck) {
        unduck(DUCK_RELEASE_MS);
        emit();
        return;
      }
      if (!pauses.has("speech") && !pauses.has("tap")) return;
      clearTimer(idle);
      idle = setTimer(resume, IDLE_RESUME_MS);
    },
    /** The interruption is over (a line was sent, or the input lost focus): read on. */
    resume,
    /**
     * Was `transcript` (an utterance `durationMs` long, just ended) the agent's
     * own voice? Checked against what it said in the last ECHO_WINDOW_MS.
     */
    echoCheck(transcript: string, durationMs = 0): EchoCheck {
      const t = now();
      const from = t - durationMs;
      const recent = said.filter((r) => (r.end ?? t) >= from - ECHO_WINDOW_MS).map((r) => r.text);
      const during = said.some((r) => r.start <= t && (r.end ?? t) >= from);
      return { ...echoScore(transcript, recent), during };
    },
    /**
     * A transcript was the agent's own echo (echoCheck): a barge-in it caused
     * was no barge-in, so the reading goes on now rather than after the idle.
     */
    echoDropped() {
      if (pauses.size === 1 && pauses.has("speech")) resume();
    },
  };
  return api;
}

export type Voice = ReturnType<typeof createVoice>;

/** What the box needs of a voice: read a live reply, and stop (or pause) reading. */
export interface VoiceHook {
  speak(text: string, id?: string): void;
  stop(why?: string): void;
}

const synth = () =>
  typeof speechSynthesis === "undefined" ? null : (speechSynthesis as unknown as SynthLike);

/** Whether agent replies are read aloud on this device (on unless turned off; the box's toggle). */
export const speechEnabled = (key = SPEAK_KEY) => {
  try {
    return globalThis.localStorage?.getItem(key) !== "0";
  } catch {
    return true;
  }
};

/** The default `here`: this tab is visible. */
export function speakHere() {
  return typeof document !== "undefined" && document.visibilityState === "visible";
}

/** The page session's settings; each may be changed by a later voice(opts). */
export type VoiceOptions = {
  /** The host's TTS endpoint, for the "cloud" output (none: speech only). */
  tts?: TtsSource | null;
  /** What it can voice: languages (base codes) and a length cap. */
  ttsLimits?: TtsLimits;
  /** The output (default: `liagent:voice-out`, "cloud" only with a tts endpoint). */
  mode?: () => OutMode;
  /** The read-aloud toggle (default: `liagent:speak` is not "0"). */
  enabled?: () => boolean;
  /** Whether a reply is for this page while the mic is off (default: the tab is visible). */
  here?: () => boolean;
  /** Echo-cancelled barge-in (default: `liagent:voice-aec` is not "0"). */
  aec?: () => boolean;
  /** The reading speed (default: `liagent:speech-rate`). */
  rate?: () => number;
  log?: VoiceLog;
};

/**
 * Utterances still playing are kept here: Chrome may garbage-collect one
 * nothing references, and then its `end` never fires.
 */
const alive = new Set<unknown>();

type Held = Voice & { configure?: (o: VoiceOptions) => void };

/** The page's voice session, shared by every copy of this module; `opts` (re)configure it. */
export function voice(opts?: VoiceOptions): Voice & { configure(o: VoiceOptions): void } {
  const g = globalThis as unknown as Record<string, Held | undefined>;
  const have = g[VOICE_SESSION_KEY];
  if (have && have.v === V && have.configure) {
    if (opts) have.configure(opts);
    return have as Voice & { configure(o: VoiceOptions): void };
  }
  let o: VoiceOptions = { ...opts };
  if (o.tts !== undefined) cloudOut(o.tts, o.ttsLimits);
  const v = createVoice({
    synth,
    enabled: () => (o.enabled ?? speechEnabled)(),
    here: () => (o.here ?? speakHere)(),
    cloud: () => (cloudReady() ? cloudOut() : null),
    mode: () => (o.mode ?? outMode)(),
    aec: () => (o.aec ?? aecOn)(),
    rate: () => (o.rate ?? speechRate)(),
    unlock: () => {
      if ((o.mode ?? outMode)() === "cloud" && cloudReady()) cloudOut()?.unlock();
    },
    log: o.log,
    utter: (text, lang) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      const pick = pickNaturalVoice(speechSynthesis.getVoices(), lang);
      if (pick) u.voice = pick;
      alive.add(u);
      u.addEventListener("end", () => alive.delete(u));
      u.addEventListener("error", () => alive.delete(u));
      return u as unknown as UtterLike;
    },
  });
  const out = Object.assign(v, {
    configure(next: VoiceOptions) {
      o = { ...o, ...next };
      if (next.tts !== undefined || next.ttsLimits) cloudOut(o.tts ?? null, o.ttsLimits);
      if (next.log) v.setLog(next.log);
    },
  });
  g[VOICE_SESSION_KEY] = out;
  return out;
}
