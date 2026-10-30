import { describe, expect, it } from "bun:test";
import {
  AEC_CONSTRAINTS,
  LEGACY_CONSTRAINTS,
  RESUME_REWIND_S,
  VOICE_AEC_KEY,
  VOICE_OUT_KEY,
  aecOn,
  appliedSettings,
  audioCtx,
  cloudOut,
  cloudSkip,
  createCloudOut,
  existingCtx,
  micConstraints,
  noteTrack,
  outMode,
  ttsUrlFrom,
  cloudReady,
} from "../src/voice-out.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Swap globals for one test, putting them back after. */
function withGlobals(vals: Record<string, unknown>, f: () => void | Promise<void>) {
  const g = globalThis as Record<string, unknown>;
  const saved = Object.fromEntries(Object.keys(vals).map((k) => [k, g[k]]));
  Object.assign(g, vals);
  const restore = () => {
    for (const [k, x] of Object.entries(saved)) {
      if (x === undefined) delete g[k];
      else g[k] = x;
    }
  };
  try {
    const r = f();
    if (r) return r.finally(restore);
  } catch (e) {
    restore();
    throw e;
  }
  restore();
}

describe("voice-out: the switches", () => {
  it("liagent:voice-out is speech unless 'cloud'; liagent:voice-aec is on unless '0'; storage blocked = defaults", () => {
    let store: Record<string, string> | null = {};
    const localStorage = {
      getItem: (k: string) => {
        if (!store) throw new Error("blocked");
        return store[k] ?? null;
      },
    };
    withGlobals({ localStorage }, () => {
      expect(outMode()).toBe("speech");
      expect(aecOn()).toBe(true);
      store = { [VOICE_OUT_KEY]: "cloud", [VOICE_AEC_KEY]: "0" };
      expect(outMode()).toBe("cloud");
      expect(aecOn()).toBe(false);
      expect(micConstraints(aecOn())).toEqual({ ...LEGACY_CONSTRAINTS });
      store = { [VOICE_OUT_KEY]: "nonsense" };
      expect(outMode()).toBe("speech");
      store = null;
      expect(outMode()).toBe("speech");
      expect(aecOn()).toBe(true);
    });
  });

  it("AEC constraints: echo cancellation, noise suppression and auto gain all on", () => {
    expect(micConstraints(true)).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    });
    expect(AEC_CONSTRAINTS.autoGainControl).toBe(true);
    expect("autoGainControl" in micConstraints(false)).toBe(false);
  });

  it("keeps what the browser applied to the mic track", () => {
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
    noteTrack({ getAudioTracks: () => [] });
    expect(appliedSettings()).toEqual({});
    noteTrack({
      getAudioTracks: () => {
        throw new Error("gone");
      },
    });
    expect(appliedSettings()).toBeNull();
  });

  it("the route's URL and what it cannot voice", () => {
    const url = ttsUrlFrom("/api/tts");
    expect(url("a b?", "ja-JP")).toBe("/api/tts?lang=ja&text=a%20b%3F");
    expect(ttsUrlFrom("https://t.example/v1?voice=x")("Hi", "en")).toBe(
      "https://t.example/v1?voice=x&lang=en&text=Hi",
    );
    const own = (t: string, l: string) => `/say/${l}/${t}`;
    expect(ttsUrlFrom(own)).toBe(own);
    const lim = { langs: ["en", "ja"], maxText: 10 };
    expect(cloudSkip("Hi.", "en-US", lim)).toBeNull();
    expect(cloudSkip("Hi.", "ru-RU", lim)).toBe("lang");
    expect(cloudSkip("  ", "en", lim)).toBe("empty");
    expect(cloudSkip("x".repeat(11), "en", lim)).toBe("long");
    // No limits: any language, any length.
    expect(cloudSkip("x".repeat(500), "ru")).toBeNull();
  });
});

describe("voice-out: the page's AudioContext and cloud output", () => {
  it("one AudioContext, made on first use (webkit prefix too); none without Web Audio", () => {
    delete (globalThis as Record<string, unknown>).__liagentAudio;
    withGlobals({ AudioContext: undefined, webkitAudioContext: undefined }, () => {
      expect(audioCtx()).toBeNull();
    });
    class Fake {
      state = "running";
    }
    withGlobals({ AudioContext: undefined, webkitAudioContext: Fake }, () => {
      const c = audioCtx();
      expect(c).toBeInstanceOf(Fake);
      expect(audioCtx()).toBe(c);
      expect(existingCtx()).toBe(c);
    });
  });

  it("cloudOut() needs Audio; then it is one per page, on fetch, new Audio() and blob URLs", async () => {
    delete (globalThis as Record<string, unknown>).__liagentCloudOut;
    withGlobals({ Audio: undefined }, () => expect(cloudOut()).toBeNull());
    const fetched: string[] = [];
    const made: string[] = [];
    const revoked: string[] = [];
    const url = {
      createObjectURL: () => {
        made.push(`blob:${made.length}`);
        return made.at(-1);
      },
      revokeObjectURL: (u: string) => void revoked.push(u),
    };
    await withGlobals(
      {
        Audio: El,
        fetch: async (u: string) => {
          fetched.push(u);
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            blob: async () => new Blob(["x"]),
          };
        },
      },
      async () => {
        const c = cloudOut();
        expect(c).not.toBeNull();
        expect(cloudReady()).toBe(false); // no endpoint yet
        expect(cloudOut("/api/tts")).toBe(c);
        expect(cloudReady()).toBe(true);
        const saved = { c: URL.createObjectURL, r: URL.revokeObjectURL };
        Object.assign(URL, url);
        try {
          const ev = { onend() {}, onerror() {} };
          c?.play({ text: "Hi.", lang: "en", at: 0, volume: 1 }, ev);
          for (let i = 0; i < 70; i++) c?.prepare?.(`Clip ${i}.`, "en");
          await tick();
          await tick();
        } finally {
          Object.assign(URL, { createObjectURL: saved.c, revokeObjectURL: saved.r });
        }
        expect(fetched[0]).toBe("/api/tts?lang=en&text=Hi.");
        expect(made.length).toBeGreaterThan(60);
        expect(revoked.length).toBeGreaterThan(0);
      },
    );
  });
});

class El {
  src = "";
  currentTime = 0;
  volume = 1;
  preload = "";
  paused = true;
  plays = 0;
  refuse = false;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  play() {
    if (this.refuse) return Promise.reject(new Error("x"));
    this.paused = false;
    this.plays++;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {
    this.currentTime = 0;
  }
}

function rig(o: { ctx?: boolean; wireThrows?: boolean; fail?: "http" | "network" } = {}) {
  const el = new El();
  const calls: unknown[][] = [];
  const gain = {
    gain: {
      value: 1,
      cancelScheduledValues: (t: number) => void calls.push(["cancel", t]),
      setValueAtTime: (v: number, t: number) => void calls.push(["set", v, t]),
      linearRampToValueAtTime: (v: number, t: number) => void calls.push(["ramp", v, t]),
    },
    connect: (n: unknown) => n,
  };
  const ctx = {
    currentTime: 1,
    destination: {},
    createGain: () => gain,
    createMediaElementSource: () => {
      if (o.wireThrows) throw new Error("already wired");
      return { connect: (n: unknown) => n };
    },
  };
  const fetched: string[] = [];
  const revoked: string[] = [];
  let n = 0;
  const out = createCloudOut({
    url: () => ttsUrlFrom("/api/tts"),
    langs: ["en", "es", "fr", "zh", "ja", "ko"],
    maxText: 200,
    fetch: async (u) => {
      fetched.push(u);
      if (o.fail === "network") throw new Error("offline");
      return {
        ok: o.fail !== "http",
        status: o.fail === "http" ? 429 : 200,
        headers: { get: () => null },
        blob: async () => new Blob(["x"]),
      };
    },
    element: () => el,
    ctx: () => (o.ctx === false ? null : ctx),
    toUrl: () => `blob:${++n}`,
    revoke: (u) => void revoked.push(u),
  });
  const events: string[] = [];
  const ev = {
    onend: () => void events.push("end"),
    onerror: () => void events.push("error"),
    onfail: (r: string) => void events.push(`fail:${r}`),
  };
  return { el, calls, ctx, out, fetched, revoked, events, ev, gain };
}

describe("voice-out: createCloudOut", () => {
  it("plays through the GainNode at the asked volume, ramps it, stops with a rewound offset", async () => {
    const r = rig();
    const pb = r.out.play({ text: "Hello.", lang: "en-US", at: 0, volume: 0.25 }, r.ev);
    expect(pb.route).toBe("audio");
    await tick();
    expect(r.out.gain()).toBe(r.gain);
    expect(r.calls).toContainEqual(["set", 0.25, 1]);
    expect(r.fetched).toEqual(["/api/tts?lang=en&text=Hello."]);
    r.el.onloadedmetadata?.();
    await tick();
    expect(r.el.plays).toBe(1);
    pb.volume(1, 200);
    expect(r.calls.at(-1)).toEqual(["ramp", 1, 1.2]);
    r.el.currentTime = 0.1;
    expect(pb.stop()).toEqual({ at: 0 }); // never below 0
    expect(pb.stop()).toEqual({}); // already stopped
    pb.volume(0.5, 80); // a stopped playback changes nothing
    expect(r.calls.at(-1)).toEqual(["ramp", 1, 1.2]);
    // Its late events are ignored.
    r.el.onended?.();
    expect(r.events).toEqual([]);
  });

  it("resumes at an offset; end and error events reach the session", async () => {
    const r = rig();
    r.out.play({ text: "Again.", lang: "en", at: 2.5, volume: 1 }, r.ev);
    await tick();
    r.el.onloadedmetadata?.();
    expect(r.el.currentTime).toBe(2.5);
    r.el.onloadedmetadata?.(); // once only
    r.el.onended?.();
    r.el.onerror?.();
    expect(r.events).toEqual(["end", "error"]);
    const pb = r.out.play({ text: "Again.", lang: "en", at: 0, volume: 1 }, r.ev);
    expect(r.fetched).toHaveLength(1); // cached
    r.el.currentTime = 3;
    expect(pb.stop().at).toBeCloseTo(3 - RESUME_REWIND_S, 5);
  });

  it("stopped before the clip arrives: nothing plays", async () => {
    const r = rig();
    const pb = r.out.play({ text: "Late.", lang: "en", at: 0, volume: 1 }, r.ev);
    expect(pb.stop()).toEqual({ at: 0 }); // no element yet
    await tick();
    expect(r.el.src).toBe("");
    expect(r.events).toEqual([]);
  });

  it("fails over to speech: skipped text, an http error, the network, a refused play", async () => {
    const skip = rig();
    skip.out.play({ text: "Привет.", lang: "ru", at: 0, volume: 1 }, skip.ev);
    await tick();
    expect(skip.events).toEqual(["fail:lang"]);
    expect(skip.fetched).toEqual([]);
    const http = rig({ fail: "http" });
    http.out.play({ text: "Hi.", lang: "en", at: 0, volume: 1 }, http.ev);
    await tick();
    expect(http.events).toEqual(["fail:http 429"]);
    const net = rig({ fail: "network" });
    net.out.play({ text: "Hi.", lang: "en", at: 0, volume: 1 }, net.ev);
    await tick();
    expect(net.events).toEqual(["fail:offline"]);
    // A failed fetch is not cached: the next try fetches again.
    net.out.play({ text: "Hi.", lang: "en", at: 0, volume: 1 }, net.ev);
    expect(net.fetched).toHaveLength(2);
    const refused = rig();
    refused.el.refuse = true;
    refused.out.play({ text: "Hi.", lang: "en", at: 0, volume: 1 }, refused.ev);
    await tick();
    refused.el.onloadedmetadata?.();
    await tick();
    expect(refused.events).toEqual(["fail:play Error"]);
  });

  it("without an AudioContext (or one that refuses the element) the element's own volume is used", async () => {
    for (const o of [{ ctx: false }, { wireThrows: true }]) {
      const r = rig(o);
      const pb = r.out.play({ text: "Hi.", lang: "en", at: 0, volume: 0.25 }, r.ev);
      await tick();
      expect(r.out.gain()).toBeNull();
      expect(r.el.volume).toBe(0.25);
      pb.volume(1, 200);
      expect(r.el.volume).toBe(1);
    }
  });

  it("prepare() fetches ahead once; the clip cache drops (and revokes) the oldest", async () => {
    const r = rig();
    r.out.prepare?.("One.", "en");
    r.out.prepare?.("One.", "en");
    r.out.prepare?.("Привет.", "ru"); // cannot: nothing fetched
    expect(r.fetched).toEqual(["/api/tts?lang=en&text=One."]);
    for (let i = 0; i < 70; i++) r.out.prepare?.(`Clip ${i}.`, "en");
    await tick();
    expect(r.revoked.length).toBeGreaterThan(0);
    expect(r.revoked[0]).toBe("blob:1");
  });

  it("unlock() plays a moment of silence on the element (in the gesture), unless it is playing", async () => {
    const r = rig();
    withGlobals({ btoa: globalThis.btoa }, () => r.out.unlock());
    expect(r.el.src.startsWith("data:audio/wav;base64,UklGR")).toBe(true);
    await tick();
    expect(r.el.paused).toBe(true);
    r.el.paused = false;
    r.el.src = "playing";
    r.out.unlock();
    expect(r.el.src).toBe("playing");
    const refused = rig();
    refused.el.refuse = true;
    refused.out.unlock();
    await tick();
    expect(refused.el.plays).toBe(0);
  });
});

describe("voice-out: no endpoint", () => {
  it("a cloud output without a TTS URL fails over to speech", async () => {
    const r = rig();
    const out = createCloudOut({
      url: () => null,
      fetch: async () => {
        throw new Error("never");
      },
      element: () => r.el,
      ctx: () => null,
    });
    out.play({ text: "Hi.", lang: "en", at: 0, volume: 1 }, r.ev);
    await tick();
    expect(r.events).toEqual(["fail:no tts url"]);
  });
});
