/**
 * How the agent's voice leaves the page, and how the mic is opened:
 *
 * - `liagent:voice-out` (localStorage) picks the output: "speech" (the
 *   default: the device's own speechSynthesis) or "cloud" (each sentence
 *   fetched from the host's TTS endpoint and played through one `<audio>`
 *   element routed through the mic's AudioContext and a GainNode — page
 *   audio, so the browser's echo canceller has it as its reference, and the
 *   gain ducks it; iOS ignores `element.volume`). "cloud" needs a TTS URL
 *   from the host (`voice({ tts })`); without one it is "speech".
 * - `liagent:voice-aec` (default on) opens the mic with echoCancellation,
 *   noiseSuppression and autoGainControl and keeps it open while the agent
 *   speaks. "0": capture is held while the agent speaks instead.
 *
 * createCloudOut takes its browser pieces injected (fetch, the element, the
 * AudioContext), so it is tested with fakes in test/voice-out.test.ts.
 */
import { encodeWav } from "./mic.ts";
import { existingCtx } from "./mic-audio.ts";
import type { CloudOut, PlayEvents, Playback } from "./voice.ts";

export {
  AEC_CONSTRAINTS,
  LEGACY_CONSTRAINTS,
  appliedSettings,
  audioCtx,
  existingCtx,
  micConstraints,
  noteTrack,
} from "./mic-audio.ts";

export const VOICE_OUT_KEY = "liagent:voice-out";
export const VOICE_AEC_KEY = "liagent:voice-aec";
export type OutMode = "speech" | "cloud";

/** A clip resumed after an interruption starts this much before where it stopped. */
export const RESUME_REWIND_S = 0.3;
const ignore = () => {};
/** Clips (blob URLs) kept for replays and resumes. */
const CLIP_CACHE = 64;

const read = (k: string): string | null => {
  try {
    return globalThis.localStorage?.getItem(k) ?? null;
  } catch {
    return null;
  }
};
/** The output asked for on this device: "cloud" only when set so. */
export const outMode = (): OutMode => (read(VOICE_OUT_KEY) === "cloud" ? "cloud" : "speech");
/** Echo-cancelled barge-in (default on; "0" = capture held while the agent speaks). */
export const aecOn = (): boolean => read(VOICE_AEC_KEY) !== "0";

/** The slice of an HTMLAudioElement the cloud output uses. */
export type ElementLike = {
  src: string;
  currentTime: number;
  volume: number;
  preload: string;
  paused: boolean;
  /** The reading speed; load() resets it to defaultPlaybackRate, so both are set. */
  playbackRate?: number;
  defaultPlaybackRate?: number;
  /** Keep the voice's pitch at any speed (and Safari's prefixed name). */
  preservesPitch?: boolean;
  webkitPreservesPitch?: boolean;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  onloadedmetadata: (() => void) | null;
  play(): Promise<void>;
  pause(): void;
  load(): void;
};
export type GainLike = {
  gain: {
    value: number;
    cancelScheduledValues(t: number): unknown;
    setValueAtTime(v: number, t: number): unknown;
    linearRampToValueAtTime(v: number, t: number): unknown;
  };
  connect(n: unknown): unknown;
};
export type CtxLike = {
  currentTime: number;
  destination: unknown;
  state?: string;
  resume?(): Promise<void>;
  createGain(): GainLike;
  createMediaElementSource(el: unknown): { connect(n: unknown): unknown };
};
export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(k: string): string | null };
  blob(): Promise<Blob>;
}>;

/** The URL of one sentence's audio, from its text and language (e.g. "ja-JP"). */
export type TtsUrl = (text: string, lang: string) => string;
/**
 * The host's TTS endpoint: a function building each sentence's URL, or a
 * base URL that gets `lang` (the base language, "ja") and `text` added to its
 * query: GET <base>?lang=ja&text=… answering audio (audio/mpeg, audio/wav…).
 */
export type TtsSource = string | TtsUrl;

/** A base URL as a TtsUrl: `?lang=<base language>&text=<text>` added to its query. */
export function ttsUrlFrom(src: TtsSource): TtsUrl {
  if (typeof src === "function") return src;
  return (text, lang) =>
    `${src}${src.includes("?") ? "&" : "?"}lang=${encodeURIComponent(lang.split(/[-_]/)[0] ?? lang)}&text=${encodeURIComponent(text)}`;
}

/** What the endpoint can voice: languages (base codes; none = any) and a text length cap. */
export type TtsLimits = { langs?: ReadonlySet<string> | readonly string[]; maxText?: number };

/** Why a sentence cannot be fetched at all (null: try the endpoint). */
export function cloudSkip(text: string, lang: string, lim: TtsLimits = {}): string | null {
  const langs = lim.langs ? new Set(lim.langs) : null;
  if (langs && !langs.has(lang.toLowerCase().split(/[-_]/)[0] ?? "")) return "lang";
  if (!text.trim()) return "empty";
  if (lim.maxText !== undefined && text.length > lim.maxText) return "long";
  return null;
}

/**
 * Cloud replies: one `<audio>` element for the whole page (unlocked once in
 * a gesture, so iOS lets later sentences play), routed through the
 * AudioContext and one GainNode. A sentence that cannot be fetched or played
 * calls `onfail` (the session reads it with speechSynthesis instead).
 */
export function createCloudOut(
  d: {
    /** Each sentence's URL; read for every fetch, so it may change. */
    url: () => TtsUrl | null;
    fetch: FetchLike;
    element: () => ElementLike;
    ctx: () => CtxLike | null;
    toUrl?: (b: Blob) => string;
    revoke?: (u: string) => void;
  } & TtsLimits,
): CloudOut & { unlock(): void; gain(): GainLike | null } {
  const toUrl = d.toUrl ?? ((b) => URL.createObjectURL(b));
  const revoke = d.revoke ?? ((u) => URL.revokeObjectURL(u));
  /** Read each time: the page's output may switch endpoints. */
  const lim = (): TtsLimits => ({ langs: d.langs, maxText: d.maxText });
  const clips = new Map<string, Promise<string>>();
  let el: ElementLike | null = null;
  let gain: GainLike | null = null;
  let wired = false;
  /** Bumped by every play and stop: the element's events for older ones are ignored. */
  let turn = 0;

  const element = () => {
    if (!el) {
      el = d.element();
      el.preload = "auto";
    }
    if (!wired) {
      // Through Web Audio once a context exists; createMediaElementSource may be called once per element.
      const ctx = d.ctx();
      if (ctx) {
        wired = true;
        try {
          const g = ctx.createGain();
          ctx.createMediaElementSource(el).connect(g);
          g.connect(ctx.destination);
          gain = g;
        } catch {
          gain = null; // plays unrouted: no ducking on iOS
        }
      }
    }
    return el;
  };

  const fetchClip = (text: string, lang: string): Promise<string> => {
    const key = `${lang}\n${text}`;
    const have = clips.get(key);
    if (have) return have;
    const url = d.url();
    const p = url
      ? d.fetch(url(text, lang)).then(async (r) => {
          const why = r.headers.get("X-Voice");
          if (!r.ok) throw new Error(`http ${r.status}${why ? ` ${why}` : ""}`);
          return toUrl(await r.blob());
        })
      : Promise.reject(new Error("no tts url"));
    clips.set(key, p);
    p.catch(() => clips.delete(key));
    if (clips.size > CLIP_CACHE) {
      const first = clips.entries().next().value;
      if (first) {
        clips.delete(first[0]);
        first[1].then(revoke, ignore);
      }
    }
    return p;
  };

  const ramp = (level: number, ms: number) => {
    const ctx = d.ctx();
    if (gain && ctx) {
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(level, now + ms / 1000);
    } else if (el) el.volume = level;
  };
  const setLevel = (level: number) => {
    const ctx = d.ctx();
    if (gain && ctx) {
      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.setValueAtTime(level, ctx.currentTime);
    } else if (el) el.volume = level;
  };

  return {
    unlock() {
      // In a gesture: an element that has played once may play later without one (iOS).
      const a = element();
      if (!a.paused) return;
      a.src = silentWav();
      a.play().then(() => a.pause(), ignore);
    },
    gain: () => gain,
    prepare(text, lang) {
      if (!cloudSkip(text, lang, lim())) fetchClip(text, lang).catch(ignore);
    },
    play(s, ev: PlayEvents): Playback {
      const me = ++turn;
      const live = () => me === turn;
      const fail = (why: string) => void Promise.resolve().then(() => live() && ev.onfail?.(why));
      const pb: Playback = {
        route: "audio",
        stop() {
          if (!live()) return {};
          turn++;
          const a = el;
          if (!a) return { at: s.at };
          a.pause();
          return { at: Math.max(0, a.currentTime - RESUME_REWIND_S) };
        },
        volume: (level, ms) => live() && ramp(level, ms),
      };
      const skip = cloudSkip(s.text, s.lang, lim());
      if (skip) {
        fail(skip);
        return pb;
      }
      fetchClip(s.text, s.lang).then(
        (url) => {
          if (!live()) return;
          const a = element();
          d.ctx()?.resume?.().catch(ignore);
          setLevel(s.volume);
          a.onended = () => live() && ev.onend();
          a.onerror = () => live() && ev.onerror();
          a.onloadedmetadata = () => {
            if (!live()) return;
            a.onloadedmetadata = null;
            // Resume by offset: where the interrupted clip stopped (else its start).
            a.currentTime = s.at;
            // The speed, pitch kept (a resume after a duck keeps it: it is per play).
            const rate = s.rate ?? 1;
            a.defaultPlaybackRate = rate;
            a.playbackRate = rate;
            a.preservesPitch = true;
            a.webkitPreservesPitch = true;
            a.play().catch((e: unknown) => {
              if (live()) ev.onfail?.(`play ${(e as Error)?.name ?? "error"}`);
            });
          };
          a.src = url;
          a.load();
        },
        (e: unknown) => live() && ev.onfail?.(String((e as Error)?.message ?? e)),
      );
      return pb;
    },
  };
}

/** 10 ms of silence (8 kHz WAV): what unlock() plays in the gesture. */
let silent = "";
const silentWav = () => {
  if (silent) return silent;
  let bin = "";
  for (const b of encodeWav(new Float32Array(80), 8_000)) bin += String.fromCharCode(b);
  return (silent = `data:audio/wav;base64,${btoa(bin)}`);
};

type CloudHolder = {
  out: ReturnType<typeof createCloudOut>;
  url: TtsUrl | null;
  lim: TtsLimits;
};
const CLOUD_KEY = "__liagentCloudOut";

/**
 * The page's cloud output (null outside a browser), on fetch, new Audio()
 * and the page's AudioContext. `tts` (and `limits`) set the endpoint; a
 * later call with another one switches to it.
 */
export function cloudOut(tts?: TtsSource | null, limits?: TtsLimits) {
  const g = globalThis as unknown as Record<string, CloudHolder | undefined>;
  let h = g[CLOUD_KEY];
  if (!h) {
    if (typeof Audio === "undefined" || typeof fetch === "undefined") return null;
    const holder: CloudHolder = {
      url: null,
      lim: limits ?? {},
      out: null as unknown as CloudHolder["out"],
    };
    holder.out = createCloudOut({
      url: () => holder.url,
      fetch: (u) => fetch(u, { credentials: "same-origin" }),
      element: () => new Audio() as unknown as ElementLike,
      ctx: () => existingCtx() as unknown as CtxLike | null,
      get langs() {
        return holder.lim.langs;
      },
      get maxText() {
        return holder.lim.maxText;
      },
    });
    h = g[CLOUD_KEY] = holder;
  }
  if (tts !== undefined) h.url = tts ? ttsUrlFrom(tts) : null;
  if (limits) h.lim = limits;
  return h.out;
}

/** The cloud output has an endpoint to fetch from. */
export const cloudReady = (): boolean =>
  !!(globalThis as unknown as Record<string, CloudHolder | undefined>)[CLOUD_KEY]?.url;
