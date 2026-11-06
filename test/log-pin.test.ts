import { describe, expect, it } from "bun:test";
import { atEndAfter, repinEnd, stillAtEnd } from "../src/log-pin.ts";
import { createPageAudio } from "../src/page-audio.ts";
import {
  AEC_EVENT,
  RAW_CONSTRAINTS,
  VOICE_AEC_KEY,
  aecOn,
  applyAec,
  micConstraints,
} from "../src/aec.ts";

describe("log pin", () => {
  it("a log at its end stays there when it changes size; scrolled up, it is left alone", () => {
    expect(repinEnd({ atEnd: true, scrollTop: 100, scrollHeight: 400, clientHeight: 200 })).toBe(
      200,
    );
    expect(
      repinEnd({ atEnd: true, scrollTop: 200, scrollHeight: 400, clientHeight: 200 }),
    ).toBeNull();
    expect(
      repinEnd({ atEnd: false, scrollTop: 0, scrollHeight: 400, clientHeight: 200 }),
    ).toBeNull();
    expect(
      repinEnd({ atEnd: true, scrollTop: 0, scrollHeight: 100, clientHeight: 200 }),
    ).toBeNull();
  });
  it("the re-pin's own late scroll does not leave the end; the user's does", () => {
    expect(stillAtEnd({ gap: 2, ownPin: false, userScrolled: false })).toBe(true);
    expect(stillAtEnd({ gap: 40, ownPin: true, userScrolled: false })).toBe(true);
    expect(stillAtEnd({ gap: 40, ownPin: true, userScrolled: true })).toBe(false);
    expect(stillAtEnd({ gap: 40, ownPin: false, userScrolled: false })).toBe(false);
  });
});

describe("page audio", () => {
  it("holds while any sound plays and a tail after the last; a lost end is capped", () => {
    const timers: { f: () => void; ms: number; dead?: boolean }[] = [];
    const pa = createPageAudio({
      setTimer: (f, ms) => {
        const t = { f, ms };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => {
        if (t) (t as { dead?: boolean }).dead = true;
      },
      tailMs: 400,
      maxMs: 30_000,
    });
    const seen: boolean[] = [];
    pa.subscribe((p) => seen.push(p));
    const end1 = pa.start();
    const end2 = pa.start();
    expect(pa.playing()).toBe(true);
    end1();
    end1(); // again: a no-op
    expect(pa.playing()).toBe(true);
    end2();
    const tail = timers.find((t) => t.ms === 400 && !t.dead)!;
    expect(pa.playing()).toBe(true);
    tail.f();
    expect(pa.playing()).toBe(false);
    expect(seen).toEqual([true, false]);
    // A sound whose end never comes stops holding at the cap.
    pa.start();
    timers
      .filter((t) => t.ms === 30_000 && !t.dead)
      .at(-1)!
      .f();
    timers
      .filter((t) => t.ms === 400 && !t.dead)
      .at(-1)!
      .f();
    expect(pa.playing()).toBe(false);
  });
});

describe("echo cancellation switch", () => {
  it("off is truly off; applyAec writes it, tells the page and reopens an open mic", async () => {
    const store = new Map<string, string>();
    const g = globalThis as unknown as Record<string, unknown>;
    const had = g.localStorage;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const events: unknown[] = [];
    const on = (e: Event) => events.push((e as CustomEvent).detail);
    globalThis.addEventListener(AEC_EVENT, on);
    try {
      expect(micConstraints(false)).toEqual({ ...RAW_CONSTRAINTS });
      expect(aecOn()).toBe(true);
      let reopened = 0;
      const mic = {
        state: "listening",
        view: () => ({ state: mic.state }),
        reopen: async () => (reopened++, true),
      };
      expect(await applyAec(false, { __liagentMic: mic })).toBe("reopened");
      expect(store.get(VOICE_AEC_KEY)).toBe("0");
      expect(aecOn()).toBe(false);
      expect(reopened).toBe(1);
      mic.state = "off";
      expect(await applyAec(true, { __liagentMic: mic })).toBe("next-open");
      expect(store.has(VOICE_AEC_KEY)).toBe(false);
      expect(reopened).toBe(1);
      expect(events).toEqual([{ on: false }, { on: true }]);
    } finally {
      globalThis.removeEventListener(AEC_EVENT, on);
      g.localStorage = had;
    }
  });
});

describe("atEndAfter: only the user's scroll leaves the end", () => {
  it("a log rebuilt or resized without user input stays at its end", () => {
    // After a refresh: the history renders, the log is rebuilt (scrollTop clamped to 0).
    expect(atEndAfter({ atEnd: true, gap: 900, clientHeight: 300, userScrolled: false })).toBe(true);
  });
  it("a hidden log (not laid out) keeps what it had", () => {
    expect(atEndAfter({ atEnd: true, gap: 0, clientHeight: 0, userScrolled: false })).toBe(true);
    expect(atEndAfter({ atEnd: false, gap: 0, clientHeight: 0, userScrolled: true })).toBe(false);
  });
  it("the user scrolling up leaves the end; back down returns to it", () => {
    expect(atEndAfter({ atEnd: true, gap: 200, clientHeight: 300, userScrolled: true })).toBe(false);
    expect(atEndAfter({ atEnd: false, gap: 2, clientHeight: 300, userScrolled: true })).toBe(true);
  });
  it("scrolled up stays scrolled up while the log changes", () => {
    expect(atEndAfter({ atEnd: false, gap: 500, clientHeight: 300, userScrolled: false })).toBe(false);
  });
});
