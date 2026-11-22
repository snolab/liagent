import { expect, it } from "bun:test";
import { createMicSession, type MicVoiceLink } from "../src/mic-session.ts";
import { createMic, energyGate, RATE, type VadEvents } from "../src/mic.ts";

it("stream final must pass through the same echo and recording hooks as batch", async () => {
  let ev!: VadEvents, final!: (text: string) => void;
  const delivered: string[] = [],
    utterances: unknown[] = [];
  let echoChecks = 0;
  const session = createMicSession({
    getStream: async () => ({
      id: "fixture",
      getTracks: () => [{ readyState: "live", stop() {} }],
    }),
    load: async (events) => {
      ev = events;
      return { start() {}, pause() {}, flush() {}, destroy() {} };
    },
    upload: async () => {
      throw Error("A successful stream must not upload");
    },
    stream: () => ({
      open(cb) {
        final = cb.onFinal;
        return { send() {}, end() {}, abort() {} };
      },
    }),
    onUtterance: (u) => {
      utterances.push(u);
    },
    stallMs: 0,
  });
  const voice: MicVoiceLink = {
    setMic() {},
    userSpeech() {},
    userIdle() {},
    state: () => ({ speaking: false, hold: false }),
    subscribe: () => () => {},
    echoCheck() {
      echoChecks++;
      return { drop: true };
    },
  };
  session.setVoice(voice);
  session.attach({ onText: (t) => delivered.push(t), onPending() {} });
  await session.toggle();
  ev.onSpeechStart();
  ev.onFrame?.(new Float32Array(RATE));
  ev.onSpeechEnd(new Float32Array(RATE));
  final("fixture assistant echo.");
  await session.off();
  expect({ echoChecks, utterances: utterances.length, delivered }).toEqual({
    echoChecks: 1,
    utterances: 1,
    delivered: [],
  });
});

it("stream receives the first loud frame retained by the bundled energy gate", async () => {
  let ev!: VadEvents;
  const frames: Float32Array[] = [];
  const gate = energyGate({ rate: RATE });
  const mic = createMic({
    load: async (e) => {
      ev = e;
      return { start() {}, pause() {}, flush() {}, destroy() {} };
    },
    upload: async () => "",
    onState() {},
    onText() {},
    onPending() {},
    stallMs: 0,
    stream: () => ({
      open() {
        return { send: (f) => frames.push(f), end() {}, abort() {} };
      },
    }),
  });
  await mic.toggle();
  const feed = (frame: Float32Array) => {
    const r = gate.push(frame);
    if (r === "start") ev.onSpeechStart();
    ev.onFrame?.(frame);
    if (r === "misfire") ev.onMisfire();
    else if (r && r !== "start") ev.onSpeechEnd(r);
  };
  feed(new Float32Array(1600).fill(0.1));
  feed(new Float32Array(1600).fill(0.2));
  await mic.off();
  expect(frames.map((f) => Math.round(f[0]! * 10))).toEqual([1, 2]);
});

it("an early stream final waits for the complete audio and a misfire still drops it", async () => {
  let ev!: VadEvents, final!: (text: string) => void;
  const delivered: string[] = [],
    lengths: number[] = [];
  const mic = createMic({
    load: async (e) => {
      ev = e;
      return { start() {}, pause() {}, flush() {}, destroy() {} };
    },
    upload: async () => {
      throw Error("Unexpected upload");
    },
    onState() {},
    onText: (t) => delivered.push(t),
    onPending() {},
    stallMs: 0,
    finalize: (text, wav, info) => {
      expect(wav.length).toBe(44 + RATE * 2);
      lengths.push(info.durationMs);
      return text;
    },
    stream: () => ({
      open(cb) {
        final = cb.onFinal;
        return { send() {}, end() {}, abort() {} };
      },
    }),
  });
  await mic.toggle();
  ev.onSpeechStart();
  final("first.");
  expect(delivered).toEqual([]);
  ev.onSpeechEnd(new Float32Array(RATE));
  expect(delivered).toEqual(["first."]);
  expect(lengths).toEqual([1000]);
  ev.onSpeechStart();
  final("noise.");
  ev.onMisfire();
  expect(delivered).toEqual(["first."]);
  await mic.off();
});

it("a final delivered by end is not uploaded again if end then throws", async () => {
  let ev!: VadEvents,
    final!: (text: string) => void,
    uploads = 0,
    finalizations = 0;
  const texts: string[] = [];
  const mic = createMic({
    load: async (e) => {
      ev = e;
      return { start() {}, pause() {}, flush() {}, destroy() {} };
    },
    upload: async () => {
      uploads++;
      return "duplicate";
    },
    onState() {},
    onText: (t) => texts.push(t),
    onPending() {},
    stallMs: 0,
    finalize: (text) => {
      finalizations++;
      return text;
    },
    stream: () => ({
      open(cb) {
        final = cb.onFinal;
        return {
          send() {},
          end() {
            final("streamed.");
            throw Error("Socket cleanup failed");
          },
          abort() {},
        };
      },
    }),
  });
  await mic.toggle();
  ev.onSpeechStart();
  ev.onSpeechEnd(new Float32Array(RATE));
  expect(texts).toEqual(["streamed."]);
  expect(uploads).toBe(0);
  expect(finalizations).toBe(1);
  await mic.off();
});

it("preroll heard before a hold never reaches the next stream", async () => {
  let ev!: VadEvents;
  const samples: number[] = [];
  const mic = createMic({
    load: async (e) => {
      ev = e;
      return { start() {}, pause() {}, flush() {}, destroy() {} };
    },
    upload: async () => "",
    onState() {},
    onText() {},
    onPending() {},
    stallMs: 0,
    stream: () => ({
      open() {
        return { send: (f) => samples.push(f[0]!), end() {}, abort() {} };
      },
    }),
  });
  await mic.toggle();
  ev.onFrame?.(new Float32Array([0.25]));
  mic.hold(true);
  mic.hold(false);
  ev.onSpeechStart();
  ev.onFrame?.(new Float32Array([0.5]));
  expect(samples).toEqual([0.5]);
  await mic.off();
});
