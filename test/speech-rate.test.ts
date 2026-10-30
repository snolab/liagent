import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SPEECH_RATE,
  SPEECH_RATE_KEY,
  setSpeechRate,
  speechRate,
} from "../src/speech-rate.ts";

const mem = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    m,
  };
};

describe("speech rate setting", () => {
  it("defaults to 1.5×", () => {
    expect(DEFAULT_SPEECH_RATE).toBe(1.5);
    expect(speechRate(mem())).toBe(1.5);
    expect(speechRate(null)).toBe(1.5);
  });

  it("persists one of 1, 1.25, 1.5, 2 under liagent:speech-rate", () => {
    const s = mem();
    setSpeechRate(2, s);
    expect(s.m.get(SPEECH_RATE_KEY)).toBe("2");
    expect(speechRate(s)).toBe(2);
    setSpeechRate(1.25, s);
    expect(speechRate(s)).toBe(1.25);
    setSpeechRate(3, s); // not offered: ignored
    expect(speechRate(s)).toBe(1.25);
    s.m.set(SPEECH_RATE_KEY, "fast");
    expect(speechRate(s)).toBe(1.5);
  });

  it("survives storage that throws", () => {
    const bad = {
      getItem: () => {
        throw new Error("private");
      },
      setItem: () => {
        throw new Error("private");
      },
    };
    expect(speechRate(bad)).toBe(1.5);
    expect(() => setSpeechRate(2, bad)).not.toThrow();
  });
});
