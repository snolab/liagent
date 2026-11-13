import { describe, expect, it } from "bun:test";
import { sileroVad } from "../src/mic-audio.ts";

// vad-web 0.0.31: destroy() on a MicVAD that never started throws in getAudioInstances()
// before model.release(), so the ONNX session leaked on every cancel during load.
describe("sileroVad destroy", () => {
  it("releases the model when vad-web's destroy throws before start", async () => {
    let released = 0;
    let closed = 0;
    const micVad = {
      model: { release: async () => void released++ },
      ownsAudioContext: true,
      _audioContext: { close: async () => void closed++ },
      start: async () => {},
      pause: async () => {},
      destroy: async () => {
        throw new Error("MicVAD has null stream, audio context, or processor adapter");
      },
    };
    const ev = { onSpeechStart() {}, onSpeechEnd() {}, onMisfire() {} };
    const v = await sileroVad(
      ev as never,
      {} as MediaStream,
      async () => ({ MicVAD: { new: async () => micVad } }) as never,
    );
    await v.destroy();
    expect(released).toBe(1);
    expect(closed).toBe(1);
  });
  it("does not release twice when vad-web's destroy succeeds", async () => {
    let released = 0;
    const micVad = {
      model: { release: async () => void released++ },
      start: async () => {},
      pause: async () => {},
      destroy: async () => void released++,
    };
    const ev = { onSpeechStart() {}, onSpeechEnd() {}, onMisfire() {} };
    const v = await sileroVad(
      ev as never,
      {} as MediaStream,
      async () => ({ MicVAD: { new: async () => micVad } }) as never,
    );
    await v.destroy();
    expect(released).toBe(1);
  });
});
