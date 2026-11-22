import { describe, expect, it } from "bun:test";
import { barWheel, ChatBox, olderLines } from "../src/box.ts";
import type { ChatMessage } from "../src/protocol.ts";
import { FakeEl, installFakeDocument } from "./fake-dom.ts";

installFakeDocument();

const line = (n: number): ChatMessage => ({
  id: `m${n}`,
  from: n % 2 ? "agent" : "owner",
  label: n % 2 ? "agent" : "me",
  text: `line ${n}`,
  at: 1_700_000_000_000 + n,
});

/** A box whose renderLog draws into a fake <ul>; attributes live in a map. */
function logBox(messages: ChatMessage[]) {
  const box = new ChatBox();
  // Messages first, while there is no shadow root, so only the log is drawn below.
  box.messages = messages;
  const attrs = new Map<string, string>();
  const self = box as unknown as Record<string, unknown>;
  self.getAttribute = (k: string) => attrs.get(k) ?? null;
  self.hasAttribute = (k: string) => attrs.has(k);
  self.setAttribute = (k: string, v: string) => {
    attrs.set(k, v);
    box.attributeChangedCallback(k);
  };
  self.removeAttribute = (k: string) => {
    attrs.delete(k);
    box.attributeChangedCallback(k);
  };
  for (const k of ["renderStatus", "onColumnScroll", "toEnd", "tryRestore", "renderFloatTexts"])
    self[k] = () => {};
  const log = new FakeEl("ul");
  self.root = {};
  self.els = { log };
  (box as unknown as { renderLog(): void }).renderLog();
  return { box, log, attrs, lines: () => log.querySelectorAll("li[data-id]") };
}

describe("collapsed-count", () => {
  it("olderLines: all but the last N, none for 0, none when N covers them", () => {
    expect(olderLines(10, 3)).toBe(7);
    expect(olderLines(10, 0)).toBe(0);
    expect(olderLines(3, 3)).toBe(0);
    expect(olderLines(2, 5)).toBe(0);
  });
  it("the property and the attribute round-trip, and the log re-renders", () => {
    const { box, attrs, lines } = logBox([1, 2, 3, 4, 5].map(line));
    expect(box.collapsedCount).toBe(0);
    box.collapsedCount = 2.7;
    expect(attrs.get("collapsed-count")).toBe("2");
    expect(box.collapsedCount).toBe(2);
    expect(lines().filter((li) => li.classList.contains("older")).length).toBe(3);
    box.collapsedCount = 0;
    expect(attrs.has("collapsed-count")).toBe(false);
    expect(lines().some((li) => li.classList.contains("older"))).toBe(false);
    attrs.set("collapsed-count", "junk");
    expect(box.collapsedCount).toBe(0);
  });
  it("renderLog marks the lines before the last N as older", () => {
    const { box, lines } = logBox([1, 2, 3, 4, 5].map(line));
    box.collapsedCount = 3;
    expect(lines().map((li) => li.classList.contains("older"))).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    box.collapsedCount = 5;
    expect(lines().some((li) => li.classList.contains("older"))).toBe(false);
    box.collapsedCount = 9;
    expect(lines().some((li) => li.classList.contains("older"))).toBe(false);
  });
});

describe("the wheel over the bar", () => {
  const ev = (o: Partial<Parameters<typeof barWheel>[0]> = {}) => ({
    deltaX: 0,
    deltaY: 40,
    deltaMode: 0,
    ctrlKey: false,
    defaultPrevented: false,
    ...o,
  });
  const col = (top = 100) => ({ scrollTop: top, scrollHeight: 400, clientHeight: 100 });
  it("scrolls the history by the wheel's pixels while it can", () => {
    expect(barWheel(ev(), false, col())).toBe(40);
    expect(barWheel(ev({ deltaY: -40 }), false, col())).toBe(-40);
    expect(barWheel(ev({ deltaY: 3, deltaMode: 1 }), false, col())).toBeGreaterThan(3);
  });
  it("at the history's end the page takes it", () => {
    expect(barWheel(ev(), false, col(300))).toBe(0);
    expect(barWheel(ev({ deltaY: -40 }), false, col(0))).toBe(0);
  });
  it("one notch over the input scrolls the log once (the input's own listener has it)", () => {
    expect(barWheel(ev(), true, col())).toBe(0);
    expect(barWheel(ev({ defaultPrevented: true }), false, col())).toBe(0);
  });
  it("leaves pinch-zoom and horizontal wheels alone", () => {
    expect(barWheel(ev({ ctrlKey: true }), false, col())).toBe(0);
    expect(barWheel(ev({ deltaX: 60, deltaY: 10 }), false, col())).toBe(0);
  });
});
