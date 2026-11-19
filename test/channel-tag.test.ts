import { describe, expect, it } from "bun:test";
import { ChatBox } from "../src/box.ts";
import {
  type Channel,
  channelFor,
  channelTagEl,
  filterByChannel,
  isCssColor,
} from "../src/channel-tag.ts";

type M = { id: string; to?: string };
const WORLD: Channel = { label: "世界", color: "#2a7", world: true };
const of = (m: M): Channel | null =>
  m.to === "/"
    ? WORLD
    : m.to === "/b"
      ? { label: "分支", color: "rgb(200, 80, 0)" }
      : m.to === "/r"
        ? { label: "報告", color: "blue" }
        : null;
const msgs: M[] = [{ id: "1", to: "/" }, { id: "2", to: "/b" }, { id: "3", to: "/r" }, { id: "4" }];

type FakeEl = {
  tag: string;
  className?: string;
  textContent?: string;
  innerHTML?: string;
  props: Record<string, string>;
  style: { setProperty(k: string, v: string): void };
};
const doc = {
  createElement: (tag: string): FakeEl => {
    const props: Record<string, string> = {};
    return { tag, props, style: { setProperty: (k, v) => void (props[k] = v) } };
  },
} as unknown as Document;

describe("channel tags", () => {
  it("renders 【label】 as text with the colour as a style property", () => {
    const el = channelTagEl(doc, { label: "分支", color: "rgb(200, 80, 0)" }) as unknown as FakeEl;
    expect(el.className).toBe("channel");
    expect(el.textContent).toBe("【分支】");
    expect(el.props["--channel"]).toBe("rgb(200, 80, 0)");
  });
  it("keeps HTML in a label as text", () => {
    const el = channelTagEl(doc, {
      label: "<img src=x onerror=alert(1)>",
      color: "red",
    }) as unknown as FakeEl;
    expect(el.textContent).toBe("【<img src=x onerror=alert(1)>】");
    expect(el.innerHTML).toBeUndefined();
  });
  it("drops a colour that is not one", () => {
    const el = channelTagEl(doc, {
      label: "x",
      color: "red; background: url(x)",
    }) as unknown as FakeEl;
    expect(el.props["--channel"]).toBeUndefined();
    expect(isCssColor("")).toBe(false);
    expect(isCssColor(3)).toBe(false);
    expect(isCssColor("oklch(0.7 0.1 200)")).toBe(true);
  });
  it("null, unset, malformed or throwing channelOf: no tag", () => {
    expect(channelFor(of, { id: "4" })).toBeNull();
    expect(channelFor(null, { id: "1", to: "/" })).toBeNull();
    expect(channelFor(() => ({ color: "red" }) as unknown as Channel, { id: "1" })).toBeNull();
    expect(
      channelFor(
        () => {
          throw new Error("x");
        },
        { id: "1" },
      ),
    ).toBeNull();
    expect(channelFor(of, { id: "1", to: "/" })).toEqual(WORLD);
  });
});

describe("channel filter", () => {
  const ids = (xs: M[]) => xs.map((m) => m.id);
  it("no filter: every line, in order", () => {
    expect(ids(filterByChannel(msgs, of, null))).toEqual(["1", "2", "3", "4"]);
    expect(ids(filterByChannel(msgs, null, null))).toEqual(["1", "2", "3", "4"]);
  });
  it("a filter: that channel plus the world lines (MMO chat)", () => {
    expect(ids(filterByChannel(msgs, of, "分支"))).toEqual(["1", "2"]);
    expect(ids(filterByChannel(msgs, of, "報告"))).toEqual(["1", "3"]);
    expect(ids(filterByChannel(msgs, of, "世界"))).toEqual(["1"]);
  });
  it("untagged lines hide under a filter; no channelOf + filter shows nothing", () => {
    expect(ids(filterByChannel(msgs, of, "nope"))).toEqual(["1"]);
    expect(ids(filterByChannel(msgs, null, "分支"))).toEqual([]);
  });
});

describe("box.channelOf / box.channelFilter", () => {
  const set = (k: string, self: object, v: unknown) =>
    Object.getOwnPropertyDescriptor(ChatBox.prototype, k)!.set!.call(self, v);
  const get = (k: string, self: object) =>
    Object.getOwnPropertyDescriptor(ChatBox.prototype, k)!.get!.call(self);
  it("setting either re-renders the log; non-values become null", () => {
    let n = 0;
    const self = { renderLog: () => n++ };
    set("channelOf", self, of);
    expect(get("channelOf", self)).toBe(of);
    set("channelFilter", self, "分支");
    expect(get("channelFilter", self)).toBe("分支");
    set("channelOf", self, "nope");
    expect(get("channelOf", self)).toBeNull();
    set("channelFilter", self, undefined);
    expect(get("channelFilter", self)).toBeNull();
    expect(n).toBe(4);
  });
});
