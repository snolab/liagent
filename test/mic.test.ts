import { describe, expect, it } from "bun:test";
import {
  MAX_UTTERANCE_MS,
  type MicState,
  PENDING_MARK,
  RATE,
  SttError,
  type UploadInfo,
  AUTO_SEND_MIN,
  ENDS_SENTENCE,
  UtteranceQueue,
  appendDictation,
  punctuate,
  isDictationBurst,
  type VadEvents,
  createMic,
  encodeWav,
  energyGate,
  isMicDenied,
  joinText,
  mergeOverlap,
  micErrorNote,
  micStatus,
  sttUrl,
  MIC_ERROR_STRINGS_EN,
  postStt,
  resample,
  rms,
  scheduleTick,
  TICK_GAIN,
  TICK_MS,
} from "../src/mic.ts";

const domErr = (name: string) => Object.assign(new Error(name), { name });

describe("micStatus and error notes", () => {
  it("idle, loading, listening, capturing, transcribing", () => {
    expect(micStatus("off", 0)).toBe("idle");
    expect(micStatus("loading", 0)).toBe("loading");
    expect(micStatus("listening", 0)).toBe("listening");
    expect(micStatus("capturing", 2)).toBe("capturing");
    expect(micStatus("listening", 1)).toBe("transcribing");
    expect(micStatus("off", 1)).toBe("transcribing");
  });

  it("says what went wrong in a few words", () => {
    expect(micErrorNote(domErr("NotAllowedError"))).toBe("Microphone permission denied");
    expect(micErrorNote(domErr("SecurityError"))).toBe("Microphone permission denied");
    expect(micErrorNote(domErr("NotFoundError"))).toBe("No microphone found");
    expect(micErrorNote(new SttError(401, "x"))).toBe("Sign in to use the mic");
    expect(micErrorNote(new SttError(429, "x"))).toMatch(/try again/);
    expect(micErrorNote(new SttError(502, "x"))).toBe("Transcription failed (502)");
    expect(micErrorNote(new Error("wasm blocked"))).toBe("Mic: wasm blocked");
    expect(micErrorNote("odd")).toBe("Mic: odd");
    expect(micErrorNote(null)).toBe("Mic: null");
    expect(isMicDenied(domErr("NotAllowedError"))).toBe(true);
    expect(isMicDenied(new Error("x"))).toBe(false);
    expect(isMicDenied(null)).toBe(false);
  });
});

describe("UtteranceQueue, joinText and mergeOverlap", () => {
  it("hands back text in the order spoken, skipping failures", () => {
    const q = new UtteranceQueue();
    const [a, b, c] = [q.add(), q.add(), q.add()];
    expect(q.pending()).toBe(3);
    q.resolve(c, "three");
    expect(q.take()).toBe("");
    q.resolve(a, "one");
    expect(q.take()).toBe("one");
    q.resolve(b, null);
    expect(q.take()).toBe("three");
    expect(q.pending()).toBe(0);
    q.resolve(a, "late"); // already taken: ignored
    expect(q.take()).toBe("");
  });

  it("interim: done-but-waiting text, partials, one … per run of pending", () => {
    const q = new UtteranceQueue();
    expect(q.interim()).toBe("");
    const [a, b, c, d] = [q.add(), q.add(), q.add(), q.add()];
    expect(q.interim()).toBe(PENDING_MARK);
    q.partial(b, "hello wor");
    expect(q.getPartial(b)).toBe("hello wor");
    expect(q.interim()).toBe(`${PENDING_MARK} hello wor ${PENDING_MARK}`);
    q.resolve(b, "hello world");
    q.partial(b, "stale"); // a partial after the final changes nothing
    expect(q.getPartial(b)).toBe("");
    expect(q.interim()).toBe(`${PENDING_MARK} hello world ${PENDING_MARK}`);
    q.resolve(a, null);
    q.resolve(c, null);
    expect(q.take()).toBe("hello world");
    expect(q.interim()).toBe(PENDING_MARK);
    q.resolve(d, "");
    expect(q.take()).toBe("");
    q.partial(a, "gone");
    expect(q.interim()).toBe("");
  });

  it("joins with a space, except between CJK characters", () => {
    expect(joinText("hello", "world")).toBe("hello world");
    expect(joinText("你好", "世界")).toBe("你好世界");
    expect(joinText("你好", "world")).toBe("你好 world");
    expect(joinText("", " x ")).toBe("x");
    expect(joinText("a\n", "b")).toBe("a\nb");
    expect(joinText("a", "  ")).toBe("a");
  });

  it("merges overlapping chunk transcripts once", () => {
    expect(mergeOverlap("", "the quick")).toBe("the quick");
    expect(mergeOverlap("the quick brown", "Brown fox jumps")).toBe("the quick brown fox jumps");
    expect(mergeOverlap("one two three", "two three four")).toBe("one two three four");
    expect(mergeOverlap("one two", "three four")).toBe("one two three four");
    expect(mergeOverlap("今日はいい天気", "天気ですね")).toBe("今日はいい天気ですね");
    expect(mergeOverlap("hello, world.", "World! again")).toBe("hello, world. again");
    expect(mergeOverlap("a b", "a b")).toBe("a b");
    // Punctuation alone is no overlap.
    expect(mergeOverlap("wait …", "… what")).toBe("wait … … what");
  });
});

describe("audio helpers", () => {
  it("encodeWav writes a 16-bit mono WAV header and clamps samples", () => {
    const w = encodeWav(new Float32Array([0, 1, -1, 2]));
    const v = new DataView(w.buffer);
    expect(new TextDecoder().decode(w.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(w.slice(8, 12))).toBe("WAVE");
    expect(new TextDecoder().decode(w.slice(36, 40))).toBe("data");
    expect(v.getUint32(4, true)).toBe(36 + 8);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint32(28, true)).toBe(32_000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((i) => v.getInt16(44 + i * 2, true))).toEqual([
      0, 32767, -32768, 32767,
    ]);
    expect(new DataView(encodeWav(new Float32Array(0), 8000).buffer).getUint32(24, true)).toBe(
      8000,
    );
  });

  it("resample and rms", () => {
    expect(resample(new Float32Array([1, 2]), 16_000, 16_000)).toEqual(new Float32Array([1, 2]));
    expect(Array.from(resample(new Float32Array([0, 2, 4, 6]), 32_000, 16_000))).toEqual([0, 4]);
    expect(resample(new Float32Array([1]), 48_000, 16_000).length).toBe(1);
    expect(resample(new Float32Array(4800), 48_000, 16_000).length).toBe(1600);
    expect(rms(new Float32Array([3, -3]))).toBe(3);
    expect(rms(new Float32Array([]))).toBe(0);
  });

  it("energyGate: start after two loud frames, end after the hang, too short = misfire", () => {
    const g = energyGate({ rate: 1000, hangMs: 20, minMs: 30 });
    const loud = new Float32Array(10).fill(0.5);
    const quiet = new Float32Array(10);
    expect(g.push(quiet)).toBeNull();
    expect(g.push(loud)).toBeNull();
    expect(g.push(loud)).toBe("start");
    expect(g.push(loud)).toBeNull();
    expect(g.push(quiet)).toBeNull();
    const out = g.push(quiet);
    expect(out instanceof Float32Array && out.length).toBe(50);
    expect(g.flush()).toBeNull();
    g.push(loud);
    g.push(loud);
    expect(g.flush()).toBe("misfire");
    g.push(loud);
    expect(g.push(loud)).toBe("start");
    g.push(loud);
    expect(g.flush()).toBeInstanceOf(Float32Array);
    // A sound between `off` and `on` neither starts speech nor ends it.
    const mid = new Float32Array(10).fill(0.015);
    const h = energyGate({ rate: 1000, hangMs: 20 });
    expect(h.push(mid)).toBeNull();
    expect(h.push(mid)).toBeNull();
    h.push(loud);
    h.push(loud);
    for (let i = 0; i < 5; i++) expect(h.push(mid)).toBeNull();
    // Defaults
    const d = energyGate({ rate: 16_000 });
    expect(d.push(new Float32Array(160))).toBeNull();
  });
});

/** A VAD driven by the test, recording what the mic asked of it. */
function fakeVad() {
  const did: string[] = [];
  let ev: VadEvents | null = null;
  const factory = async (e: VadEvents) => {
    ev = e;
    return {
      start: () => void did.push("start"),
      pause: () => void did.push("pause"),
      flush: () => void did.push("flush"),
      destroy: () => void did.push("destroy"),
    };
  };
  return { did, factory, ev: () => ev as unknown as VadEvents };
}

type Up = UploadInfo & {
  samples: number;
  resolve: (t: string) => void;
  reject: (e: unknown) => void;
};

function harness(over: Partial<Parameters<typeof createMic>[0]> = {}) {
  const v = fakeVad();
  const states: MicState[] = [];
  const texts: string[] = [];
  const pending: [number, string][] = [];
  const errors: unknown[] = [];
  const timers: { f: () => void; ms: number; live: boolean }[] = [];
  const uploads: Up[] = [];
  const mic = createMic({
    load: v.factory,
    upload: (wav, info) =>
      new Promise((resolve, reject) =>
        uploads.push({ ...info, samples: (wav.length - 44) / 2, resolve, reject }),
      ),
    onState: (s) => states.push(s),
    onText: (t) => texts.push(t),
    onPending: (n, t) => pending.push([n, t]),
    onError: (e) => errors.push(e),
    setTimer: (f, ms) => {
      const t = { f, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) (t as { live: boolean }).live = false;
    },
    ...over,
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  /** Speech: `sec` seconds of 0.1 s frames. */
  const speak = (sec: number) => {
    for (let i = 0; i < Math.round(sec * 10); i++) v.ev().onFrame?.(new Float32Array(RATE / 10));
  };
  return { v, mic, states, texts, pending, errors, timers, uploads, tick, speak };
}

describe("createMic: listening mode", () => {
  it("tap on → loading → listening; speech → capturing → listening; tap off", async () => {
    const h = harness();
    await h.mic.toggle();
    expect(h.states).toEqual(["loading", "listening"]);
    h.v.ev().onSpeechStart();
    expect(h.mic.state()).toBe("capturing");
    h.v.ev().onSpeechEnd(new Float32Array(16_000));
    expect(h.mic.state()).toBe("listening");
    expect(h.uploads[0]).toMatchObject({ seq: 0, durationMs: 1000, partial: false });
    expect(h.pending.at(-1)).toEqual([1, PENDING_MARK]);
    h.v.ev().onSpeechStart();
    h.v.ev().onMisfire();
    expect(h.mic.state()).toBe("listening");
    h.v.ev().onMisfire(); // not capturing: no state change
    await h.mic.toggle();
    expect(h.mic.state()).toBe("off");
    expect(h.v.did).toEqual(["start", "flush", "destroy"]);
    await h.mic.off(); // already off: nothing
    expect(h.v.did).toEqual(["start", "flush", "destroy"]);
  });

  it("utterances upload in parallel; text arrives in the order spoken", async () => {
    const h = harness();
    await h.mic.toggle();
    for (let i = 0; i < 3; i++) {
      h.v.ev().onSpeechStart();
      h.v.ev().onSpeechEnd(new Float32Array(160));
    }
    expect(h.uploads).toHaveLength(3);
    expect(h.pending.at(-1)?.[0]).toBe(3);
    h.uploads[1]!.resolve("世界");
    await h.tick();
    expect(h.texts).toEqual([]);
    expect(h.pending.at(-1)).toEqual([3, `${PENDING_MARK} 世界 ${PENDING_MARK}`]);
    h.uploads[0]!.resolve("你好");
    await h.tick();
    expect(h.texts).toEqual(["你好世界"]);
    h.uploads[2]!.reject(new SttError(502, "bad gateway"));
    await h.tick();
    expect(h.texts).toEqual(["你好世界"]);
    expect(h.errors).toEqual([new SttError(502, "bad gateway")]);
    expect(h.pending.at(-1)).toEqual([0, ""]);
    expect(h.mic.state()).toBe("listening");
  });

  it("a 401 turns listening off; a 429 keeps it on and is reported", async () => {
    const h = harness();
    await h.mic.toggle();
    h.v.ev().onSpeechStart();
    h.v.ev().onSpeechEnd(new Float32Array(160));
    h.uploads[0]!.reject(new SttError(429, "slow down"));
    await h.tick();
    expect(h.mic.state()).toBe("listening");
    h.v.ev().onSpeechStart();
    h.v.ev().onSpeechEnd(new Float32Array(160));
    h.uploads[1]!.reject(new SttError(401, "guest"));
    await h.tick();
    expect(h.mic.state()).toBe("off");
    expect((h.errors as SttError[]).map((e) => e.status)).toEqual([429, 401]);
  });

  it("an utterance over 30 s is cut by the cap; a new start re-arms it", async () => {
    const h = harness();
    await h.mic.toggle();
    h.v.ev().onSpeechStart();
    expect(h.timers.at(-1)?.ms).toBe(MAX_UTTERANCE_MS);
    h.timers.at(-1)?.f();
    expect(h.v.did).toContain("flush");
    h.v.ev().onSpeechEnd(new Float32Array(160));
    expect(h.timers.every((t) => !t.live)).toBe(true);
  });

  it("falls back when the VAD cannot load; reports when neither can", async () => {
    const fb = fakeVad();
    const h = harness({
      load: async () => {
        throw new Error("wasm blocked");
      },
      fallback: fb.factory,
    });
    await h.mic.toggle();
    expect(h.mic.state()).toBe("listening");
    expect(fb.did).toEqual(["start"]);
    const none = harness({
      load: async () => {
        throw new Error("wasm blocked");
      },
    });
    await none.mic.toggle();
    expect(none.mic.state()).toBe("off");
    expect(none.errors).toEqual([new Error("wasm blocked")]);
    const both = harness({
      load: async () => {
        throw new Error("a");
      },
      fallback: async () => {
        throw new Error("no mic");
      },
    });
    await both.mic.toggle();
    expect(both.mic.state()).toBe("off");
    expect(both.errors).toEqual([new Error("no mic")]);
  });

  it("a refused mic does not try the fallback", async () => {
    let tried = false;
    const h = harness({
      load: async () => {
        throw domErr("NotAllowedError");
      },
      fallback: async () => {
        tried = true;
        throw new Error("never");
      },
    });
    await h.mic.toggle();
    expect(tried).toBe(false);
    expect(h.mic.state()).toBe("off");
    expect(micErrorNote(h.errors[0])).toBe("Microphone permission denied");
  });

  it("turned off while loading: the late VAD is destroyed, never started", async () => {
    let release: () => void = () => {};
    const v = fakeVad();
    const h = harness({
      load: (e) => new Promise((r) => (release = () => r(v.factory(e)))),
    });
    const going = h.mic.toggle();
    await h.mic.off();
    release();
    await going;
    expect(v.did).toEqual(["destroy"]);
    expect(h.mic.state()).toBe("off");
    // Events from a stale VAD change nothing.
    v.ev().onSpeechStart();
    v.ev().onMisfire();
    v.ev().onFrame?.(new Float32Array(RATE * 4));
    expect(h.mic.state()).toBe("off");
    expect(h.uploads).toEqual([]);
    // …except a stale utterance, which is still transcribed.
    v.ev().onSpeechEnd(new Float32Array(160));
    expect(h.uploads).toHaveLength(1);
  });

  it("a load failure after off is not reported as state", async () => {
    let fail: () => void = () => {};
    const h = harness({
      load: () => new Promise((_, rej) => (fail = () => rej(new Error("late")))),
    });
    const going = h.mic.toggle();
    await h.mic.off();
    fail();
    await going;
    expect(h.states).toEqual(["loading", "off"]);
    const h2 = harness({
      load: () => new Promise((_, rej) => (fail = () => rej(new Error("late")))),
      fallback: async () => {
        throw new Error("late too");
      },
    });
    const g2 = h2.mic.toggle();
    await h2.mic.off();
    fail();
    await g2;
    expect(h2.states).toEqual(["loading", "off"]);
  });

  it("uses real timers when none are given", async () => {
    const v = fakeVad();
    const mic = createMic({
      load: v.factory,
      upload: async () => "x",
      onState: () => {},
      onText: () => {},
      onPending: () => {},
    });
    await mic.toggle();
    v.ev().onSpeechStart();
    v.ev().onSpeechEnd(new Float32Array(1));
    v.ev().onSpeechStart();
    await mic.off();
    expect(mic.state()).toBe("off");
  });
});

describe("createMic: rolling partials", () => {
  it("no partial before 3 s; then ~every 2.5 s, overlapping by 1.5 s, merged and replaced", async () => {
    const h = harness();
    await h.mic.toggle();
    h.v.ev().onSpeechStart();
    h.speak(2.9);
    expect(h.uploads).toEqual([]);
    h.speak(0.1); // 3.0 s heard, 3.0 s since the start
    expect(h.uploads[0]).toMatchObject({ seq: 0, partial: true, durationMs: 3000 });
    expect(h.pending.at(-1)).toEqual([1, PENDING_MARK]);
    h.speak(3); // one in flight: no second partial yet
    expect(h.uploads).toHaveLength(1);
    h.uploads[0]!.resolve("the quick brown");
    await h.tick();
    expect(h.pending.at(-1)).toEqual([1, "the quick brown"]);
    h.speak(0.1); // 3.1 s since the last partial: a chunk of 3.1 + 1.5 s
    expect(h.uploads[1]).toMatchObject({ seq: 0, partial: true, durationMs: 4600 });
    h.uploads[1]!.resolve("brown fox jumps");
    await h.tick();
    expect(h.pending.at(-1)).toEqual([1, "the quick brown fox jumps"]);
    // The end: the final goes out under the same seq and replaces the partial.
    h.v.ev().onSpeechEnd(new Float32Array(RATE * 6));
    expect(h.uploads[2]).toMatchObject({ seq: 0, partial: false, durationMs: 6000 });
    h.uploads[2]!.resolve("The quick brown fox jumps over.");
    await h.tick();
    expect(h.texts).toEqual(["The quick brown fox jumps over."]);
    expect(h.pending.at(-1)).toEqual([0, ""]);
  });

  it("frames outside a capture are not kept", async () => {
    const h = harness();
    await h.mic.toggle();
    h.speak(10);
    expect(h.uploads).toEqual([]);
  });

  it("a 429 on a partial stops partials until listening is turned on again", async () => {
    const h = harness();
    await h.mic.toggle();
    h.v.ev().onSpeechStart();
    h.speak(3);
    h.uploads[0]!.reject(new SttError(429, "slow"));
    await h.tick();
    h.speak(5);
    expect(h.uploads).toHaveLength(1);
    expect(h.errors).toEqual([]); // partials fail quietly
    h.v.ev().onSpeechEnd(new Float32Array(RATE));
    expect(h.uploads[1]).toMatchObject({ seq: 0, partial: false });
    await h.mic.off();
    await h.mic.toggle();
    h.v.ev().onSpeechStart();
    h.speak(3);
    expect(h.uploads.at(-1)).toMatchObject({ partial: true });
  });

  it("a 401 on a partial turns listening off; other partial errors are quiet", async () => {
    const h = harness();
    await h.mic.toggle();
    h.v.ev().onSpeechStart();
    h.speak(3);
    h.uploads[0]!.reject(new SttError(500, "x"));
    await h.tick();
    expect(h.mic.state()).toBe("capturing");
    h.speak(2.5);
    h.uploads[1]!.reject(new SttError(401, "guest"));
    await h.tick();
    await h.tick();
    expect(h.mic.state()).toBe("off");
    expect(h.errors).toEqual([new SttError(401, "guest")]);
  });

  it("a misfire after a partial drops its seq, so later text is not held up", async () => {
    const h = harness();
    await h.mic.toggle();
    h.v.ev().onSpeechStart();
    h.speak(3);
    h.v.ev().onMisfire();
    expect(h.pending.at(-1)).toEqual([0, ""]);
    h.uploads[0]!.resolve("noise");
    await h.tick();
    expect(h.pending.at(-1)).toEqual([0, ""]);
    h.v.ev().onSpeechStart();
    h.v.ev().onSpeechEnd(new Float32Array(160));
    h.uploads[1]!.resolve("next");
    await h.tick();
    expect(h.texts).toEqual(["next"]);
  });

  it("turning off mid-utterance: the flushed speech is sent, the reserved seq dropped", async () => {
    const h = harness();
    const v = h.v;
    await h.mic.toggle();
    v.ev().onSpeechStart();
    h.speak(3);
    const ev = v.ev();
    const offing = h.mic.off();
    // The VAD's flush submits the speech under way (stale generation by now).
    ev.onSpeechEnd(new Float32Array(RATE * 3));
    await offing;
    expect(h.uploads.map((u) => [u.seq, u.partial])).toEqual([
      [0, true],
      [1, false],
    ]);
    h.uploads[1]!.resolve("said before off");
    await h.tick();
    expect(h.texts).toEqual(["said before off"]);
    expect(h.pending.at(-1)).toEqual([0, ""]);
  });

  it("partials: false sends finals only", async () => {
    const h = harness({ partials: false });
    await h.mic.toggle();
    h.v.ev().onSpeechStart();
    h.speak(10);
    expect(h.uploads).toEqual([]);
  });
});

/** A fetch that records its calls and answers with `status` and `body`. */
function fakeFetch(status: number, body: unknown, bad = false) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (bad) throw new Error("offline");
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("postStt: the host's STT endpoint", () => {
  it("posts the raw audio with its type to the given URL; returns the endpoint's answer", async () => {
    const { f, calls } = fakeFetch(200, { text: "hi", model: "m", ms: 12, language: "en" });
    const wav = encodeWav(new Float32Array(4));
    expect(await postStt(wav, "/api/stt", f)).toEqual({
      text: "hi",
      model: "m",
      ms: 12,
      language: "en",
    });
    expect(calls[0]!.url).toBe("/api/stt");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe(wav as unknown as BodyInit);
    expect(calls[0]!.init.credentials).toBe("same-origin");
    expect((calls[0]!.init.headers as Record<string, string>)["content-type"]).toBe("audio/wav");
    const empty = fakeFetch(200, {});
    expect(
      await postStt(
        wav,
        {
          url: "https://stt.example/v1?x=1",
          lang: "ja",
          type: "audio/webm",
          headers: { authorization: "Bearer k" },
          credentials: "include",
        },
        empty.f,
      ),
    ).toEqual({ text: "" });
    const c = empty.calls[0]!;
    expect(c.url).toBe("https://stt.example/v1?x=1&lang=ja");
    expect(c.init.credentials).toBe("include");
    expect(c.init.headers).toEqual({ "content-type": "audio/webm", authorization: "Bearer k" });
    // A non-string text is no text.
    expect(await postStt(wav, "/s", fakeFetch(200, { text: 3 }).f)).toEqual({ text: "" });
  });

  it("sttUrl adds the language hint to the query, before any hash", () => {
    expect(sttUrl("/api/stt")).toBe("/api/stt");
    expect(sttUrl("/api/stt", "zh-CN")).toBe("/api/stt?lang=zh-CN");
    expect(sttUrl("/api/stt?m=a", "en")).toBe("/api/stt?m=a&lang=en");
    expect(sttUrl("/api/stt#x", "en")).toBe("/api/stt?lang=en#x");
  });

  it("throws SttError with the status (and the endpoint's message, if any)", async () => {
    const wav = encodeWav(new Float32Array(1));
    const e1 = await postStt(wav, "/s", fakeFetch(429, { error: "rate limited" }).f).catch(
      (e) => e,
    );
    expect(e1).toBeInstanceOf(SttError);
    expect([e1.status, e1.message]).toEqual([429, "rate limited"]);
    const e2 = await postStt(wav, "/s", fakeFetch(401, "not json").f).catch((e) => e);
    expect([e2.status, e2.message]).toEqual([401, "stt 401"]);
  });

  it("error notes can be translated", () => {
    const t = { ...MIC_ERROR_STRINGS_EN, failed: "失败 ({status})" };
    expect(micErrorNote(new SttError(500, "x"), t)).toBe("失败 (500)");
    expect(micErrorNote(new Error("x"), { other: "麦克风: {message}" })).toBe("麦克风: x");
  });
});

describe("isDictationBurst: typed text that arrived at once", () => {
  it("3+ characters at once ending a sentence is dictation; typing a character at a time is not", () => {
    expect(isDictationBurst(0, "Ok.")).toBe(true);
    expect(isDictationBurst(5, "hello world.")).toBe(true);
    expect(isDictationBurst(10, "hello world.")).toBe(false); // 2 new characters
    expect(isDictationBurst(0, "はい。")).toBe(true);
    expect(isDictationBurst(0, "これは？ ")).toBe(true); // trailing space trimmed
    expect(isDictationBurst(0, "no stop")).toBe(false);
    expect(isDictationBurst(11, "hello world.")).toBe(false); // one key
  });
});

describe("appendDictation: spoken finals are punctuated and committed", () => {
  it("adds a fitting stop when the transcript lacks one", () => {
    expect(punctuate("Fix the swipe please")).toBe("Fix the swipe please.");
    expect(punctuate("what time is it")).toBe("what time is it?");
    expect(punctuate("Is it done")).toBe("Is it done?");
    expect(punctuate("这个按钮太小了")).toBe("这个按钮太小了。");
    expect(punctuate("好了吗")).toBe("好了吗？");
    expect(punctuate("これは何ですか")).toBe("これは何ですか？");
    expect(punctuate("スワイプを直して")).toBe("スワイプを直して。");
    expect(punctuate("Already done.")).toBe("Already done.");
    expect(punctuate("待って…")).toBe("待って…");
    expect(punctuate("  ")).toBe("");
  });

  it("every final with words is sent at once, short replies too", () => {
    expect(appendDictation("", "好")).toEqual({ draft: "好。", send: true });
    expect(appendDictation("", "OK")).toEqual({ draft: "OK.", send: true });
    expect(appendDictation("", "Fix the swipe please.")).toEqual({
      draft: "Fix the swipe please.",
      send: true,
    });
    expect(appendDictation("typed so far", "and spoken")).toEqual({
      draft: "typed so far and spoken.",
      send: true,
    });
    expect(appendDictation("draft", "  ")).toEqual({ draft: "draft", send: false });
    expect(appendDictation("", "。").send).toBe(false); // punctuation only: nothing said
    expect(AUTO_SEND_MIN).toBe(3); // still the typed-burst rule
    expect(["。", "．", ".", "!", "?", "！", "？"].every((c) => ENDS_SENTENCE.test(`a${c}`))).toBe(
      true,
    );
  });

  it("with the fake STT: only finals reach the draft, each punctuated and sent", async () => {
    const sent: string[] = [];
    let draft = "";
    const h = harness({
      onText: (t) => {
        const r = appendDictation(draft, t);
        draft = r.draft;
        if (r.send) {
          sent.push(draft);
          draft = "";
        }
      },
    });
    await h.mic.toggle();
    h.v.ev().onSpeechStart();
    h.speak(3);
    h.uploads[0]!.resolve("Please make the button."); // a partial: never sent
    await h.tick();
    expect(sent).toEqual([]);
    h.v.ev().onSpeechEnd(new Float32Array(RATE * 3));
    h.uploads[1]!.resolve("Please make the button bigger");
    await h.tick();
    // Each final is punctuated and committed at once, even without a stop.
    expect([sent, draft]).toEqual([["Please make the button bigger."], ""]);
    h.v.ev().onSpeechStart();
    h.v.ev().onSpeechEnd(new Float32Array(RATE));
    h.uploads[2]!.resolve("好");
    await h.tick();
    expect([sent, draft]).toEqual([["Please make the button bigger.", "好。"], ""]);
  });
});

describe("createMic: hold while the agent speaks", () => {
  it("capture is paused and dropped, then resumes; speech begun before the hold is dropped", async () => {
    const h = harness();
    await h.mic.toggle();
    h.v.ev().onSpeechStart();
    h.speak(4); // long enough for a partial
    expect(h.uploads.filter((u) => u.partial)).toHaveLength(1);
    h.mic.hold(true);
    expect(h.mic.held()).toBe(true);
    expect(h.mic.state()).toBe("listening");
    await h.tick();
    expect(h.v.did.at(-1)).toBe("pause");
    // The VAD's submit-on-pause, and anything it hears while held: dropped.
    h.v.ev().onSpeechEnd(new Float32Array(RATE));
    h.v.ev().onSpeechStart();
    h.speak(5);
    h.v.ev().onSpeechEnd(new Float32Array(RATE));
    expect(h.mic.state()).toBe("listening");
    expect(h.uploads.filter((u) => !u.partial)).toHaveLength(0);
    expect(h.uploads.filter((u) => u.partial)).toHaveLength(1); // partials stopped too
    h.mic.hold(false);
    await h.tick();
    expect(h.v.did.at(-1)).toBe("start");
    // A late submit from before the hold (no fresh start): still dropped.
    h.v.ev().onSpeechEnd(new Float32Array(RATE));
    expect(h.uploads.filter((u) => !u.partial)).toHaveLength(0);
    // New speech after the hold is heard as usual.
    h.v.ev().onSpeechStart();
    expect(h.mic.state()).toBe("capturing");
    h.v.ev().onSpeechEnd(new Float32Array(RATE));
    expect(h.uploads.filter((u) => !u.partial)).toHaveLength(1);
    // The partial's reserved seq was released: the queue does not wait on it.
    h.uploads.at(-1)?.resolve("hello");
    await h.tick();
    expect(h.texts).toEqual(["hello"]);
  });

  it("held when turned on: the VAD is not started until the hold ends", async () => {
    const h = harness();
    h.mic.hold(true);
    await h.mic.toggle();
    expect(h.mic.state()).toBe("listening");
    expect(h.v.did).toEqual([]);
    h.mic.hold(false);
    h.mic.hold(false); // no change
    await h.tick();
    expect(h.v.did).toEqual(["start"]);
  });

  it("micStatus shows the agent speaking only while listening; the user talking over it wins", () => {
    expect(micStatus("listening", 0, true)).toBe("speaking");
    expect(micStatus("capturing", 0, true)).toBe("capturing");
    expect(micStatus("off", 0, true)).toBe("idle");
    expect(micStatus("loading", 0, true)).toBe("loading");
    expect(micStatus("listening", 0, false)).toBe("listening");
  });
});

describe("scheduleTick: the voice-send sound", () => {
  it("schedules two sine oscillators through one gain with a fast attack and exponential decay", () => {
    const calls: string[] = [];
    const oscs: { type: string; hz: number; start: number; stop: number; to: unknown }[] = [];
    const gain = {
      gain: {
        setValueAtTime: (v: number, t: number) => calls.push(`set ${v} ${t}`),
        linearRampToValueAtTime: (v: number, t: number) => calls.push(`lin ${v} ${t}`),
        exponentialRampToValueAtTime: (v: number, t: number) => calls.push(`exp ${v} ${t}`),
      },
      connect: (n: unknown) => calls.push(`gain→${n}`),
    };
    const ctx = {
      currentTime: 10,
      destination: "out",
      createGain: () => gain,
      createOscillator: () => {
        const o = { type: "", hz: 0, start: -1, stop: -1, to: null as unknown };
        oscs.push(o);
        return {
          set type(v: string) {
            o.type = v;
          },
          get type() {
            return o.type;
          },
          frequency: { setValueAtTime: (v: number) => (o.hz = v) },
          connect: (n: unknown) => (o.to = n),
          start: (t: number) => void (o.start = t),
          stop: (t: number) => void (o.stop = t),
        };
      },
    };
    const end = scheduleTick(ctx);
    expect(end).toBeCloseTo(10 + TICK_MS / 1000);
    expect(TICK_MS).toBeGreaterThanOrEqual(60);
    expect(TICK_MS).toBeLessThanOrEqual(90);
    expect(calls).toEqual([
      "set 0.0001 10",
      `lin ${TICK_GAIN} 10.005`,
      `exp 0.0001 ${end}`,
      "gain→out",
    ]);
    expect(oscs.map((o) => [o.type, o.hz, o.to === gain, o.stop])).toEqual([
      ["sine", 880, true, end],
      ["sine", 1320, true, end],
    ]);
    expect(oscs[0]!.start).toBe(10);
    expect(oscs[1]!.start).toBeCloseTo(10.03);
  });
});
