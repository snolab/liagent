import { UI_EN, uiStrings } from "../src/ui-strings.ts";
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

describe("channels in the log", () => {
  // Odd lines are 分支, every third is the world, the rest 報告.
  const chan = (m: ChatMessage) => {
    const n = Number(m.id.slice(1));
    if (n % 3 === 0) return { label: "世界", color: "oklch(0.6 0.1 90)", world: true };
    return n % 2 ? { label: "分支", color: "oklch(0.6 0.1 250)" } : { label: "報告", color: "red" };
  };
  const ids = (lis: FakeEl[]) => lis.map((li) => li.dataset.id);

  it("renderLog puts the tag before the screen-reader name", () => {
    const { box, lines } = logBox([1, 2].map(line));
    box.channelOf = chan;
    const text = lines()[0]!.querySelector("span.text")!;
    const spans = text.children.filter((c): c is FakeEl => c instanceof FakeEl);
    expect(spans.map((s) => s.className).slice(0, 2)).toEqual(["channel", "sr"]);
    expect(spans[0]!.textContent).toBe("【分支】");
    expect(spans[0]!.props["--channel"]).toBe("oklch(0.6 0.1 250)");
  });
  it("leaves out the lines the filter hides, world lines stay", () => {
    const { box, lines } = logBox([1, 2, 3, 4, 5, 6].map(line));
    box.channelOf = chan;
    box.channelFilter = "報告";
    expect(ids(lines())).toEqual(["m2", "m3", "m4", "m6"]);
    box.channelFilter = null;
    expect(ids(lines())).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
  });
  it("a filter that hides everything says so (a status for screen readers)", () => {
    const { box, log, lines } = logBox([1, 5].map(line));
    box.channelOf = chan;
    box.channelFilter = "報告";
    expect(lines()).toEqual([]);
    const hint = log.querySelector("li.filtered")!;
    expect(hint.getAttribute("role")).toBe("status");
    expect(hint.textContent).toContain("報告");
  });
  it("collapsed-count counts over the filtered lines", () => {
    const { box, lines } = logBox([1, 2, 3, 4, 5, 6, 7, 8].map(line));
    box.channelOf = chan;
    box.channelFilter = "分支";
    box.collapsedCount = 2;
    // 分支 and world: m1 m3 m5 m6 m7; only the last two show at rest.
    expect(ids(lines().filter((li) => !li.classList.contains("older")))).toEqual(["m6", "m7"]);
    expect(lines().filter((li) => li.classList.contains("older")).length).toBe(3);
  });
  it("a saved position on a filtered-out line is kept, a gone one dropped", () => {
    const { box } = logBox([1, 2, 3].map(line));
    const self = box as unknown as Record<string, unknown>;
    // The real tryRestore (logBox stubs it on the instance).
    const restore = () =>
      (ChatBox.prototype as unknown as { tryRestore(): void }).tryRestore.call(box);
    box.channelOf = chan;
    box.channelFilter = "分支";
    self.els = {
      ...(self.els as object),
      column: { clientHeight: 100, scrollTop: 0, scrollHeight: 100 },
    };
    self.restoreTo = { id: "m2", dy: 0 };
    restore();
    expect(self.restoreTo).toEqual({ id: "m2", dy: 0 });
    self.restoreTo = { id: "m9", dy: 0 };
    restore();
    expect(self.restoreTo).toBeUndefined();
  });
  it("minimized, a hidden channel's line never floats; a shown one floats with its tag", () => {
    const { box } = logBox([1, 2].map(line));
    const self = box as unknown as Record<string, unknown> & {
      addFloat(m: ChatMessage): void;
      clearFloats(): void;
      floats: Map<string, unknown>;
    };
    const floats = new FakeEl("ul");
    self.els = { ...(self.els as object), floats };
    self.placeFloat = () => {};
    box.channelOf = chan;
    box.channelFilter = "報告";
    self.addFloat(line(1));
    expect(self.floats.size).toBe(0);
    self.addFloat(line(2));
    expect(self.floats.size).toBe(1);
    expect(floats.querySelector("span.channel")!.textContent).toBe("【報告】");
    // The filter changes: the floating line of a now hidden channel goes.
    box.channelFilter = "分支";
    expect(self.floats.size).toBe(0);
    self.clearFloats();
  });
});

it("the DOM fixture supports default UI-language lookup", () => {
  expect(uiStrings()).toBe(UI_EN);
});
