import { describe, expect, it } from "bun:test";
import { beforeSendEvent } from "../src/before-send.ts";
import { MAX_CTX, cleanCtx, parsePageMessage } from "../src/protocol.ts";

describe("beforesend", () => {
  it("is cancelable, carries the line, and starts with an empty extra", () => {
    const e = beforeSendEvent({ text: "hi", to: "a/b", attachments: [] });
    expect(e.type).toBe("beforesend");
    expect(e.cancelable).toBe(true);
    expect(e.detail.text).toBe("hi");
    expect(e.detail.to).toBe("a/b");
    expect(e.detail.extra).toEqual({});
  });
  it("lets several listeners compose extra, and preventDefault cancels", () => {
    const t = new EventTarget();
    t.addEventListener("beforesend", (e) =>
      Object.assign((e as CustomEvent).detail.extra, { a: 1 }),
    );
    t.addEventListener("beforesend", (e) =>
      Object.assign((e as CustomEvent).detail.extra, { b: "x" }),
    );
    const e = beforeSendEvent({ text: "hi", attachments: [] });
    expect(t.dispatchEvent(e)).toBe(true);
    expect(cleanCtx(e.detail.extra)).toEqual({ a: 1, b: "x" });
    t.addEventListener("beforesend", (ev) => ev.preventDefault());
    expect(t.dispatchEvent(beforeSendEvent({ text: "no", attachments: [] }))).toBe(false);
  });
});

describe("ctx", () => {
  it("keeps a plain JSON object; drops empty, arrays, class instances, too long, cyclic", () => {
    expect(cleanCtx({ page: "/x", n: 2 })).toEqual({ page: "/x", n: 2 });
    expect(cleanCtx({})).toBeUndefined();
    expect(cleanCtx([1])).toBeUndefined();
    expect(cleanCtx(new Date())).toBeUndefined();
    expect(cleanCtx("s")).toBeUndefined();
    expect(cleanCtx({ s: "x".repeat(MAX_CTX) })).toBeUndefined();
    const c: Record<string, unknown> = {};
    c.c = c;
    expect(cleanCtx(c)).toBeUndefined();
  });
  it("rides a chat line through parsePageMessage; a line without it is unchanged", () => {
    expect(
      parsePageMessage(JSON.stringify({ type: "chat", id: "1", text: "hi", ctx: { a: 1 } })),
    ).toEqual({
      type: "chat",
      id: "1",
      text: "hi",
      ctx: { a: 1 },
    });
    expect(parsePageMessage(JSON.stringify({ type: "chat", id: "1", text: "hi" }))).toEqual({
      type: "chat",
      id: "1",
      text: "hi",
    });
    expect(
      parsePageMessage(JSON.stringify({ type: "chat", id: "1", text: "hi", ctx: [1] })),
    ).toEqual({
      type: "chat",
      id: "1",
      text: "hi",
    });
  });
});
