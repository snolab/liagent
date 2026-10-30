import { describe, expect, it } from "bun:test";
import {
  type DictationTarget,
  MIC_STRINGS_EN,
  MicElement,
  defineMic,
  dictate,
  isDictationTarget,
  micLabel,
} from "../src/mic-button.ts";
import {
  AEC_CONSTRAINTS,
  LEGACY_CONSTRAINTS,
  appliedSettings,
  audioCtx,
  canCapture,
  existingCtx,
  micConstraints,
  noteTrack,
  sileroVad,
  vadFromScripts,
} from "../src/mic-audio.ts";
import type { VadEvents } from "../src/mic.ts";

/** A chat box in memory, with the shape <liagent-chat> gives the mic. */
function fakeBox(draft = "", accept = true) {
  const sent: string[] = [];
  const box: Omit<DictationTarget, "draft"> & {
    draft: string;
    sources: (string | undefined)[];
    partial: string | null;
  } = {
    draft,
    sources: [],
    partial: null,
    micActive: false,
    setDraft(next, o) {
      this.draft = next;
      this.sources.push(o?.source);
    },
    setPartial(t) {
      this.partial = t;
    },
    submit() {
      if (!accept) return false;
      sent.push(this.draft);
      this.draft = "";
      return true;
    },
  };
  return { box, sent };
}

describe("dictate: a final transcript into a DictationTarget", () => {
  it("appends, punctuates and sends a spoken sentence, marked as stt", () => {
    const { box, sent } = fakeBox("typed so far");
    expect(dictate(box, "and spoken")).toBe(true);
    expect(sent).toEqual(["typed so far and spoken."]);
    expect(box.sources).toEqual(["stt"]);
    expect(box.draft).toBe("");
  });

  it("nothing said: the draft is left alone; a box that refuses the send keeps the text", () => {
    const { box, sent } = fakeBox("draft");
    expect(dictate(box, "  ")).toBe(false);
    expect(box.sources).toEqual([]);
    const no = fakeBox("", false);
    expect(dictate(no.box, "好")).toBe(false);
    expect(no.box.draft).toBe("好。");
    expect(no.sent).toEqual([]);
    expect(sent).toEqual([]);
    // Punctuation only: written, not sent.
    const p = fakeBox();
    expect(dictate(p.box, "。")).toBe(false);
    expect(p.box.draft).toBe("。");
  });

  it("isDictationTarget wants setDraft, setPartial and submit", () => {
    expect(isDictationTarget(fakeBox().box)).toBe(true);
    expect(isDictationTarget({ setDraft() {}, submit() {} })).toBe(false);
    expect(isDictationTarget(null)).toBe(false);
  });
});

describe("micLabel", () => {
  it("names each state, the resume prompt and the agent speaking", () => {
    expect(micLabel({ state: "off", resume: false }, "idle")).toBe(MIC_STRINGS_EN.dictate);
    expect(micLabel({ state: "off", resume: true }, "idle")).toBe("Tap to resume listening");
    expect(micLabel({ state: "listening", resume: false }, "speaking")).toMatch(/Agent speaking/);
    expect(micLabel({ state: "capturing", resume: false }, "capturing")).toMatch(/^Recording/);
    expect(micLabel({ state: "listening", resume: false }, "listening")).toMatch(/^Listening/);
    expect(
      micLabel({ state: "loading", resume: false }, "loading", {
        ...MIC_STRINGS_EN,
        listening: "正在听",
      }),
    ).toBe("正在听");
  });
});

describe("the element outside a browser", () => {
  it("imports and defines nothing without customElements (server rendering)", () => {
    expect(defineMic()).toBe(MicElement);
    expect(MicElement.observedAttributes).toContain("stt-url");
    expect(canCapture()).toBe(false);
  });
});

describe("mic-audio", () => {
  it("AEC constraints: echo cancellation, noise suppression and auto gain on; off drops auto gain", () => {
    expect(micConstraints()).toEqual({ ...AEC_CONSTRAINTS });
    expect(micConstraints(false)).toEqual({ ...LEGACY_CONSTRAINTS });
    expect("autoGainControl" in micConstraints(false)).toBe(false);
  });

  it("keeps what the browser applied to the track, without device ids", () => {
    noteTrack({
      getAudioTracks: () => [
        {
          getSettings: () => ({
            echoCancellation: true,
            noiseSuppression: false,
            autoGainControl: true,
            sampleRate: 48000,
            channelCount: 1,
            deviceId: "secret",
          }),
        },
      ],
    });
    expect(appliedSettings()).toEqual({
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: true,
      sampleRate: 48000,
      channelCount: 1,
    });
    noteTrack({
      getAudioTracks: () => {
        throw new Error("gone");
      },
    });
    expect(appliedSettings()).toBeNull();
  });

  it("one AudioContext per page, made on first use (webkit prefix too)", () => {
    const g = globalThis as Record<string, unknown>;
    const saved = { a: g.AudioContext, w: g.webkitAudioContext, k: g.__liagentAudio };
    try {
      delete g.__liagentAudio;
      g.AudioContext = undefined;
      g.webkitAudioContext = undefined;
      expect(audioCtx()).toBeNull();
      expect(existingCtx()).toBeNull();
      class Fake {}
      g.webkitAudioContext = Fake;
      const c = audioCtx();
      expect(c).toBeInstanceOf(Fake);
      expect(audioCtx()).toBe(c);
      expect(existingCtx()).toBe(c);
    } finally {
      g.AudioContext = saved.a;
      g.webkitAudioContext = saved.w;
      if (saved.k === undefined) delete g.__liagentAudio;
      else g.__liagentAudio = saved.k;
    }
  });

  it("vadFromScripts points vad-web at the two dist directories", () => {
    const c = vadFromScripts("https://cdn.example/vad", "https://cdn.example/ort/");
    expect(c.baseAssetPath).toBe("https://cdn.example/vad/");
    expect(c.onnxWASMBasePath).toBe("https://cdn.example/ort/");
  });

  it("sileroVad hands vad-web the session's stream and the mic's events", async () => {
    let opts: Record<string, unknown> = {};
    const did: string[] = [];
    const mod = {
      MicVAD: {
        new: async (o: Record<string, unknown>) => {
          opts = o;
          return {
            start: () => void did.push("start"),
            pause: () => void did.push("pause"),
            destroy: () => void did.push("destroy"),
          };
        },
      },
    };
    const heard: unknown[] = [];
    const ev: VadEvents = {
      onSpeechStart: () => {},
      onSpeechEnd: () => {},
      onMisfire: () => {},
      onFrame: (f, p) => void heard.push([f.length, p]),
    };
    const stream = { id: "s" } as unknown as MediaStream;
    // A dynamic import's namespace has the module as `default` in some bundlers.
    const v = await sileroVad(ev, stream, {
      load: async () => ({ default: mod }),
      baseAssetPath: "/vad/",
      options: { positiveSpeechThreshold: 0.6 },
    });
    expect(opts).toMatchObject({
      baseAssetPath: "/vad/",
      model: "v5",
      submitUserSpeechOnPause: true,
      startOnLoad: false,
      positiveSpeechThreshold: 0.6,
      onSpeechStart: ev.onSpeechStart,
      onVADMisfire: ev.onMisfire,
    });
    expect("onnxWASMBasePath" in opts).toBe(false);
    expect(await (opts.getStream as () => Promise<unknown>)()).toBe(stream);
    (opts.onFrameProcessed as (p: unknown, f: Float32Array) => void)(
      { isSpeech: 0.9 },
      new Float32Array(512),
    );
    expect(heard).toEqual([[512, 0.9]]);
    await v.flush();
    await v.destroy();
    expect(did).toEqual(["pause", "start", "destroy"]);
    // A plain loader function works too; a module without MicVAD is an error.
    await expect(sileroVad(ev, stream, async () => mod)).resolves.toBeDefined();
    await expect(
      sileroVad(ev, stream, async () => ({}) as unknown as typeof mod),
    ).rejects.toThrow();
  });
});
