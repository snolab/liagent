import { describe, expect, test } from "bun:test";
import { afterChange, autoSend, enterSends, lineBreakSends } from "../src/input.ts";

describe("enterSends", () => {
  test("plain Enter sends", () => {
    expect(enterSends({ key: "Enter", shiftKey: false, keyCode: 13 }, false)).toBe(true);
  });
  test("Shift+Enter is a newline", () => {
    expect(enterSends({ key: "Enter", shiftKey: true, keyCode: 13 }, false)).toBe(false);
  });
  test("never inside an IME composition, nor on the Enter that confirms a candidate", () => {
    expect(enterSends({ key: "Enter", shiftKey: false, isComposing: true }, false)).toBe(false);
    expect(enterSends({ key: "Enter", shiftKey: false }, true)).toBe(false);
    expect(enterSends({ key: "Enter", shiftKey: false, keyCode: 229 }, false)).toBe(false);
  });
  test("other keys do nothing", () => {
    expect(enterSends({ key: "a", shiftKey: false }, false)).toBe(false);
  });
});

describe("lineBreakSends (Android: every key is 229)", () => {
  const free = { composing: false, shiftEnter: false };
  test("the line break itself sends", () => {
    expect(lineBreakSends("insertLineBreak", free)).toBe(true);
    expect(lineBreakSends("insertParagraph", free)).toBe(true);
  });
  test("but not after Shift+Enter, nor while composing", () => {
    expect(lineBreakSends("insertLineBreak", { ...free, shiftEnter: true })).toBe(false);
    expect(lineBreakSends("insertLineBreak", { ...free, composing: true })).toBe(false);
    expect(lineBreakSends("insertParagraph", { ...free, isComposing: true })).toBe(false);
  });
  test("ordinary text is not a send", () => {
    expect(lineBreakSends("insertText", free)).toBe(false);
  });
});

describe("afterChange", () => {
  test("typing arms the debounce; an empty draft does not", () => {
    expect(afterChange("h", 0, false)).toBe("arm");
    expect(afterChange("   ", 0, false)).toBe("idle");
  });
  test("a dictated sentence (a burst over 10 chars ending a sentence) sends at once", () => {
    expect(afterChange("Fix the swipe please.", 0, false)).toBe("send");
    expect(afterChange("スワイプを直してください。", 0, false)).toBe("send");
    expect(afterChange("hello there? ", 0, false)).toBe("send");
  });
  test("a short or unfinished burst only arms", () => {
    expect(afterChange("ok.", 0, false)).toBe("arm");
    expect(afterChange("Fix the swipe please", 0, false)).toBe("arm");
  });
  test("typed one key at a time, a full stop does not send", () => {
    expect(afterChange("Fix the swipe please.", 20, false)).toBe("arm");
  });
  test("nothing while composing", () => {
    expect(afterChange("スワイプを直してください。", 0, true)).toBe("idle");
  });
});

describe("autoSend", () => {
  test("a sentence jump sends when nothing holds the draft", () => {
    expect(autoSend(afterChange("Hello there, how are you today.", 0, false), {})).toBe("send");
  });
  test("micActive, a partial or hold stop the jump-send and the debounce", () => {
    for (const held of [{ mic: true }, { partial: true }, { hold: true }]) {
      expect(autoSend("send", held)).toBe("idle");
      expect(autoSend("arm", held)).toBe("idle");
    }
  });
});

// Exercise the box wiring without mounting its UI.
describe("box automatic sends", () => {
  test("mic, partial and hold keep a pasted sentence in the box", async () => {
    const { ChatBox } = await import("../src/box.ts");
    for (const held of ["mic", "partial", "hold"]) {
      const box = new ChatBox();
      let sent = false;
      box.submit = () => {
        sent = true;
        return true;
      };
      // Set internal flags to avoid rendering the absent DOM.
      Object.assign(box, {
        _micActive: held === "mic",
        _partial: held === "partial" ? "more" : "",
        _hold: held === "hold",
      });
      Object.assign(box, { _draft: "Hello there, how are you today." });
      (box as unknown as { arm(): void }).arm();
      expect(sent).toBe(false);
      expect(box.draft).toBe("Hello there, how are you today.");
    }
  });
  test("hold also blocks the files-only debounce", async () => {
    const { ChatBox } = await import("../src/box.ts");
    const box = new ChatBox();
    box.hold = true;
    // Without the guard this tries to create a drain bar in the absent DOM.
    (box as unknown as { armFiles(): void }).armFiles();
    expect(box.hold).toBe(true);
  });
});
