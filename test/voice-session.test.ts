import { describe, expect, it } from "bun:test";
import { ECHO_WINDOW_MS } from "../src/echo.ts";
import {
  BARGE_IN_MS,
  BARGE_IN_PROB,
  CHUNK_MAX,
  DUCK_ATTACK_MS,
  DUCK_LEVEL,
  DUCK_RELEASE_MS,
  IDLE_RESUME_MS,
  RESUME_TAIL_MS,
  SPEAK_KEY,
  type UtterLike,
  chunk,
  createVoice,
  isBargeIn,
  sentences,
  speakHere,
  speechEnabled,
  type VoiceHook,
  pickNaturalVoice,
  voice,
  voiceQuality,
} from "../src/voice.ts";
import type { MicVoiceLink } from "../src/mic-session.ts";
import { RESUME_REWIND_S, createCloudOut, ttsUrlFrom } from "../src/voice-out.ts";

describe("sentences", () => {
  it("cuts Latin text after . ! ? before a space or the end, keeping 3.14 and e.g. whole", () => {
    expect(sentences("Hello there. How are you? Fine!")).toEqual([
      "Hello there.",
      "How are you?",
      "Fine!",
    ]);
    expect(sentences("Pi is 3.14 today, e.g.here. Done")).toEqual([
      "Pi is 3.14 today, e.g.here.",
      "Done",
    ]);
    expect(sentences('He said "stop." Then left...  ok?!')).toEqual([
      'He said "stop."',
      "Then left...",
      "ok?!",
    ]);
  });

  it("cuts CJK text after 。．！？ with no space needed, keeping closing brackets", () => {
    expect(sentences("今日は晴れです。散歩しますか？「はい。」行こう！")).toEqual([
      "今日は晴れです。",
      "散歩しますか？",
      "「はい。」",
      "行こう！",
    ]);
    expect(sentences("好的。我明白了")).toEqual(["好的。", "我明白了"]);
  });

  it("cuts at newlines and drops blank pieces", () => {
    expect(sentences("line one\n\n  line two\r\n- item")).toEqual([
      "line one",
      "line two",
      "- item",
    ]);
    expect(sentences("   \n ")).toEqual([]);
  });
});

/** speechSynthesis in memory: one utterance at a time is all the session ever gives it. */
function harness(o: { enabled?: boolean; here?: boolean } = {}) {
  const spoken: (UtterLike & { lang: string })[] = [];
  let cancels = 0;
  const flags = { enabled: o.enabled ?? true, here: o.here ?? false, synth: true };
  const timers: { f: () => void; ms: number; live: boolean }[] = [];
  const v = createVoice({
    synth: () =>
      flags.synth
        ? {
            speak: (u) => void spoken.push(u as UtterLike & { lang: string }),
            cancel: () => void cancels++,
          }
        : null,
    utter: (text, lang) =>
      ({ text, lang, onend: null, onerror: null, onboundary: null }) as UtterLike,
    enabled: () => flags.enabled,
    here: () => flags.here,
    setTimer: (f, ms) => {
      const t = { f, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) (t as { live: boolean }).live = false;
    },
  });
  /** Run the live timers of this length (one-shot). */
  const fire = (ms: number) => {
    for (const t of timers.filter((x) => x.live && x.ms === ms)) {
      t.live = false;
      t.f();
    }
  };
  const live = (ms: number) => timers.some((t) => t.live && t.ms === ms);
  const texts = () => spoken.map((u) => u.text);
  const end = () => spoken.at(-1)?.onend?.();
  const states: boolean[] = [];
  v.subscribe((s) => states.push(s.speaking));
  return { v, spoken, texts, end, fire, live, flags, timers, states, cancels: () => cancels };
}

describe("voice session: the focus rule (mic off)", () => {
  it("reads only with the speaker on and the input focused here", () => {
    const h = harness({ enabled: true, here: false });
    expect(h.v.reply("Not focused.")).toBe(false);
    h.flags.here = true;
    h.flags.enabled = false;
    expect(h.v.reply("Speaker off.")).toBe(false);
    h.flags.enabled = true;
    expect(h.v.reply("Read me.")).toBe(true);
    expect(h.texts()).toEqual(["Read me."]);
    expect(h.v.shouldSpeak()).toBe(true);
    h.flags.synth = false;
    expect(h.v.reply("No synth.")).toBe(false);
    h.flags.synth = true;
    expect(h.v.reply("  \n ")).toBe(false);
  });

  it("the mic overrides it, forcing the speaker on; the setting is back when the mic stops", () => {
    const h = harness({ enabled: false, here: false });
    expect(h.v.readAloud()).toBe(false);
    h.v.setMic(true);
    h.v.setMic(true); // no change
    expect(h.v.readAloud()).toBe(true);
    expect(h.v.shouldSpeak()).toBe(true);
    expect(h.v.reply("Hands free. Two sentences.")).toBe(true);
    expect(h.texts()).toEqual(["Hands free."]);
    // Mic off: the focus rule is back, so what it would not read stops.
    h.v.setMic(false);
    expect(h.v.readAloud()).toBe(false);
    expect(h.v.state()).toMatchObject({ mic: false, queued: 0, speaking: false });
    expect(h.cancels()).toBe(1);
    expect(h.v.reply("Silent again.")).toBe(false);
  });

  it("mic off while the focus rule holds: the reading goes on", () => {
    const h = harness({ enabled: true, here: true });
    h.v.setMic(true);
    h.v.reply("One. Two.");
    h.v.setMic(false);
    expect(h.v.state().queued).toBe(2);
    h.end();
    expect(h.texts()).toEqual(["One.", "Two."]);
  });
});

describe("voice session: the queue", () => {
  it("FIFO, one utterance per sentence; a new reply waits and never cuts one off", () => {
    const h = harness();
    h.v.setMic(true);
    h.v.reply("First one. Second one.");
    h.v.reply("今日は。");
    expect(h.texts()).toEqual(["First one."]);
    expect(h.cancels()).toBe(0);
    expect(h.v.state().queued).toBe(3);
    h.end();
    h.end();
    expect(h.texts()).toEqual(["First one.", "Second one.", "今日は。"]);
    // The language is the reply's, for each of its sentences.
    expect(h.spoken.map((u) => u.lang)).toEqual(["en-US", "en-US", "ja-JP"]);
    // A failed utterance (not ours) moves on rather than sticking.
    h.end();
    h.v.reply("A. B.");
    h.spoken.at(-1)?.onerror?.();
    expect(h.texts().at(-1)).toBe("B.");
  });

  it("stop() clears the queue (Stop reading)", () => {
    const h = harness();
    h.v.setMic(true);
    h.v.reply("One. Two. Three.");
    h.v.stop();
    expect(h.v.state()).toMatchObject({ queued: 0, speaking: false, paused: false });
    expect(h.cancels()).toBe(1);
    h.end(); // the cancelled utterance's late end: ignored
    expect(h.texts()).toEqual(["One."]);
  });
});

describe("voice session: holding the mic while the agent speaks", () => {
  it("mic on → TTS → held → end → released only after the tail", () => {
    const h = harness();
    h.v.setMic(true);
    h.v.reply("Hi. There.");
    expect(h.v.state().speaking).toBe(true);
    h.end(); // between sentences: still held, no tail
    expect(h.v.state().speaking).toBe(true);
    expect(h.live(RESUME_TAIL_MS)).toBe(false);
    h.end();
    expect(h.v.state().speaking).toBe(true);
    expect(h.live(RESUME_TAIL_MS)).toBe(true);
    h.fire(RESUME_TAIL_MS);
    expect(h.v.state().speaking).toBe(false);
    expect(h.states.at(-1)).toBe(false);
  });

  it("a reply arriving in the tail cancels it: held on", () => {
    const h = harness();
    h.v.setMic(true);
    h.v.reply("Hi.");
    h.end();
    h.v.reply("Again.");
    expect(h.live(RESUME_TAIL_MS)).toBe(false);
    h.fire(RESUME_TAIL_MS);
    expect(h.v.state().speaking).toBe(true);
    expect(h.texts()).toEqual(["Hi.", "Again."]);
  });

  it("a tap in the tail releases the mic at once", () => {
    const h = harness();
    h.v.setMic(true);
    h.v.reply("Hi.");
    h.end();
    h.v.interrupt("tap");
    expect(h.v.state()).toMatchObject({ speaking: false, paused: false });
    expect(h.live(RESUME_TAIL_MS)).toBe(false);
  });
});

describe("voice session: interruptions and resuming", () => {
  it("a tap (barge-in) releases the mic at once; it reads on after the idle", () => {
    const h = harness();
    h.v.setMic(true);
    h.v.reply("The quick brown fox jumps. Then rests.");
    h.v.interrupt("tap");
    expect(h.v.state()).toMatchObject({ speaking: false, paused: true, queued: 2 });
    expect(h.cancels()).toBe(1);
    expect(h.live(RESUME_TAIL_MS)).toBe(false);
    // The cancelled utterance's late error is ignored.
    h.spoken.at(-1)?.onerror?.();
    expect(h.texts()).toHaveLength(1);
    h.fire(IDLE_RESUME_MS);
    expect(h.v.state()).toMatchObject({ speaking: true, paused: false });
    // No boundary heard: from the start of the interrupted sentence.
    expect(h.texts()).toEqual(["The quick brown fox jumps.", "The quick brown fox jumps."]);
  });

  it("resumes at the last word boundary (fake boundary events), and again after a second cut", () => {
    const h = harness();
    h.v.setMic(true);
    h.v.reply("The quick brown fox jumps.");
    const u = h.spoken[0]!;
    u.onboundary?.({ charIndex: 4, name: "word" });
    u.onboundary?.({ charIndex: 10, name: "word" });
    u.onboundary?.({ charIndex: 20, name: "sentence" }); // not a word: ignored
    h.v.interrupt("tap");
    h.v.resume();
    expect(h.texts().at(-1)).toBe("brown fox jumps.");
    // Offsets of the resumed utterance count from where it began.
    h.spoken.at(-1)?.onboundary?.({ charIndex: 6 });
    h.v.interrupt("typing");
    h.v.resume();
    expect(h.texts().at(-1)).toBe("fox jumps.");
    // A boundary from a dropped utterance changes nothing.
    u.onboundary?.({ charIndex: 0, name: "word" });
    h.v.interrupt("tap");
    h.v.resume();
    expect(h.texts().at(-1)).toBe("fox jumps.");
  });

  it("the user starting to speak interrupts; their line ending resumes after the idle, a send at once", () => {
    const h = harness();
    h.v.setMic(true);
    h.v.reply("One. Two.");
    h.v.interrupt("speech");
    expect(h.v.state().paused).toBe(true);
    expect(h.live(IDLE_RESUME_MS)).toBe(false); // waits for the user to finish
    h.v.userIdle();
    expect(h.live(IDLE_RESUME_MS)).toBe(true);
    h.v.interrupt("speech"); // talking again: the idle is cancelled
    expect(h.live(IDLE_RESUME_MS)).toBe(false);
    h.v.userIdle();
    h.v.resume(); // the transcript was sent
    expect(h.live(IDLE_RESUME_MS)).toBe(false);
    expect(h.v.state()).toMatchObject({ paused: false, speaking: true });
    expect(h.texts()).toEqual(["One.", "One."]);
    // An idle with no speech pause arms nothing.
    h.v.userIdle();
    expect(h.live(IDLE_RESUME_MS)).toBe(false);
  });

  it("typing pauses until a send or blur; nothing to interrupt is a no-op", () => {
    const h = harness();
    h.v.setMic(true);
    h.v.interrupt("typing"); // empty queue
    expect(h.v.state().paused).toBe(false);
    h.v.reply("Hello.");
    h.v.interrupt("typing");
    expect(h.live(IDLE_RESUME_MS)).toBe(false);
    // A reply while paused queues behind and waits.
    h.v.reply("World.");
    expect(h.texts()).toEqual(["Hello."]);
    expect(h.v.state()).toMatchObject({ paused: true, queued: 2 });
    h.v.resume();
    expect(h.texts()).toEqual(["Hello.", "Hello."]);
    h.end();
    expect(h.texts().at(-1)).toBe("World.");
    h.v.resume(); // not paused: nothing
    expect(h.texts()).toHaveLength(3);
  });

  it("subscribers can unsubscribe", () => {
    const h = harness();
    const seen: number[] = [];
    const off = h.v.subscribe((s) => seen.push(s.queued));
    h.v.setMic(true);
    off();
    h.v.reply("Ignored by it.");
    expect(seen).toEqual([0]);
  });
});

describe("voice(): the browser session, shared on globalThis", () => {
  it("one session per page, reading through speechSynthesis with the speaker setting and focus", () => {
    const g = globalThis as Record<string, unknown>;
    const saved = Object.fromEntries(
      [
        "speechSynthesis",
        "SpeechSynthesisUtterance",
        "localStorage",
        "document",
        "__liagentVoice",
      ].map((k) => [k, g[k]]),
    );
    const spoken: (EventTarget & { text: string; lang: string; voice?: unknown })[] = [];
    let store: Record<string, string> | null = {};
    const doc = { visibilityState: "hidden" };
    try {
      g.SpeechSynthesisUtterance = class extends EventTarget {
        lang = "";
        voice: unknown;
        constructor(readonly text: string) {
          super();
        }
      };
      g.speechSynthesis = {
        getVoices: () => [{ lang: "ja-JP", name: "kyoko" }],
        speak: (u: (typeof spoken)[number]) => void spoken.push(u),
        cancel: () => {},
      };
      g.localStorage = {
        getItem: (k: string) => {
          if (!store) throw new Error("blocked");
          return store[k] ?? null;
        },
      };
      g.document = doc;
      delete g.__liagentVoice;
      const v = voice();
      expect(voice()).toBe(v);
      // Mic off, tab hidden: silent.
      expect(speakHere()).toBe(false);
      expect(v.reply("Nope.")).toBe(false);
      doc.visibilityState = "visible";
      expect(speakHere()).toBe(true);
      expect(speechEnabled()).toBe(true);
      expect(v.reply("こんにちは。")).toBe(true);
      expect(spoken[0]).toMatchObject({ text: "こんにちは。", lang: "ja-JP" });
      expect(spoken[0]!.voice).toMatchObject({ name: "kyoko" });
      spoken[0]!.dispatchEvent(new Event("end"));
      // The speaker off (or storage blocked: on), the tab hidden.
      store = { [SPEAK_KEY]: "0" };
      expect(speechEnabled()).toBe(false);
      store = null;
      expect(speechEnabled()).toBe(true);
      doc.visibilityState = "hidden";
      expect(speakHere()).toBe(false);
      // An older copy's session on the page is replaced by this version's.
      g.__liagentVoice = { v: 0 };
      expect(voice()).not.toBe(v);
    } finally {
      for (const [k, x] of Object.entries(saved)) {
        if (x === undefined) delete g[k];
        else g[k] = x;
      }
    }
  });
});

// ── Echo-cancelled barge-in: ducking, the barge-in judge, the cloud route ──

/** A GainNode in memory: its value follows each set or ramp at once; the calls are kept. */
function fakeGain() {
  const calls: [string, number, number][] = [];
  const gain = {
    value: 1,
    cancelScheduledValues: (t: number) => void calls.push(["cancel", 0, t]),
    setValueAtTime(v: number, t: number) {
      calls.push(["set", v, t]);
      gain.value = v;
    },
    linearRampToValueAtTime(v: number, t: number) {
      calls.push(["ramp", v, t]);
      gain.value = v;
    },
  };
  return { gain, calls, connect: (n: unknown) => n };
}

/** An <audio> element in memory: load() waits for the test to fire loadedmetadata. */
class FakeEl {
  src = "";
  currentTime = 0;
  volume = 1;
  preload = "";
  paused = true;
  refuse = false;
  plays: { src: string; at: number }[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  play() {
    if (this.refuse)
      return Promise.reject(Object.assign(new Error("no"), { name: "NotAllowedError" }));
    this.paused = false;
    this.plays.push({ src: this.src, at: this.currentTime });
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {
    this.currentTime = 0;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** The session with the real cloud output over fakes (fetch, element, AudioContext, GainNode). */
function cloudHarness(
  o: { aec?: boolean; mode?: "speech" | "cloud"; status?: (text: string) => number } = {},
) {
  const h0 = { t: 0 };
  const el = new FakeEl();
  const g = fakeGain();
  const ctx = {
    currentTime: 0,
    destination: {},
    resume: () => Promise.resolve(),
    createGain: () => g,
    createMediaElementSource: () => ({ connect: (n: unknown) => n }),
  };
  const fetched: string[] = [];
  const cloud = createCloudOut({
    url: () => ttsUrlFrom("/api/tts"),
    fetch: async (url) => {
      fetched.push(url);
      const text = new URL(url, "https://x").searchParams.get("text") ?? "";
      const status = o.status?.(text) ?? 200;
      return {
        ok: status === 200,
        status,
        headers: { get: (k: string) => (k === "X-Voice" && status === 404 ? "miss" : null) },
        blob: async () => new Blob([text]),
      };
    },
    element: () => el,
    ctx: () => ctx,
    toUrl: (b) => `blob:${(b as Blob).size}`,
    revoke: () => {},
  });
  const spoken: (UtterLike & { lang: string })[] = [];
  let cancels = 0;
  const timers: { f: () => void; ms: number; live: boolean }[] = [];
  const logs: Record<string, unknown>[] = [];
  const flags = { aec: o.aec ?? true, mode: o.mode ?? "cloud" };
  const v = createVoice({
    synth: () => ({
      speak: (u) => void spoken.push(u as UtterLike & { lang: string }),
      cancel: () => void cancels++,
    }),
    utter: (text, lang) =>
      ({ text, lang, onend: null, onerror: null, onboundary: null }) as UtterLike,
    enabled: () => true,
    here: () => false,
    cloud: () => cloud,
    mode: () => flags.mode,
    aec: () => flags.aec,
    now: () => h0.t,
    log: (e) => void logs.push(e),
    setTimer: (f, ms) => {
      const t = { f, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) (t as { live: boolean }).live = false;
    },
  });
  const fire = (ms: number) => {
    for (const t of timers.filter((x) => x.live && x.ms === ms)) {
      t.live = false;
      t.f();
    }
  };
  const live = (ms: number) => timers.some((t) => t.live && t.ms === ms);
  /** Let the fetch settle and the clip's metadata arrive. */
  const loaded = async () => {
    await tick();
    el.onloadedmetadata?.();
    await tick();
  };
  return {
    v,
    el,
    g,
    ctx,
    fetched,
    spoken,
    logs,
    fire,
    live,
    flags,
    h0,
    loaded,
    cancels: () => cancels,
  };
}

describe("voice session: chunks and the barge-in judge", () => {
  it("cuts a sentence over CHUNK_MAX after a clause mark, else a space, else hard", () => {
    expect(chunk("short one.")).toEqual(["short one."]);
    const long = `${"a".repeat(50)}, ${"b ".repeat(80)}end.`;
    const parts = chunk(long, CHUNK_MAX);
    expect(parts.every((p) => p.length <= CHUNK_MAX)).toBe(true);
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe(long.replace(/\s+/g, " "));
    expect(chunk("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
    expect(chunk("一二三四五、六七八九十一二三四五", 10)).toEqual([
      "一二三四五、",
      "六七八九十一二三四五",
    ]);
    expect(chunk("aaaa bbbb cccc dddd", 10)).toEqual(["aaaa bbbb", "cccc dddd"]);
  });

  it("a barge-in needs the VAD's mean probability over BARGE_IN_PROB (none known: yes)", () => {
    expect(isBargeIn([])).toBe(true);
    expect(isBargeIn([0.9, 0.95, 0.8])).toBe(true);
    expect(isBargeIn([0.55, 0.6, 0.5])).toBe(false);
    expect(isBargeIn([BARGE_IN_PROB])).toBe(true);
  });
});

describe("voice session: ducking and barge-in (cloud route, fake GainNode)", () => {
  it("duck → restore: the user's voice ducks the clip over DUCK_ATTACK_MS, and its end restores it", async () => {
    const h = cloudHarness();
    h.v.setMic(true);
    h.v.reply("The first sentence. The second one.");
    await h.loaded();
    expect(h.el.plays).toHaveLength(1);
    expect(h.g.gain.value).toBe(1);
    expect(h.v.state()).toMatchObject({ speaking: true, hold: false, ducked: false });
    h.ctx.currentTime = 2;
    h.v.userSpeech();
    expect(h.g.calls.at(-1)).toEqual(["ramp", DUCK_LEVEL, 2 + DUCK_ATTACK_MS / 1000]);
    expect(h.v.state()).toMatchObject({ ducked: true, paused: false, speaking: true });
    expect(h.el.paused).toBe(false); // keeps playing, quieter
    expect(h.live(BARGE_IN_MS)).toBe(true);
    h.ctx.currentTime = 2.5;
    h.v.userIdle(); // speech end before BARGE_IN_MS
    expect(h.g.calls.at(-1)).toEqual(["ramp", 1, 2.5 + DUCK_RELEASE_MS / 1000]);
    expect(h.v.state()).toMatchObject({ ducked: false, paused: false });
    expect(h.live(BARGE_IN_MS)).toBe(false);
    expect(h.live(IDLE_RESUME_MS)).toBe(false);
    expect(h.logs.some((l) => l.ev === "voice-duck" && l.route === "audio")).toBe(true);
  });

  it("duck → sustained → hard-pause, and the clip resumes by its offset", async () => {
    const h = cloudHarness();
    h.v.setMic(true);
    h.v.reply("The first sentence. The second one.");
    await h.loaded();
    h.v.userSpeech();
    for (const p of [0.9, 0.85, 0.95]) h.v.userFrame(p);
    h.el.currentTime = 1.8;
    h.fire(BARGE_IN_MS);
    expect(h.el.paused).toBe(true);
    expect(h.v.state()).toMatchObject({ paused: true, ducked: false, speaking: false, queued: 2 });
    expect(h.logs.find((l) => l.ev === "voice-barge-in")?.prob).toBeCloseTo(0.9, 5);
    // The user finishes: read on after the idle, from where the clip stopped (less the rewind), at full volume.
    h.v.userIdle();
    h.fire(IDLE_RESUME_MS);
    await h.loaded();
    expect(h.el.plays.at(-1)?.at).toBeCloseTo(1.8 - RESUME_REWIND_S, 5);
    expect(h.g.gain.value).toBe(1);
    expect(h.fetched).toHaveLength(2); // the 1st sentence once (cached), the 2nd prefetched
    // Ends: on to the next sentence, from its start.
    h.el.onended?.();
    await h.loaded();
    expect(h.el.plays.at(-1)).toMatchObject({ at: 0 });
    expect(h.el.src).toBe(`blob:${"The second one.".length}`);
  });

  it("weak speech (likely echo) stays ducked and is judged again; a later strong window barges in", async () => {
    const h = cloudHarness();
    h.v.setMic(true);
    h.v.reply("Hello there.");
    await h.loaded();
    h.v.userSpeech();
    for (const p of [0.55, 0.6]) h.v.userFrame(p);
    h.fire(BARGE_IN_MS);
    expect(h.v.state()).toMatchObject({ ducked: true, paused: false });
    expect(h.live(BARGE_IN_MS)).toBe(true);
    expect(h.logs.some((l) => l.ev === "voice-duck-hold")).toBe(true);
    h.v.userSpeech(); // a second start while ducked: no second duck
    expect(h.logs.filter((l) => l.ev === "voice-duck")).toHaveLength(1);
    h.v.userFrame(0.9);
    h.fire(BARGE_IN_MS);
    expect(h.v.state()).toMatchObject({ ducked: false, paused: true });
  });

  it("a tap or Stop reading while ducked ends the duck", async () => {
    const h = cloudHarness();
    h.v.setMic(true);
    h.v.reply("One. Two.");
    await h.loaded();
    h.v.userSpeech();
    h.v.interrupt("tap");
    expect(h.v.state()).toMatchObject({ ducked: false, paused: true });
    h.v.resume();
    await h.loaded();
    h.v.userSpeech();
    h.v.stop();
    expect(h.v.state()).toMatchObject({ ducked: false, queued: 0, speaking: false });
  });

  it("speech mode: the duck applies from the next sentence (iOS cannot change an utterance's volume)", () => {
    const h = cloudHarness({ mode: "speech" });
    h.v.setMic(true);
    h.v.reply("One. Two. Three.");
    expect(h.spoken[0]!.volume).toBeUndefined();
    h.v.userSpeech();
    expect(h.v.state().ducked).toBe(true);
    h.spoken[0]!.onend?.();
    expect(h.spoken[1]!.volume).toBe(DUCK_LEVEL);
    h.v.userIdle();
    h.spoken[1]!.onend?.();
    expect(h.spoken[2]!.volume).toBeUndefined();
    expect(h.v.mode()).toBe("speech");
    expect(h.logs[0]).toMatchObject({ ev: "voice-out", out: "speech", route: "speech" });
  });

  it("speech mode: sustained speech pauses at the last word boundary", () => {
    const h = cloudHarness({ mode: "speech" });
    h.v.setMic(true);
    h.v.reply("The quick brown fox.");
    h.spoken[0]!.onboundary?.({ charIndex: 10, name: "word" });
    h.v.userSpeech();
    h.fire(BARGE_IN_MS);
    expect(h.cancels()).toBe(1);
    h.v.resume();
    expect(h.spoken.at(-1)?.text).toBe("brown fox.");
  });

  it("aec off: the old way — capture held while the agent speaks, user speech pauses at once", () => {
    const h = cloudHarness({ mode: "speech", aec: false });
    h.v.setMic(true);
    h.v.reply("One. Two.");
    expect(h.v.state()).toMatchObject({ speaking: true, hold: true });
    h.v.userSpeech();
    expect(h.v.state()).toMatchObject({ ducked: false, paused: true, hold: false });
    expect(h.v.aec()).toBe(false);
  });

  it("no utterance playing: the user's speech interrupts as before", () => {
    const h = cloudHarness({ mode: "speech" });
    h.v.setMic(true);
    h.v.userSpeech(); // nothing queued: a no-op
    expect(h.v.state()).toMatchObject({ paused: false, ducked: false });
    h.v.reply("Hi.");
    h.v.interrupt("typing");
    h.v.userSpeech(); // paused, nothing playing: another pause reason, no duck
    expect(h.v.state()).toMatchObject({ paused: true, ducked: false });
  });
});

describe("voice session: the cloud route falls back to speech per sentence", () => {
  it("a 404 miss or a refused play: that sentence is spoken", async () => {
    const h = cloudHarness({ status: (t) => (t.startsWith("Missing") ? 404 : 200) });
    h.v.setMic(true);
    h.v.reply("Missing clip. Fine clip.");
    await tick();
    expect(h.spoken.map((u) => u.text)).toEqual(["Missing clip."]);
    expect(h.logs.find((l) => l.fallback)).toMatchObject({
      ev: "voice-out",
      out: "cloud",
      route: "speech",
      fallback: "http 404 miss",
    });
    h.spoken[0]!.onend?.();
    await h.loaded();
    expect(h.el.plays).toHaveLength(1);
    h.el.onended?.();
    // The element refuses to play (no gesture yet on iOS).
    h.el.refuse = true;
    h.v.reply("Refused here.");
    await h.loaded();
    expect(h.spoken.at(-1)?.text).toBe("Refused here.");
    expect(h.logs.at(-1)).toMatchObject({ fallback: "play NotAllowedError" });
  });

  it("a fallback with no speechSynthesis skips the sentence", async () => {
    const h = cloudHarness({ status: () => 503 });
    const v = createVoice({
      synth: () => null,
      utter: () => ({}) as UtterLike,
      enabled: () => true,
      here: () => true,
      cloud: () =>
        createCloudOut({
          url: () => ttsUrlFrom("/api/tts"),
          fetch: async () => ({
            ok: false,
            status: 503,
            headers: { get: () => null },
            blob: async () => new Blob(),
          }),
          element: () => h.el,
          ctx: () => null,
        }),
      mode: () => "cloud",
    });
    expect(v.reply("Nothing can say this.")).toBe(true);
    await tick();
    await tick();
    expect(v.state()).toMatchObject({ queued: 0 });
  });
});

describe("voice session: the echo check", () => {
  it("matches what the agent said in the window, and says whether it was audible during the utterance", () => {
    const h = cloudHarness({ mode: "speech" });
    h.v.setMic(true);
    h.h0.t = 1_000;
    h.v.reply("I pushed the branch to origin.");
    h.h0.t = 3_000;
    const during = h.v.echoCheck("pushed the branch to origin", 1_500);
    expect(during).toMatchObject({ drop: true, during: true, score: 1 });
    h.spoken[0]!.onend?.();
    h.h0.t = 3_000 + ECHO_WINDOW_MS - 100;
    expect(h.v.echoCheck("pushed the branch to origin", 500)).toMatchObject({
      drop: true,
      during: false,
    });
    h.h0.t = 3_000 + ECHO_WINDOW_MS + 2_000;
    expect(h.v.echoCheck("pushed the branch to origin", 500)).toMatchObject({
      drop: false,
      during: false,
    });
    expect(h.v.echoCheck("something else entirely", 0).drop).toBe(false);
  });

  it("a dropped echo that caused a barge-in reads on at once", async () => {
    const h = cloudHarness();
    h.v.setMic(true);
    h.v.reply("A long sentence here. And more.");
    await h.loaded();
    h.v.userSpeech();
    h.fire(BARGE_IN_MS);
    expect(h.v.state().paused).toBe(true);
    h.v.echoDropped();
    expect(h.v.state().paused).toBe(false);
    // Paused by typing: an echo drop does not resume it.
    h.v.interrupt("typing");
    h.v.echoDropped();
    expect(h.v.state().paused).toBe(true);
  });

  it("setLog redirects the debug events; log() goes there too", () => {
    const h = cloudHarness({ mode: "speech" });
    const seen: unknown[] = [];
    h.v.setLog((e) => seen.push(e));
    h.v.log({ ev: "x" });
    h.v.setMic(true);
    h.v.reply("Hi.");
    expect(seen).toEqual([{ ev: "x" }, expect.objectContaining({ ev: "voice-out" })]);
  });
});

describe("the box's hook: speak(text, id) and stop(why)", () => {
  it("reads a message once per id; stop('typing') pauses, stop() clears", () => {
    const h = harness({ enabled: true, here: true });
    const hook: VoiceHook = h.v;
    hook.speak("One. Two.", "m1");
    hook.speak("One. Two.", "m1"); // the same message again: not re-read
    expect(h.v.state().queued).toBe(2);
    hook.stop("typing");
    expect(h.v.state()).toMatchObject({ paused: true, queued: 2 });
    h.v.resume();
    expect(h.texts()).toEqual(["One.", "One."]);
    hook.stop("off"); // not an interruption: the queue goes
    expect(h.v.state()).toMatchObject({ paused: false, queued: 0, speaking: false });
    hook.speak("Three.");
    hook.speak("Three."); // no id: read each time
    expect(h.v.state().queued).toBe(2);
    hook.stop();
    expect(h.v.state().queued).toBe(0);
  });

  it("is a MicVoiceLink for <liagent-mic>, and unlock reaches the outputs", () => {
    let unlocked = 0;
    const v = createVoice({
      synth: () => null,
      utter: () => ({}) as UtterLike,
      enabled: () => true,
      unlock: () => void unlocked++,
    });
    const link: MicVoiceLink = v;
    link.unlock?.();
    expect(unlocked).toBe(1);
    expect(link.state()).toMatchObject({ speaking: false, hold: false });
  });
});

describe("natural voices", () => {
  const voices = [
    { lang: "en-US", name: "Eddy", voiceURI: "com.apple.eloquence.en-US.Eddy", default: true },
    { lang: "en-US", name: "Samantha", voiceURI: "com.apple.voice.compact.en-US.Samantha" },
    { lang: "en-US", name: "Ava", voiceURI: "com.apple.voice.premium.en-US.Ava" },
    { lang: "en-GB", name: "Daniel", voiceURI: "com.apple.voice.enhanced.en-GB.Daniel" },
    { lang: "ja-JP", name: "Kyoko", voiceURI: "com.apple.voice.compact.ja-JP.Kyoko" },
  ];
  it("ranks Premium > Enhanced/Siri > regular > Eloquence and novelty", () => {
    expect(voices.map(voiceQuality)).toEqual([0, 2, 4, 3, 2]);
    expect(voiceQuality({ voiceURI: "com.apple.speech.synthesis.voice.Zarvox" })).toBe(0);
    expect(voiceQuality({ voiceURI: "x.siri.y" })).toBe(3);
  });
  it("picks the best of the exact locale, else of the language", () => {
    expect(pickNaturalVoice(voices, "en-US")?.name).toBe("Ava");
    expect(pickNaturalVoice(voices, "en_AU")?.name).toBe("Ava");
    expect(pickNaturalVoice(voices, "ja")?.name).toBe("Kyoko");
    expect(pickNaturalVoice(voices, "ko-KR")).toBeUndefined();
  });
});

describe("voice(options)", () => {
  it("configures the page's session: here(), the toggle and the log", () => {
    const g = globalThis as Record<string, unknown>;
    const saved = { s: g.speechSynthesis, k: g.__liagentVoice };
    try {
      g.speechSynthesis = { speak() {}, cancel() {}, getVoices: () => [] };
      delete g.__liagentVoice;
      let here = false;
      const seen: unknown[] = [];
      const v = voice({ here: () => here, enabled: () => true });
      expect(v.reply("x.")).toBe(false);
      here = true;
      expect(v.shouldSpeak()).toBe(true);
      expect(voice({ enabled: () => false, log: (e) => void seen.push(e) })).toBe(v);
      expect(v.shouldSpeak()).toBe(false);
      v.log({ ev: "x" });
      expect(seen).toEqual([{ ev: "x" }]);
      expect(v.mode()).toBe("speech"); // no tts endpoint: speech only
    } finally {
      g.speechSynthesis = saved.s;
      if (saved.k === undefined) delete g.__liagentVoice;
      else g.__liagentVoice = saved.k;
    }
  });
});
