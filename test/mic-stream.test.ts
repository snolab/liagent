import { describe, expect, it } from "bun:test";
import {
  type MicState,
  PENDING_MARK,
  RATE,
  STREAM_FINAL_MS,
  type StreamStt,
  type TextSource,
  type UploadInfo,
  UtteranceQueue,
  type VadEvents,
  createMic,
  pcm16,
} from "../src/mic.ts";

// A streaming STT: mic.streamStt fed from the VAD's frames, the utterance covered by its
// final (no upload, no pending mark left), and its text tagged "stream".
function fakeStream() {
  const sessions: {
    frames: number;
    ended: boolean;
    aborted: boolean;
    cb: { onPartial(t: string): void; onFinal(t: string): void };
  }[] = [];
  const stream: StreamStt = {
    open(cb) {
      const s = { frames: 0, ended: false, aborted: false, cb };
      sessions.push(s);
      return {
        send: () => void s.frames++,
        end: () => void (s.ended = true),
        abort: () => void (s.aborted = true),
      };
    },
  };
  return { stream, sessions };
}

function harness(stream?: StreamStt) {
  let ev: VadEvents | null = null;
  const texts: [string, TextSource | undefined][] = [];
  const pending: [number, string][] = [];
  const timers: { f: () => void; ms: number }[] = [];
  const uploads: (UploadInfo & { resolve: (t: string) => void })[] = [];
  const states: MicState[] = [];
  const mic = createMic({
    load: async (e) => {
      ev = e;
      return { start() {}, pause() {}, flush() {}, destroy() {} };
    },
    upload: (_wav, info) => new Promise((resolve) => uploads.push({ ...info, resolve })),
    onState: (s) => states.push(s),
    onText: (t, src) => texts.push([t, src]),
    onPending: (n, t) => pending.push([n, t]),
    stream: () => stream,
    stallMs: 0,
    setTimer: (f, ms) => {
      const t = { f, ms };
      timers.push(t);
      return t;
    },
    clearTimer: () => {},
  });
  const e = () => ev as unknown as VadEvents;
  const speak = (sec: number) => {
    for (let i = 0; i < Math.round(sec * 10); i++) e().onFrame?.(new Float32Array(RATE / 10));
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { mic, e, speak, texts, pending, timers, uploads, states, tick };
}

describe("createMic: a streaming STT", () => {
  it("is fed every captured frame; its final covers the utterance: no upload, source 'stream'", async () => {
    const f = fakeStream();
    const h = harness(f.stream);
    await h.mic.toggle();
    h.e().onSpeechStart();
    h.speak(5); // past PARTIAL_MIN_MS: no batch partial while a stream runs
    expect(f.sessions[0]!.frames).toBe(50);
    f.sessions[0]!.cb.onPartial("こんに");
    expect(h.pending.at(-1)).toEqual([1, "こんに"]);
    h.e().onSpeechEnd(new Float32Array(RATE * 5));
    expect(f.sessions[0]!.ended).toBe(true);
    expect(h.uploads).toHaveLength(0);
    f.sessions[0]!.cb.onFinal("こんにちは。");
    expect(h.texts).toEqual([["こんにちは。", "stream"]]);
    expect(h.pending.at(-1)).toEqual([0, ""]); // covered: no pending mark left
    f.sessions[0]!.cb.onFinal("again"); // later finals are ignored
    expect(h.texts).toHaveLength(1);
  });

  it("no final in time: the utterance is uploaded the batch way (source 'stt'), a late final ignored", async () => {
    const f = fakeStream();
    const h = harness(f.stream);
    await h.mic.toggle();
    h.e().onSpeechStart();
    h.speak(1);
    h.e().onSpeechEnd(new Float32Array(RATE));
    const t = h.timers.find((x) => x.ms === STREAM_FINAL_MS)!;
    expect(h.pending.at(-1)).toEqual([1, PENDING_MARK]);
    t.f();
    expect(f.sessions[0]!.aborted).toBe(true);
    expect(h.uploads).toHaveLength(1);
    f.sessions[0]!.cb.onFinal("late");
    h.uploads[0]!.resolve("batch text");
    await h.tick();
    expect(h.texts).toEqual([["batch text", "stt"]]);
  });

  it("a misfire or a hold aborts the stream and drops the utterance", async () => {
    const f = fakeStream();
    const h = harness(f.stream);
    await h.mic.toggle();
    h.e().onSpeechStart();
    h.speak(0.5);
    h.e().onMisfire();
    expect(f.sessions[0]!.aborted).toBe(true);
    f.sessions[0]!.cb.onFinal("ghost");
    h.e().onSpeechStart();
    h.mic.hold(true);
    expect(f.sessions[1]!.aborted).toBe(true);
    h.mic.hold(false);
    expect(h.texts).toEqual([]);
    expect(h.pending.at(-1)?.[0]).toBe(0);
  });

  it("a stream that throws on open or send: that utterance goes the batch way", async () => {
    const h = harness({
      open() {
        throw new Error("no socket");
      },
    });
    await h.mic.toggle();
    h.e().onSpeechStart();
    h.speak(1);
    h.e().onSpeechEnd(new Float32Array(RATE));
    expect(h.uploads).toHaveLength(1);
    const h2 = harness({
      open: () => ({
        send() {
          throw new Error("closed");
        },
        end() {},
      }),
    });
    await h2.mic.toggle();
    h2.e().onSpeechStart();
    h2.speak(1);
    h2.e().onSpeechEnd(new Float32Array(RATE));
    expect(h2.uploads).toHaveLength(1);
  });

  it("text stays in the order spoken across stream and batch utterances", async () => {
    const f = fakeStream();
    let use: StreamStt | undefined = f.stream;
    const h = harness({ open: (cb) => use!.open(cb) });
    await h.mic.toggle();
    h.e().onSpeechStart();
    h.e().onSpeechEnd(new Float32Array(RATE)); // streamed, final still out
    use = {
      open() {
        throw new Error("down");
      },
    };
    h.e().onSpeechStart();
    h.e().onSpeechEnd(new Float32Array(RATE)); // batch
    h.uploads[0]!.resolve("second");
    await h.tick();
    expect(h.texts).toEqual([]); // held behind the first
    f.sessions[0]!.cb.onFinal("first");
    expect(h.texts).toEqual([
      ["first", "stream"],
      ["second", "stt"],
    ]);
  });
});

describe("UtteranceQueue.takeRuns and pcm16", () => {
  it("joins runs of the same source, keeps sources apart", () => {
    const q = new UtteranceQueue();
    const [a, b, c] = [q.add(), q.add(), q.add()];
    q.resolve(a, "one", "stream");
    q.resolve(b, "two", "stream");
    q.resolve(c, "three");
    expect(q.takeRuns()).toEqual([
      { text: "one two", source: "stream" },
      { text: "three", source: "stt" },
    ]);
  });
  it("pcm16 clamps to 16-bit", () => {
    expect([...pcm16(new Float32Array([0, 1, -1, 2, -2, 0.5]))]).toEqual([
      0, 32767, -32768, 32767, -32768, 16383,
    ]);
  });
});
