import { describe, expect, test } from "bun:test";
import {
  MAX_CHAT,
  type ChatMessage,
  applyEdit,
  dictatedDraft,
  draftSource,
  chatText,
  cleanLabel,
  matchesTarget,
  parseControllerMessage,
  parsePageMessage,
  pickLang,
  pickVoice,
  shortCode,
  summarize,
  trimHistory,
} from "../src/protocol.ts";

describe("parseControllerMessage", () => {
  test("say, with an optional thread", () => {
    expect(parseControllerMessage('{"type":"say","text":" hi "}')).toEqual({
      ok: true,
      value: { type: "say", text: "hi" },
    });
    expect(parseControllerMessage('{"type":"say","text":"hi","to":"u1"}')).toEqual({
      ok: true,
      value: { type: "say", text: "hi", to: "u1" },
    });
  });
  test("say needs text within MAX_CHAT", () => {
    expect(parseControllerMessage('{"type":"say","text":"  "}').ok).toBe(false);
    const long = JSON.stringify({ type: "say", text: "x".repeat(MAX_CHAT + 1) });
    expect(parseControllerMessage(long).ok).toBe(false);
  });
  test("busy: optional thread; on:false kept for older clients", () => {
    expect(parseControllerMessage('{"type":"busy"}')).toEqual({
      ok: true,
      value: { type: "busy" },
    });
    expect(parseControllerMessage('{"type":"busy","to":"a@x.com"}')).toEqual({
      ok: true,
      value: { type: "busy", to: "a@x.com" },
    });
    expect(parseControllerMessage('{"type":"busy","on":false}')).toEqual({
      ok: true,
      value: { type: "busy", on: false },
    });
  });
  test("eval needs code", () => {
    expect(parseControllerMessage('{"type":"eval","code":"1+1","target":"/x"}')).toEqual({
      ok: true,
      value: { type: "eval", code: "1+1", target: "/x" },
    });
    expect(parseControllerMessage('{"type":"eval","code":" "}').ok).toBe(false);
  });
  test("junk is an error", () => {
    expect(parseControllerMessage("nope").ok).toBe(false);
    expect(parseControllerMessage("[1]").ok).toBe(false);
    expect(parseControllerMessage('{"type":"other"}').ok).toBe(false);
  });
});

describe("parsePageMessage", () => {
  test("chat, allow, deny, revoke, result", () => {
    expect(parsePageMessage('{"type":"chat","id":"a","text":"hi"}')).toEqual({
      type: "chat",
      id: "a",
      text: "hi",
    });
    expect(parsePageMessage('{"type":"allow","pair":"p","scope":"chat"}')).toEqual({
      type: "allow",
      pair: "p",
      scope: "chat",
    });
    expect(parsePageMessage('{"type":"allow","pair":"p","scope":"root"}')).toEqual({
      type: "allow",
      pair: "p",
    });
    expect(parsePageMessage('{"type":"revoke","pair":"p"}')).toEqual({ type: "revoke", pair: "p" });
    expect(parsePageMessage('{"type":"result","id":"i","to":"p","ok":true,"value":"2"}')).toEqual({
      type: "result",
      id: "i",
      to: "p",
      ok: true,
      value: "2",
      error: undefined,
      stack: undefined,
      ms: undefined,
    });
  });
  test("allow with pages, page, end-page", () => {
    expect(parsePageMessage('{"type":"allow","pair":"p","pages":"all"}')).toEqual({
      type: "allow",
      pair: "p",
      pages: "all",
    });
    expect(parsePageMessage('{"type":"allow","pair":"p","pages":["a",1,""]}')).toEqual({
      type: "allow",
      pair: "p",
      pages: ["a"],
    });
    expect(parsePageMessage('{"type":"page","label":"/x"}')).toEqual({ type: "page", label: "/x" });
    expect(parsePageMessage('{"type":"end-page","id":"a"}')).toEqual({ type: "end-page", id: "a" });
    expect(parsePageMessage('{"type":"page"}')).toBeNull();
  });
  test("anything incomplete is dropped", () => {
    expect(parsePageMessage('{"type":"chat","id":"a"}')).toBeNull();
    expect(parsePageMessage('{"type":"allow"}')).toBeNull();
    expect(parsePageMessage('{"type":"result","id":"i"}')).toBeNull();
    expect(parsePageMessage("{")).toBeNull();
  });
});

test("chatText trims and bounds", () => {
  expect(chatText(" a ")).toBe("a");
  expect(chatText("")).toBeUndefined();
  expect(chatText(1)).toBeUndefined();
});

test("trimHistory keeps the newest", () => {
  const list = Array.from({ length: 5 }, (_, i) => ({
    id: String(i),
    from: "owner" as const,
    label: "",
    text: "t",
    at: i,
  }));
  expect(trimHistory(list, 2).map((m) => m.id)).toEqual(["3", "4"]);
});

test("pickLang reads the script", () => {
  expect(pickLang("こんにちは")).toBe("ja-JP");
  expect(pickLang("漢字とかな")).toBe("ja-JP");
  expect(pickLang("안녕하세요")).toBe("ko-KR");
  expect(pickLang("你好")).toBe("zh-CN");
  expect(pickLang("hello")).toBe("en-US");
});

test("pickVoice: exact locale, else the language, default first", () => {
  const voices = [
    { lang: "en-GB", name: "a" },
    { lang: "ja_JP", name: "b" },
    { lang: "en-US", name: "c", default: true },
  ];
  expect(pickVoice(voices, "ja-JP")?.name).toBe("b");
  expect(pickVoice(voices, "en-AU")?.name).toBe("c");
  expect(pickVoice(voices, "ko-KR")).toBeUndefined();
});

test("cleanLabel, shortCode, matchesTarget", () => {
  expect(cleanLabel(" a\nb\u0007 ")).toBe("a b");
  expect(shortCode(new Uint8Array([0xab, 0x01, 0xff]))).toBe("ab01");
  expect(matchesTarget("/words Safari", "words")).toBe(true);
  expect(matchesTarget("/words Safari", "lab")).toBe(false);
  expect(matchesTarget("x", undefined)).toBe(true);
});

test("summarize survives cycles and odd values", () => {
  const a: Record<string, unknown> = { n: 1n };
  a.self = a;
  expect(summarize(a)).toBe('{"n":"1n","self":"[circular]"}');
  expect(summarize(undefined)).toBe('"[undefined]"');
  expect(summarize("x".repeat(20), 5)).toBe('"xxxx…[17 more]');
});

describe("voice edits on the wire", () => {
  test("a page's chat keeps source stt and drops any other source", () => {
    expect(
      parsePageMessage(JSON.stringify({ type: "chat", id: "a", text: "hi", source: "stt" })),
    ).toEqual({ type: "chat", id: "a", text: "hi", source: "stt" });
    expect(
      parsePageMessage(JSON.stringify({ type: "chat", id: "a", text: "hi", source: "x" })),
    ).toEqual({ type: "chat", id: "a", text: "hi" });
  });

  test("a controller's edit needs an id and text", () => {
    expect(
      parseControllerMessage(JSON.stringify({ type: "edit", id: "m1", text: " Hi. " })),
    ).toEqual({ ok: true, value: { type: "edit", id: "m1", text: "Hi." } });
    expect(parseControllerMessage(JSON.stringify({ type: "edit", text: "Hi." })).ok).toBe(false);
    expect(parseControllerMessage(JSON.stringify({ type: "edit", id: "m1", text: "" })).ok).toBe(
      false,
    );
  });

  test("a draft is stt only while nothing typed is in it", () => {
    const a = dictatedDraft("", null, "hello there");
    expect(draftSource("hello there", a)).toBe("stt");
    expect(draftSource("hello there!", a)).toBeUndefined();
    const b = dictatedDraft("hello there", a, "hello there. And more");
    expect(draftSource("hello there. And more", b)).toBe("stt");
    expect(dictatedDraft("typed ", null, "typed and spoken")).toBeNull();
    expect(draftSource("typed and spoken", null)).toBeUndefined();
    expect(draftSource("", "")).toBeUndefined();
  });

  test("applyEdit updates only the matching line of the matching thread", () => {
    const e = {
      id: "m1",
      thread: "owner",
      text: "Hi.",
      raw: "hi",
      edited: { at: 1, by: "a", count: 1 },
    };
    const m: ChatMessage = { id: "m1", from: "owner", label: "", text: "hi", at: 0, source: "stt" };
    expect(applyEdit(m, e)).toEqual({ ...m, text: "Hi.", raw: "hi", edited: e.edited });
    expect(applyEdit({ ...m, id: "m2" }, e)).toEqual({ ...m, id: "m2" });
    expect(applyEdit({ ...m, thread: "f1" }, e)).toEqual({ ...m, thread: "f1" });
  });
});
