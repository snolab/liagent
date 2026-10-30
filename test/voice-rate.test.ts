import { describe, expect, it } from "bun:test";
import { type UtterLike, createVoice } from "../src/voice.ts";
import { createCloudOut } from "../src/voice-out.ts";

describe("the rate reaches the outputs", () => {
  it("speech: each utterance gets the rate as set when it starts", () => {
    const spoken: UtterLike[] = [];
    let rate = 1.5;
    const v = createVoice({
      synth: () => ({ speak: (u) => void spoken.push(u), cancel: () => {} }),
      utter: (text) => ({ text, onend: null, onerror: null, onboundary: null }) as UtterLike,
      enabled: () => true,
      here: () => true,
      rate: () => rate,
    });
    v.reply("One. Two.");
    expect(spoken[0]!.rate).toBe(1.5);
    rate = 2; // changed mid-reply: from the next utterance
    spoken[0]!.onend?.();
    expect(spoken[1]!.rate).toBe(2);
    expect(spoken[0]!.rate).toBe(1.5);
  });

  it("cloud audio: playbackRate set, pitch kept (both names)", async () => {
    const el = {
      src: "",
      currentTime: 0,
      volume: 1,
      preload: "",
      paused: true,
      playbackRate: 1,
      defaultPlaybackRate: 1,
      preservesPitch: false,
      webkitPreservesPitch: false,
      onended: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onloadedmetadata: null as (() => void) | null,
      play: async () => {},
      pause() {},
      load() {
        // A real load() resets the rate to the default.
        el.playbackRate = el.defaultPlaybackRate;
      },
    };
    const out = createCloudOut({
      url: () => (t, l) => `/tts?lang=${l}&text=${t}`,
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        blob: async () => new Blob(["x"]),
      }),
      element: () => el,
      ctx: () => null,
      toUrl: () => "blob:1",
    });
    out.play(
      { text: "Hello.", lang: "en", at: 0, volume: 1, rate: 1.25 },
      { onend() {}, onerror() {} },
    );
    await new Promise((r) => setTimeout(r, 0));
    el.onloadedmetadata?.();
    expect(el.playbackRate).toBe(1.25);
    expect(el.defaultPlaybackRate).toBe(1.25);
    expect(el.preservesPitch).toBe(true);
    expect(el.webkitPreservesPitch).toBe(true);
  });
});
