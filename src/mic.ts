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
export const MAX_UTTERANCE_MS = 30_000;
/** The VADs hand over 16 kHz mono. */
export const RATE = 16_000;
/** Partials: one every PARTIAL_EVERY_MS of speech, once it is PARTIAL_MIN_MS long… */
export const PARTIAL_EVERY_MS = 2_500;
export const PARTIAL_MIN_MS = 3_000;
/** …each chunk overlapping the one before by this much, so a word cut at its edge is heard whole. */
export const PARTIAL_OVERLAP_MS = 1_500;
/** Shown in the input for an utterance still being transcribed. */
export const PENDING_MARK = "…";

export type MicState = "off" | "loading" | "listening" | "capturing";
/** What the button shows, from the state and the transcripts still out. */
export type MicStatus =
  | "idle"
  | "loading"
  | "listening"
  | "capturing"
  | "transcribing"
  | "speaking";

/**
 * `speaking`: the agent's reply is being read while the mic is on. Capturing
 * wins: with echo cancellation the user can talk over the agent.
 */
export function micStatus(state: MicState, pending: number, speaking = false): MicStatus {
  if (state === "capturing") return "capturing";
  if (speaking && state === "listening") return "speaking";
  if (pending > 0) return "transcribing";
  if (state === "off") return "idle";
  return state;
}

/** What a VAD must do. `flush` ends the current utterance now (the 30 s cap). */
export type Vad = {
  start(): Promise<void> | void;
  pause(): Promise<void> | void;
  flush(): Promise<void> | void;
  destroy(): Promise<void> | void;
};
export type VadEvents = {
  onSpeechStart(): void;
  /** One utterance, 16 kHz mono samples in [-1, 1]. */
  onSpeechEnd(samples: Float32Array): void;
  /** Speech seemed to start but was too short to keep. */
  onMisfire(): void;
  /**
   * Every frame heard (16 kHz), for the partials; only those while capturing
   * are kept. `prob`: the VAD's speech probability for it (Silero only).
   */
  onFrame?(frame: Float32Array, prob?: number): void;
};
export type VadFactory = (ev: VadEvents) => Promise<Vad>;

/** A non-2xx answer from the STT endpoint. */
export class SttError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SttError";
  }
}

const nameOf = (e: unknown) => (e as { name?: string } | null)?.name;

/** getUserMedia refused or found nothing: the fallback needs the mic too, so it is not tried. */
export function isMicDenied(e: unknown): boolean {
  const n = nameOf(e);
  return n === "NotAllowedError" || n === "SecurityError" || n === "NotFoundError";
}

/** The notes' wording; a host can translate it (`<liagent-mic>.strings`). */
export type MicErrorStrings = {
  denied: string;
  noMic: string;
  signIn: string;
  tooMuch: string;
  /** `{status}` is replaced by the HTTP status. */
  failed: string;
  /** `{message}` is replaced by the error's message. */
  other: string;
};
export const MIC_ERROR_STRINGS_EN: MicErrorStrings = {
  denied: "Microphone permission denied",
  noMic: "No microphone found",
  signIn: "Sign in to use the mic",
  tooMuch: "Too much speech for now; try again in a minute",
  failed: "Transcription failed ({status})",
  other: "Mic: {message}",
};

/** The short note by the button for an error. */
export function micErrorNote(
  e: unknown,
  t: Partial<MicErrorStrings> = MIC_ERROR_STRINGS_EN,
): string {
  const s = { ...MIC_ERROR_STRINGS_EN, ...t };
  const n = nameOf(e);
  if (n === "NotAllowedError" || n === "SecurityError") return s.denied;
  if (n === "NotFoundError") return s.noMic;
  if (e instanceof SttError) {
    if (e.status === 401) return s.signIn;
    if (e.status === 429) return s.tooMuch;
    return s.failed.replace("{status}", String(e.status));
  }
  return s.other.replace("{message}", String((e as Error | null)?.message ?? e).slice(0, 100));
}

/**
 * Utterances in flight, in the order they were spoken. `take()` hands back
 * the text of every finished one that has nothing unfinished before it.
 */
export class UtteranceQueue {
  private next = 0;
  private head = 0;
  private done = new Map<number, string | null>();
  private partials = new Map<number, string>();
  add(): number {
    return this.next++;
  }
  resolve(seq: number, text: string | null) {
    if (seq < this.head) return;
    this.done.set(seq, text);
    this.partials.delete(seq);
  }
  /** Interim text for one not yet resolved (ignored once it is). */
  partial(seq: number, text: string) {
    if (seq >= this.head && !this.done.has(seq)) this.partials.set(seq, text);
  }
  getPartial(seq: number): string {
    return this.partials.get(seq) ?? "";
  }
  /** Text now in order (failed ones are skipped), joined with joinText. */
  take(): string {
    let out = "";
    while (this.done.has(this.head)) {
      const t = this.done.get(this.head);
      this.done.delete(this.head++);
      if (t) out = joinText(out, t);
    }
    return out;
  }
  /** Utterances still being transcribed. */
  pending(): number {
    return this.next - this.head;
  }
  /**
   * What the input shows, dimmed, after the draft: for each utterance not yet
   * taken, its text (done, waiting on an earlier one), its partial, or
   * PENDING_MARK (one mark for a run of them).
   */
  interim(): string {
    let out = "";
    let mark = false;
    for (let s = this.head; s < this.next; s++) {
      const t = this.done.has(s) ? (this.done.get(s) ?? "") : this.partials.get(s) || PENDING_MARK;
      if (t === PENDING_MARK && mark) continue;
      mark = t === PENDING_MARK;
      out = joinText(out, t);
    }
    return out;
  }
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}。、！？]/u;

/** Append `b` to `a`: a space between them, except between CJK characters or at a line start. */
export function joinText(a: string, b: string): string {
  const t = b.trim();
  if (!t) return a;
  if (!a || /\s$/.test(a)) return a + t;
  return CJK.test(a.at(-1) ?? "") && CJK.test(t[0] ?? "") ? a + t : `${a} ${t}`;
}

/** A draft ending a sentence (any script's full stop, ! or ?). */
export const ENDS_SENTENCE = /[。．.!?！？]$/;
/**
 * Spoken (or IME-dictated) sentences go out at once from this many characters
 * (trimmed): typing arrives a character at a time, so 3 at once is dictation.
 */
export const AUTO_SEND_MIN = 3;

/**
 * Typed text that arrived at once (an outside dictation IME): AUTO_SEND_MIN
 * or more characters since the draft last settled, and the draft now ends a
 * sentence. Then it is sent at once.
 */
export function isDictationBurst(settledLen: number, draft: string): boolean {
  return draft.length - settledLen >= AUTO_SEND_MIN && ENDS_SENTENCE.test(draft.trim());
}

const QUESTION_CJK =
  /(?:吗|嗎|呢|么|麼|吧|か|かな|かしら|の|でしょう|ですか|ますか|니까|나요|까요)$/u;
const QUESTION_LATIN =
  /^(?:what|why|how|when|where|who|whom|whose|which|can|could|do|does|did|is|are|was|were|will|would|should|shall|may|might|have|has|had)\b/i;
const TRAILING_PUNCT = /[\p{P}\s]+$/u;

/**
 * Spoken text always ends a sentence ("auto-punctuate, then commit"): Whisper
 * usually adds the stop itself; when it doesn't, add one that fits the text —
 * 。/？ for CJK, ./? otherwise, a question by its particle or opening word.
 * Text that already ends in any punctuation (…, ～, quotes) is left alone.
 */
export function punctuate(text: string): string {
  const t = text.trim();
  if (!t || /[\p{P}～]$/u.test(t)) return t;
  const bare = t.replace(TRAILING_PUNCT, "");
  if (CJK.test(t)) return t + (QUESTION_CJK.test(bare) ? "？" : "。");
  return t + (QUESTION_LATIN.test(bare) ? "?" : ".");
}

/** Letters or digits in any script: something was actually said. */
const SPOKEN = /[\p{L}\p{N}]/u;

/**
 * A final transcript lands in the draft, punctuated, and is committed at once
 * (shown, then sent) whenever it carries any words — a short "好" or "OK"
 * too. Partials never come here; typing never does (see isDictationBurst).
 */
export function appendDictation(draft: string, text: string): { draft: string; send: boolean } {
  const said = punctuate(text);
  if (!said) return { draft, send: false };
  const next = joinText(draft, said);
  return { draft: next, send: SPOKEN.test(said) && ENDS_SENTENCE.test(next.trim()) };
}

/** Words (or, in CJK text, characters), and their keys: lowercased, without punctuation. */
function tokens(s: string): { raw: string[]; key: string[]; cjk: boolean } {
  const cjk = CJK.test(s);
  const raw = cjk ? [...s.replace(/\s+/g, "")] : s.split(/\s+/).filter(Boolean);
  const key = raw.map((w) => w.toLowerCase().replace(/[\p{P}\p{S}]/gu, ""));
  return { raw, key, cjk };
}

/**
 * Two overlapping chunks' transcripts as one: the longest run of words that
 * ends `a` and starts `b` is kept once ("the quick brown" + "brown fox" →
 * "the quick brown fox"). With no overlap they are just joined.
 */
export function mergeOverlap(a: string, b: string): string {
  const A = tokens(a.trim());
  const B = tokens(b.trim());
  for (let k = Math.min(A.key.length, B.key.length); k > 0; k--) {
    const end = A.key.slice(-k);
    if (end.join("") && end.every((w, i) => w === B.key[i]))
      return joinText(a.trim(), B.raw.slice(k).join(B.cjk ? "" : " "));
  }
  return joinText(a.trim(), b);
}

/** Linear resampling to `to` Hz (the fallback VAD records at the device's rate). */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const n = Math.max(1, Math.round((input.length * to) / from));
  const out = new Float32Array(n);
  const step = from / to;
  const last = input.length - 1;
  for (let i = 0; i < n; i++) {
    const x = i * step;
    const j = Math.floor(x);
    const a = input[Math.min(j, last)] ?? 0;
    const b = input[Math.min(j + 1, last)] ?? 0;
    out[i] = a + (b - a) * (x - j);
  }
  return out;
}

/** 16-bit PCM WAV, mono: what every STT model takes, and every browser can make. */
export function encodeWav(samples: Float32Array, rate = RATE): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

/** The RMS level of a frame, for the energy fallback. */
export function rms(frame: Float32Array): number {
  let sum = 0;
  for (const x of frame) sum += x * x;
  return Math.sqrt(sum / (frame.length || 1));
}

function concat(chunks: Float32Array[]): Float32Array {
  const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  return all;
}

/**
 * The energy-threshold VAD the mic falls back to when Silero is not given or
 * cannot load: feed it frames; it says when speech starts (two frames over
 * `on`) and ends (`hangMs` under `off`), keeping a frame of audio from before
 * the start.
 */
export function energyGate(opts: {
  rate: number;
  on?: number;
  off?: number;
  hangMs?: number;
  minMs?: number;
}) {
  const on = opts.on ?? 0.02;
  const off = opts.off ?? 0.01;
  const hang = ((opts.hangMs ?? 700) * opts.rate) / 1000;
  const min = ((opts.minMs ?? 250) * opts.rate) / 1000;
  let loud = 0;
  let quiet = 0;
  let speaking = false;
  let pre: Float32Array[] = [];
  let chunks: Float32Array[] = [];
  const cut = (): Float32Array | "misfire" => {
    const all = concat(chunks);
    speaking = false;
    chunks = [];
    quiet = 0;
    loud = 0;
    return all.length < min ? "misfire" : all;
  };
  return {
    /** null: nothing happened; "start"; or the finished utterance (or "misfire"). */
    push(frame: Float32Array): null | "start" | "misfire" | Float32Array {
      const level = rms(frame);
      if (!speaking) {
        pre = [...pre.slice(-1), frame];
        loud = level > on ? loud + 1 : 0;
        if (loud < 2) return null;
        speaking = true;
        chunks = pre;
        pre = [];
        return "start";
      }
      chunks.push(frame);
      quiet = level < off ? quiet + frame.length : 0;
      return quiet >= hang ? cut() : null;
    },
    /** End the utterance now (the cap, or listening turned off). */
    flush(): null | "misfire" | Float32Array {
      return speaking ? cut() : null;
    },
  };
}

export type UploadInfo = { seq: number; durationMs: number; partial: boolean };

/**
 * Listening mode. `toggle()` turns it on (loading the VAD, or the fallback if
 * that fails, unless the mic itself was refused) and off. Each utterance is
 * encoded and uploaded at once; its transcript (in order) goes to `onText`,
 * and `onPending` counts those still out, with the interim text to show
 * dimmed. A capture longer than MAX_UTTERANCE_MS is cut and sent. A 401 turns
 * listening off; a 429 on a partial stops partials until the next turn-on.
 */
export function createMic(d: {
  load: VadFactory;
  fallback?: VadFactory;
  upload: (wav: Uint8Array, info: UploadInfo) => Promise<string>;
  onState: (s: MicState) => void;
  onText: (text: string) => void;
  onPending: (n: number, interim: string) => void;
  onError?: (e: unknown) => void;
  /** Each frame's speech probability while capturing (a voice output's barge-in judge). */
  onProb?: (prob: number) => void;
  /** Rolling partial chunks for long utterances (on unless false). */
  partials?: boolean;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}) {
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const q = new UtteranceQueue();
  let state: MicState = "off";
  let vad: Vad | null = null;
  let cap: unknown;
  /** Bumped on every toggle, so a VAD that finishes loading after "off" is dropped. */
  let gen = 0;
  /** The utterance being captured: its frames, and its seq once a partial reserved one. */
  let live: Float32Array[] = [];
  let liveLen = 0;
  let sincePartial = 0;
  let cur: number | null = null;
  let partialBusy = false;
  let partialsOn = d.partials !== false;
  /** The agent is speaking (hold): capture stops, and anything heard is dropped. */
  let held = false;
  /** Set by a hold: speech that began before it is dropped, even if it ends after. */
  let tainted = false;
  /** VAD pause/start calls, in order. */
  let ctl: Promise<unknown> = Promise.resolve();
  const toMs = (n: number) => Math.round((n / RATE) * 1000);
  const toSamples = (ms: number) => (ms * RATE) / 1000;

  const set = (s: MicState) => {
    state = s;
    d.onState(s);
  };
  const pending = () => d.onPending(q.pending(), q.interim());
  const report = () => {
    const t = q.take();
    if (t) d.onText(t);
    pending();
  };
  const resetLive = () => {
    live = [];
    liveLen = 0;
    sincePartial = 0;
  };
  /** An utterance whose seq a partial reserved ended in nothing. */
  const dropCur = () => {
    if (cur === null) return;
    q.resolve(cur, null);
    cur = null;
    report();
  };
  const fail = (e: unknown) => {
    d.onError?.(e);
    if (e instanceof SttError && e.status === 401) void off();
  };
  const sendPartial = () => {
    const seq = cur ?? (cur = q.add());
    const n = Math.min(liveLen, sincePartial + toSamples(PARTIAL_OVERLAP_MS));
    const chunk = concat(live).subarray(liveLen - n);
    sincePartial = 0;
    partialBusy = true;
    pending();
    d.upload(encodeWav(chunk), { seq, durationMs: toMs(n), partial: true })
      .then(
        (text) => q.partial(seq, mergeOverlap(q.getPartial(seq), text)),
        (e) => {
          // Best effort: a 429 stops partials, a 401 stops listening, the rest is quiet.
          if (e instanceof SttError && e.status === 429) partialsOn = false;
          if (e instanceof SttError && e.status === 401) fail(e);
        },
      )
      .finally(() => {
        partialBusy = false;
        pending();
      });
  };
  const events = (g: number): VadEvents => ({
    onSpeechStart() {
      if (g !== gen || held) return;
      tainted = false;
      set("capturing");
      resetLive();
      clearTimer(cap);
      cap = setTimer(() => void vad?.flush(), MAX_UTTERANCE_MS);
    },
    onFrame(frame, prob) {
      if (g !== gen || state !== "capturing") return;
      if (prob !== undefined) d.onProb?.(prob);
      live.push(frame);
      liveLen += frame.length;
      sincePartial += frame.length;
      if (
        partialsOn &&
        !partialBusy &&
        liveLen >= toSamples(PARTIAL_MIN_MS) &&
        sincePartial >= toSamples(PARTIAL_EVERY_MS)
      )
        sendPartial();
    },
    onMisfire() {
      if (g !== gen || held) return;
      clearTimer(cap);
      resetLive();
      dropCur();
      if (state === "capturing") set("listening");
    },
    onSpeechEnd(audio) {
      // Heard while the agent spoke (or begun before it did): the reply's echo, dropped.
      if (held || tainted) return;
      clearTimer(cap);
      const mine = g === gen;
      if (mine && state === "capturing") set("listening");
      const seq = mine && cur !== null ? cur : q.add();
      if (mine) {
        cur = null;
        resetLive();
      }
      pending();
      d.upload(encodeWav(audio), { seq, durationMs: toMs(audio.length), partial: false })
        .then(
          (text) => q.resolve(seq, text),
          (e) => {
            q.resolve(seq, null);
            fail(e);
          },
        )
        .finally(report);
    },
  });
  const on = async () => {
    const g = ++gen;
    partialsOn = d.partials !== false;
    set("loading");
    let v: Vad;
    try {
      v = await d.load(events(g));
    } catch (e) {
      if (!d.fallback || isMicDenied(e)) {
        if (g === gen) set("off");
        d.onError?.(e);
        return;
      }
      try {
        v = await d.fallback(events(g));
      } catch (e2) {
        if (g === gen) set("off");
        d.onError?.(e2);
        return;
      }
    }
    if (g !== gen) return void v.destroy();
    vad = v;
    if (!held) await v.start();
    set("listening");
  };
  async function off() {
    if (state === "off") return;
    gen++;
    clearTimer(cap);
    const v = vad;
    vad = null;
    // The seq a partial reserved: the flush below sends the speech as a new one.
    const reserved = cur;
    cur = null;
    resetLive();
    set("off");
    if (v) {
      // Speech under way when listening stops is still sent.
      await v.flush();
      await v.destroy();
    }
    if (reserved !== null) {
      cur = reserved;
      dropCur();
    }
  }
  /**
   * Hold capture while the agent speaks (on), resume it (off). Speech being
   * captured is dropped, partials stop, and the VAD is paused; what it hands
   * over meanwhile (a submit-on-pause) is dropped too.
   */
  function hold(on: boolean) {
    if (held === on) return;
    held = on;
    if (on) {
      tainted = true;
      clearTimer(cap);
      resetLive();
      dropCur();
      if (state === "capturing") set("listening");
    }
    const v = vad;
    if (v) ctl = ctl.then(() => (on ? v.pause() : v.start())).catch(() => {});
  }
  return {
    toggle: () => (state === "off" ? on() : off()),
    hold,
    held: () => held,
    off,
    state: () => state,
  };
}

/** What the STT endpoint answers: JSON with the transcript, and anything else it likes. */
export type SttResult = { text: string; model?: string; ms?: number; language?: string };

/** Where and how to POST an utterance (docs/embed.md, "Voice input"). */
export type SttRequest = {
  /** The endpoint, absolute or relative to the page, e.g. "/api/stt". */
  url: string;
  /** A language hint, sent as `?lang=` (none: the endpoint detects it). */
  lang?: string;
  /** Extra request headers (an API key, a CSRF token…). */
  headers?: Record<string, string>;
  /** fetch's credentials mode (default "same-origin"; "include" for a cookie on another origin). */
  credentials?: RequestCredentials;
  /** The audio's type (default "audio/wav"). */
  type?: string;
};

/** The URL with `lang` added to its query, when a hint is given. */
export function sttUrl(url: string, lang?: string): string {
  if (!lang) return url;
  const at = url.indexOf("#");
  const path = at < 0 ? url : url.slice(0, at);
  const hash = at < 0 ? "" : url.slice(at);
  return `${path}${path.includes("?") ? "&" : "?"}lang=${encodeURIComponent(lang)}${hash}`;
}

/**
 * POST one recording to the host's STT endpoint: the raw audio as the body
 * (16 kHz mono 16-bit PCM WAV) and its type as `content-type`. Answers the
 * endpoint's JSON (`text` defaults to ""). Throws SttError on non-2xx, with
 * the JSON's `error` as its message when there is one.
 */
export async function postStt(
  wav: Uint8Array,
  req: SttRequest | string,
  f: typeof fetch = fetch,
): Promise<SttResult> {
  const r: SttRequest = typeof req === "string" ? { url: req } : req;
  const res = await f(sttUrl(r.url, r.lang), {
    method: "POST",
    body: wav as unknown as BodyInit,
    headers: { "content-type": r.type ?? "audio/wav", ...r.headers },
    credentials: r.credentials ?? "same-origin",
  });
  const out = (await res.json().catch(() => ({}))) as Partial<SttResult> & { error?: string };
  if (!res.ok) throw new SttError(res.status, out.error ?? `stt ${res.status}`);
  return { ...out, text: typeof out.text === "string" ? out.text : "" };
}

/** The send tick: two soft sine tones, this loud at their peak, this long in all. */
export const TICK_GAIN = 0.08;
export const TICK_MS = 80;

/** The slice of an AudioContext the tick uses (a fake in the tests). */
export type TickContext = {
  currentTime: number;
  destination: unknown;
  createOscillator(): {
    type: string;
    frequency: { setValueAtTime(v: number, t: number): unknown };
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
export function scheduleTick(ctx: TickContext, at = ctx.currentTime) {
  const end = at + TICK_MS / 1000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.linearRampToValueAtTime(TICK_GAIN, at + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, end);
  g.connect(ctx.destination);
  const tones: [number, number][] = [
    [880, at],
    [1320, at + 0.03],
  ];
  for (const [hz, t] of tones) {
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(hz, t);
    o.connect(g);
    o.start(t);
    o.stop(end);
  }
  return end;
}
