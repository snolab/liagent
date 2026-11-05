import { afterEach, describe, expect, it } from "bun:test";
import {
  MIC_ON_KEY,
  MIC_SESSION_KEY,
  MIC_SESSION_V,
  type MicDeps,
  type MicVoiceLink,
  type ResumeOutcome,
  type VoiceLinkState,
  type StreamLike,
  createMicSession,
  micSession,
} from "../src/mic-session.ts";
import type { Vad, VadEvents } from "../src/mic.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

function fakes(over: Partial<MicDeps> = {}) {
  const calls = { gum: 0, stops: 0, vads: 0, destroyed: 0 };
  const store = new Map<string, string>();
  const logs: ResumeOutcome[] = [];
  let events: VadEvents | null = null;
  let n = 0;
  const makeStream = (): StreamLike => {
    const id = `s${++n}`;
    const track = {
      readyState: "live",
      stop() {
        // MediaStreamTrack.stop() on an ended track does nothing: count live tracks stopped
        if (track.readyState === "live") calls.stops++;
        track.readyState = "ended";
      },
    };
    return { id, getTracks: () => [track] };
  };
  const deps: MicDeps = {
    getStream: async () => {
      calls.gum++;
      return makeStream();
    },
    load: async (ev: VadEvents): Promise<Vad> => {
      calls.vads++;
      events = ev;
      return {
        start() {},
        pause() {},
        flush() {},
        destroy() {
          calls.destroyed++;
        },
      };
    },
    upload: async () => "hello there.",
    storage: {
      get: (k) => store.get(k) ?? null,
      set: (k, v) => void store.set(k, v),
      remove: (k) => void store.delete(k),
    },
    onResume: (r) => void logs.push(r),
    ...over,
  };
  return { deps, calls, store, logs, events: () => events };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[MIC_SESSION_KEY];
});

describe("mic session", () => {
  it("survives a detach: the stream stays live, only an explicit off stops it", async () => {
    const f = fakes();
    const s = createMicSession(f.deps);
    const texts: string[] = [];
    const detach = s.attach({ onText: (t) => texts.push(t), onPending: () => {} });
    await s.toggle();
    expect(s.view().state).toBe("listening");
    expect(f.store.get(MIC_ON_KEY)).toBe("1");
    const id = s.stream()?.id;
    detach(); // the widget unmounts (a hot swap, a remount)
    expect(s.view().state).toBe("listening");
    expect(f.calls.stops).toBe(0);
    // A new widget attaches: same stream, no second getUserMedia.
    s.attach({ onText: (t) => texts.push(t), onPending: () => {} });
    expect(s.stream()?.id).toBe(id);
    expect(f.calls.gum).toBe(1);
    await s.off();
    expect(s.view().state).toBe("off");
    expect(f.calls.stops).toBe(1);
    expect(f.store.has(MIC_ON_KEY)).toBe(false);
  });

  it("keeps transcripts that land between widgets, and hands them over on attach", async () => {
    const f = fakes();
    const s = createMicSession(f.deps);
    await s.toggle();
    f.events()?.onSpeechStart();
    f.events()?.onSpeechEnd(new Float32Array(1600));
    await tick();
    await tick();
    const texts: string[] = [];
    s.attach({ onText: (t) => texts.push(t), onPending: () => {} });
    expect(texts.join("")).toContain("hello there");
  });

  it("reuses a live stream when capture turns on again", async () => {
    const f = fakes();
    const s = createMicSession(f.deps, { stream: null, on: false });
    await s.toggle();
    const first = s.stream();
    // Off without stopping (as a retire does), then on: the live stream is reused.
    await s.toggle(); // explicit off: stops it
    await s.toggle();
    expect(f.calls.gum).toBe(2);
    expect(s.stream()).not.toBe(first);
  });

  it("is one per page: micSession() returns the same session", () => {
    const f = fakes();
    const a = micSession(f.deps);
    const b = micSession(fakes().deps);
    expect(b).toBe(a);
    expect(a.v).toBe(MIC_SESSION_V);
  });

  it("migrates an older session: its stream is kept and listened on again", async () => {
    const old = fakes();
    const prev = createMicSession(old.deps);
    await prev.toggle();
    const stream = prev.stream();
    (prev as { v: number }).v = MIC_SESSION_V - 1;
    (globalThis as Record<string, unknown>)[MIC_SESSION_KEY] = prev;
    const f = fakes();
    const next = micSession(f.deps);
    expect(next).not.toBe(prev);
    await tick();
    await tick();
    expect(next.stream()).toBe(stream);
    expect(next.view().state).toBe("listening");
    expect(f.calls.gum).toBe(0); // no second getUserMedia
    expect(old.calls.stops).toBe(0); // the old one never stopped it
    expect(old.calls.destroyed).toBe(1); // but its VAD is gone
  });
});

describe("mic session after a reload", () => {
  it("resumes by itself when the permission is granted", async () => {
    const f = fakes({ permission: async () => "granted", resumeAudio: async () => true });
    f.store.set(MIC_ON_KEY, "1");
    const s = createMicSession(f.deps);
    await s.autoResume();
    expect(s.view().state).toBe("listening");
    expect(f.logs).toEqual([{ path: "auto", ok: true, permission: "granted" }]);
  });

  it("tries too where the permission can't be asked (iOS)", async () => {
    const f = fakes({
      permission: async () => {
        throw new TypeError("not supported");
      },
    });
    f.store.set(MIC_ON_KEY, "1");
    const s = createMicSession(f.deps);
    await s.autoResume();
    expect(s.view().state).toBe("listening");
    expect(f.logs[0]).toMatchObject({ path: "auto", permission: "unknown" });
  });

  it("waits for a tap when it may not: prompt, a suspended context, or a refusal", async () => {
    for (const [over, reason] of [
      [{ permission: async () => "prompt" as const }, "permission prompt"],
      [{ resumeAudio: async () => false }, "audio context suspended"],
      [
        {
          getStream: async () => {
            throw new DOMException("no gesture", "NotAllowedError");
          },
        },
        "NotAllowedError",
      ],
    ] as const) {
      const f = fakes(over as Partial<MicDeps>);
      f.store.set(MIC_ON_KEY, "1");
      const s = createMicSession(f.deps);
      await s.autoResume();
      expect(s.view().state).toBe("off");
      expect(s.view().resume).toBe(true);
      expect(f.logs).toEqual([{ path: "tap", reason }]);
      expect(f.store.get(MIC_ON_KEY)).toBe("1"); // kept for the tap
    }
  });

  it("does nothing if this tab had the mic off, and survives storage that throws", async () => {
    const f = fakes({
      storage: {
        get: () => {
          throw new Error("private mode");
        },
        set: () => {
          throw new Error("private mode");
        },
        remove: () => {
          throw new Error("private mode");
        },
      },
    });
    const s = createMicSession(f.deps);
    await s.autoResume();
    expect(s.view().state).toBe("off");
    expect(f.calls.gum).toBe(0);
    await s.toggle(); // still works
    expect(s.view().state).toBe("listening");
    await s.off();
  });

  it("a tap after the resume prompt turns it on and clears the prompt", async () => {
    const f = fakes({ permission: async () => "prompt" });
    f.store.set(MIC_ON_KEY, "1");
    const s = createMicSession(f.deps);
    await s.autoResume();
    expect(s.view().resume).toBe(true);
    await s.toggle();
    expect(s.view()).toMatchObject({ state: "listening", resume: false });
  });
});

describe("mic session wiring", () => {
  it("tells subscribers and the upload what they need; the fallback runs on the same stream", async () => {
    const states: string[] = [];
    const cfgs: unknown[] = [];
    const f = fakes({
      // Silero fails to load: the fallback VAD runs on the same stream.
      load: async () => {
        throw new Error("cdn down");
      },
      onState: (s, prev) => void states.push(`${prev}>${s}`),
      upload: async (_w, _i, cfg) => {
        cfgs.push(cfg);
        return "ok.";
      },
    });
    let fallbackEvents: VadEvents | null = null;
    f.deps.fallback = async (ev) => {
      fallbackEvents = ev;
      return { start() {}, pause() {}, flush() {}, destroy() {} };
    };
    const s = createMicSession(f.deps);
    const seen: string[] = [];
    const unsub = s.subscribe((v) => seen.push(v.state));
    s.configure({ url: "/api/stt" });
    expect(s.config()).toEqual({ url: "/api/stt" });
    await s.toggle();
    expect(s.gumCalls()).toBe(1);
    expect(seen).toContain("listening");
    s.hold(true);
    s.hold(false);
    (fallbackEvents as VadEvents | null)?.onSpeechStart();
    (fallbackEvents as VadEvents | null)?.onFrame?.(new Float32Array(160), 0.9);
    (fallbackEvents as VadEvents | null)?.onSpeechEnd(new Float32Array(1600));
    await tick();
    expect(cfgs).toEqual([{ url: "/api/stt" }]);
    expect(states).toContain("off>loading");
    unsub();
    await s.off();
    expect(seen.at(-1)).toBe("listening"); // unsubscribed: no more updates
  });

  it("reports each final utterance (with its echo check) to onUtterance, never partials", async () => {
    const got: unknown[] = [];
    const f = fakes({ onUtterance: (u) => void got.push(u) });
    const s = createMicSession(f.deps);
    await s.toggle();
    f.events()?.onSpeechStart();
    f.events()?.onSpeechEnd(new Float32Array(1600));
    await tick();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ seq: 0, durationMs: 100, partial: false, text: "hello there." });
    expect((got[0] as { wav: Uint8Array }).wav.length).toBe(44 + 3200);
  });
});

/** A voice output in memory: what the mic told it, and a hold/speaking state the test drives. */
function fakeVoice(drop = false) {
  const calls: string[] = [];
  const subs = new Set<(s: VoiceLinkState) => void>();
  let st: VoiceLinkState = { speaking: false, hold: false };
  const link: MicVoiceLink = {
    setMic: (on) => void calls.push(`mic ${on}`),
    userSpeech: () => void calls.push("speech"),
    userIdle: () => void calls.push("idle"),
    userFrame: (p) => void calls.push(`frame ${p}`),
    state: () => st,
    subscribe(fn) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    interrupt: (why) => void calls.push(`interrupt ${why}`),
    echoCheck: (text) => {
      calls.push(`echo ${text}`);
      return { drop };
    },
    echoDropped: () => void calls.push("dropped"),
  };
  const set = (s: VoiceLinkState) => {
    st = s;
    for (const fn of subs) fn(s);
  };
  return { link, calls, set, subs };
}

describe("mic session and a voice output (MicVoiceLink)", () => {
  it("tells the voice when the mic is on and when the user talks; its speaking shows in the view", async () => {
    const f = fakes();
    const v = fakeVoice();
    const s = createMicSession(f.deps);
    s.setVoice(v.link);
    s.setVoice(v.link); // the same one: nothing changes
    expect(v.subs.size).toBe(1);
    await s.toggle();
    expect(v.calls).toEqual(["mic true", "mic true"]); // loading, listening
    f.events()?.onSpeechStart();
    f.events()?.onFrame?.(new Float32Array(160), 0.8);
    f.events()?.onSpeechEnd(new Float32Array(1600));
    await tick();
    expect(v.calls.slice(2)).toEqual([
      "mic true",
      "speech",
      "frame 0.8",
      "mic true",
      "idle",
      "echo hello there.",
    ]);
    v.set({ speaking: true, hold: false });
    expect(s.view().speaking).toBe(true);
    expect(s.voice()).toBe(v.link);
    s.setVoice(null);
    expect(v.subs.size).toBe(0);
    expect(s.view().speaking).toBe(false);
  });

  it("the voice's hold holds capture: speech heard meanwhile is dropped", async () => {
    const f = fakes();
    const v = fakeVoice();
    const s = createMicSession(f.deps);
    let uploads = 0;
    f.deps.upload = async () => {
      uploads++;
      return "x.";
    };
    s.setVoice(v.link);
    await s.toggle();
    v.set({ speaking: true, hold: true });
    f.events()?.onSpeechStart();
    f.events()?.onSpeechEnd(new Float32Array(1600));
    expect(uploads).toBe(0);
    v.set({ speaking: false, hold: false });
    f.events()?.onSpeechStart();
    f.events()?.onSpeechEnd(new Float32Array(1600));
    expect(uploads).toBe(1);
  });

  it("a transcript the voice calls its own echo is dropped, and the voice is told", async () => {
    const f = fakes();
    const v = fakeVoice(true);
    const got: unknown[] = [];
    f.deps.onUtterance = (u) => void got.push(u);
    const s = createMicSession(f.deps);
    const texts: string[] = [];
    s.attach({ onText: (t) => texts.push(t), onPending: () => {} });
    s.setVoice(v.link);
    await s.toggle();
    f.events()?.onSpeechStart();
    f.events()?.onSpeechEnd(new Float32Array(1600));
    await tick();
    await tick();
    expect(texts).toEqual([]);
    expect(v.calls).toContain("dropped");
    expect(got[0]).toMatchObject({ text: "hello there.", echo: { drop: true } });
  });

  it("a voice set while the mic is on hears that it is", async () => {
    const f = fakes();
    const s = createMicSession(f.deps);
    await s.toggle();
    const v = fakeVoice();
    s.setVoice(v.link);
    expect(v.calls).toEqual(["mic true"]);
  });
});

describe("mic session: the resume outcome", () => {
  it("is in the view, and a custom storage key is used", async () => {
    const f = fakes({ permission: async () => "denied", storageKey: "app:mic" });
    f.store.set("app:mic", "1");
    const s = createMicSession(f.deps);
    await s.autoResume();
    expect(s.view().resumed).toEqual({ path: "tap", reason: "permission denied" });
    await s.toggle();
    await s.off();
    expect(f.store.has("app:mic")).toBe(false);
    expect(MIC_ON_KEY).toBe("liagent:mic");
    expect(MIC_SESSION_KEY).toBe("__liagentMic");
  });
});

describe("mic session: reopen and the page's hold", () => {
  it("reopen gets a new stream with the new configuration; an explicit off wins", async () => {
    const f = fakes();
    const s = createMicSession(f.deps);
    expect(await s.reopen()).toBe(false); // off: nothing to reopen
    await s.toggle();
    const first = s.stream()?.id;
    expect(await s.reopen()).toBe(true);
    expect(s.view().state).toBe("listening");
    expect(s.stream()?.id).not.toBe(first);
    expect(f.calls.gum).toBe(2);
    // An off during a reopen: it stays off.
    const p = s.reopen();
    await s.off();
    expect(await p).toBe(false);
    expect(s.view().state).toBe("off");
  });
  it("the page's own audio holds capture together with the voice's hold", async () => {
    const holds: boolean[] = [];
    const f = fakes({
      load: async (): Promise<Vad> => ({
        start() {
          holds.push(false);
        },
        pause() {
          holds.push(true);
        },
        flush() {},
        destroy() {},
      }),
    });
    const s = createMicSession(f.deps);
    await s.toggle();
    holds.length = 0;
    s.setPageHold(true);
    s.setPageHold(false);
    await tick();
    expect(holds).toEqual([true, false]);
  });
});

describe("mic session: overlapping reopens", () => {
  it("a reopen asked during another runs one more pass instead of being dropped", async () => {
    const f = fakes();
    const s = createMicSession(f.deps);
    await s.toggle();
    const a = s.reopen();
    const b = s.reopen();
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(f.calls.gum).toBe(3); // the first open, then two passes
    expect(s.view().state).toBe("listening");
  });
});

describe("mic session: off while the VAD is still loading (deferred init)", () => {
  const deferred = (throwOnDestroy: boolean) => {
    let release!: () => void;
    const init = new Promise<void>((r) => (release = r));
    const f = fakes({
      load: async (): Promise<Vad> => {
        await init; // MicVAD.new(): addModule + the model, still pending
        return {
          start() {},
          pause() {},
          flush() {
            if (throwOnDestroy)
              throw new Error("MicVAD has null stream, audio context, or processor adapter");
          },
          destroy() {
            if (throwOnDestroy)
              throw new Error("MicVAD has null stream, audio context, or processor adapter");
          },
        };
      },
    });
    return { f, release };
  };
  for (const throws of [false, true]) {
    it(`stops every track and stays off${throws ? " (destroy throws)" : ""}`, async () => {
      const { f, release } = deferred(throws);
      const s = createMicSession(f.deps);
      const on = s.toggle();
      await tick();
      expect(s.view().state).toBe("loading");
      expect(f.calls.gum).toBe(1);
      await s.off();
      expect(f.calls.stops).toBe(1);
      expect(s.view().state).toBe("off");
      release();
      await on;
      await tick();
      expect(s.view().state).toBe("off");
      expect(f.calls.gum).toBe(1);
      expect(f.calls.stops).toBe(1);
      expect(s.stream()).toBeNull();
    });
  }
  it("a stream that arrives after the off is stopped, never listened on", async () => {
    let give!: () => void;
    const f = fakes();
    const gum = f.deps.getStream;
    f.deps.getStream = async (c) => {
      await new Promise<void>((r) => (give = r));
      return gum(c);
    };
    const s = createMicSession(f.deps);
    const on = s.toggle();
    await tick();
    await s.off();
    give();
    await on;
    await tick();
    expect(s.view().state).toBe("off");
    expect(f.calls.gum).toBe(1);
    expect(f.calls.stops).toBe(1);
    expect(f.calls.vads).toBe(0);
  });
  it("an off with a live VAD whose flush/destroy throw still stops the tracks", async () => {
    const f = fakes();
    const load = f.deps.load;
    f.deps.load = async (ev, st, c) => ({
      ...(await load(ev, st, c)),
      destroy() {
        throw new Error("boom");
      },
    });
    const s = createMicSession(f.deps);
    await s.toggle();
    expect(s.view().state).toBe("listening");
    await s.off();
    expect(f.calls.stops).toBe(1);
    expect(s.view().state).toBe("off");
  });
  it("a VAD that rejects during startup leaves the mic off with its tracks stopped", async () => {
    const f = fakes();
    f.deps.load = async () => {
      throw new Error("AudioWorklet init failed");
    };
    f.deps.fallback = undefined;
    const s = createMicSession(f.deps);
    await s.toggle();
    expect(s.view().state).toBe("off");
    expect(f.calls.stops).toBe(1);
    expect(s.stream()).toBeNull();
  });
  it("a fallback that also rejects still stops the tracks", async () => {
    const f = fakes();
    f.deps.load = async () => {
      throw new Error("worklet");
    };
    f.deps.fallback = async () => {
      throw new Error("no Web Audio");
    };
    const s = createMicSession(f.deps);
    await s.toggle();
    expect(s.view().state).toBe("off");
    expect(f.calls.stops).toBe(1);
  });
  it("a stall error clears itself when audio comes back", async () => {
    let ev: VadEvents | null = null;
    const f = fakes();
    const timers: (() => void)[] = [];
    const load = f.deps.load;
    f.deps.load = async (e, st, c) => {
      ev = e;
      return load(e, st, c);
    };
    f.deps.stallMs = 1;
    const s = createMicSession(f.deps);
    await s.toggle();
    await new Promise((r) => setTimeout(r, 20));
    expect((s.view().error as Error | null)?.name).toBe("MicStalledError");
    (ev as unknown as VadEvents).onFrame?.(new Float32Array(160));
    expect(s.view().error).toBeNull();
    expect(s.lastFrameAt()).toBeGreaterThan(0);
    void timers;
    await s.off();
  });
  it("quick off/on during a slow teardown: one teardown, the new on gets a fresh live stream", async () => {
    const f = fakes();
    let release: () => void = () => {};
    const load = f.deps.load;
    f.deps.load = async (ev, st, c) => ({
      ...(await load(ev, st, c)),
      destroy: () => new Promise<void>((r) => (release = r)),
    });
    const s = createMicSession(f.deps);
    await s.toggle();
    const first = s.stream();
    const a = s.off();
    const b = s.off(); // the second off shares the first teardown
    const on = s.toggle(); // a tap during teardown waits for it
    await new Promise((r) => setTimeout(r, 5));
    expect(f.calls.gum).toBe(1);
    release();
    await Promise.all([a, b, on]);
    expect(f.calls.stops).toBe(1); // only the old stream stopped, once
    expect(s.view().state).toBe("listening");
    expect(f.calls.gum).toBe(2);
    const cur = s.stream();
    expect(cur).not.toBe(first);
    expect(cur?.getTracks().every((t) => t.readyState === "live")).toBe(true);
    const end = s.off();
    await new Promise((r) => setTimeout(r, 5));
    release();
    await end;
  });
  const slow = (f: ReturnType<typeof fakes>) => {
    const r = { release: () => {} };
    const load = f.deps.load;
    f.deps.load = async (ev, st, c) => ({
      ...(await load(ev, st, c)),
      destroy: () => new Promise<void>((done) => (r.release = done)),
    });
    return r;
  };
  const wait = () => new Promise((r) => setTimeout(r, 5));
  it("an off() during teardown cancels a tap waiting on it: the mic stays off (closed window)", async () => {
    const f = fakes();
    const r = slow(f);
    const s = createMicSession(f.deps);
    await s.toggle();
    const a = s.off();
    const tap = s.toggle(); // the user taps on during cleanup
    const close = s.off(); // then the window closes
    await wait();
    r.release();
    await Promise.all([a, tap, close]);
    expect(s.view().state).toBe("off");
    expect(f.calls.gum).toBe(1);
    expect(s.stream()).toBeNull();
  });
  it("two taps during teardown collapse to the last intent (off)", async () => {
    const f = fakes();
    const r = slow(f);
    const s = createMicSession(f.deps);
    await s.toggle();
    const a = s.off();
    const t1 = s.toggle();
    const t2 = s.toggle();
    await wait();
    r.release();
    await Promise.all([a, t1, t2]);
    expect(s.view().state).toBe("off");
    expect(f.calls.gum).toBe(1);
  });
  it("three taps during teardown end on", async () => {
    const f = fakes();
    const r = slow(f);
    const s = createMicSession(f.deps);
    await s.toggle();
    const a = s.off();
    const taps = [s.toggle(), s.toggle(), s.toggle()];
    await wait();
    r.release();
    await Promise.all([a, ...taps]);
    expect(s.view().state).toBe("listening");
    expect(f.calls.gum).toBe(2);
    const end = s.off();
    await wait();
    r.release();
    await end;
  });
});
