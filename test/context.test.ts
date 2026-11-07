import { describe, expect, it } from "bun:test";
import {
  MAX_CONTEXT_FILES,
  MAX_SELECTION,
  cleanContext,
  mergeContext,
  parsePageMessage,
} from "../src/protocol.ts";
import { contextText, deliveryText } from "../src/deliver.ts";

describe("cleanContext", () => {
  it("keeps known keys only, each bounded; the path loses its query", () => {
    const c = cleanContext({
      selection: `${"s".repeat(MAX_SELECTION + 10)} `,
      path: "/a/b?token=x#frag",
      title: " Some \n title ",
      host: "example.com:8080",
      evil: "<script>",
    });
    expect(c?.selection?.length).toBe(MAX_SELECTION);
    expect(c?.path).toBe("/a/b");
    expect(c?.title).toBe("Some title");
    expect(c?.host).toBe("example.com:8080");
    expect(c && "evil" in c).toBe(false);
  });
  it("no selection and no file: no context", () => {
    expect(cleanContext({ path: "/a", title: "t" })).toBeUndefined();
    expect(cleanContext({ selection: "   " })).toBeUndefined();
    expect(cleanContext("nope")).toBeUndefined();
    expect(cleanContext([{ selection: "x" }])).toBeUndefined();
  });
  it("files: http(s) or same-origin URLs only, named, at most MAX_CONTEXT_FILES", () => {
    const c = cleanContext({
      files: [
        { name: "ok.png", url: "https://x.example/ok.png", type: "image/png", size: 12.7 },
        { name: "rel", url: "/uploads/1" },
        { name: "js", url: "javascript:alert(1)" },
        { name: "proto", url: "//evil.example/x" },
        { name: "data", url: "data:text/html,hi" },
        { name: "", url: "https://x.example/noname" },
        { name: "badtype", url: "/b", type: "not a type" },
      ],
    });
    expect(c?.files).toEqual([
      { name: "ok.png", url: "https://x.example/ok.png", type: "image/png", size: 12 },
      { name: "rel", url: "/uploads/1" },
      { name: "badtype", url: "/b" },
    ]);
    const many = cleanContext({
      files: Array.from({ length: 20 }, (_, i) => ({ name: `f${i}`, url: `/f${i}` })),
    });
    expect(many?.files?.length).toBe(MAX_CONTEXT_FILES);
  });
  it("a bad host is dropped", () => {
    expect(cleanContext({ selection: "x", host: "evil.com/path" })?.host).toBeUndefined();
  });
});

describe("mergeContext", () => {
  it("the newer selection wins with its page; files add up, the same URL once", () => {
    const m = mergeContext(
      { selection: "old", path: "/old", files: [{ name: "a", url: "/a" }] },
      {
        selection: "new",
        path: "/new",
        files: [
          { name: "a", url: "/a" },
          { name: "b", url: "/b" },
        ],
      },
    );
    expect(m).toEqual({
      selection: "new",
      path: "/new",
      files: [
        { name: "a", url: "/a" },
        { name: "b", url: "/b" },
      ],
    });
    expect(
      mergeContext({ selection: "keep", path: "/k" }, { files: [{ name: "f", url: "/f" }] }),
    ).toEqual({ selection: "keep", path: "/k", files: [{ name: "f", url: "/f" }] });
  });
});

describe("the wire", () => {
  it("a page's chat line carries its cleaned context", () => {
    const m = parsePageMessage(
      JSON.stringify({
        type: "chat",
        id: "c1",
        text: "what does this mean?",
        context: { selection: "a phrase", path: "/doc?x=1", extra: 1 },
      }),
    );
    expect(m).toEqual({
      type: "chat",
      id: "c1",
      text: "what does this mean?",
      context: { selection: "a phrase", path: "/doc" },
    });
  });
  it("a context that cleans to nothing is left off", () => {
    const m = parsePageMessage(
      JSON.stringify({ type: "chat", id: "c1", text: "hi", context: { path: "/x" } }),
    );
    expect(m).toEqual({ type: "chat", id: "c1", text: "hi" });
  });
});

describe("delivery", () => {
  it("quotes the selection as data after the text, with its page and files", () => {
    const t = contextText({
      selection: "line one\nline two",
      title: "Doc",
      path: "/doc",
      files: [{ name: "a.png", url: "https://x.example/a.png", type: "image/png" }],
    });
    expect(t).toBe(
      '\n\n[attached: selection from "Doc" /doc]\n> line one\n> line two\n[attached: file a.png (image/png): https://x.example/a.png]',
    );
    expect(contextText(undefined)).toBe("");
    const d = deliveryText(
      "https://hub",
      {
        id: "m1",
        from: "owner",
        label: "/doc ua",
        text: "explain",
        at: 0,
        context: { selection: "x" },
      },
      () => "",
    );
    expect(d.endsWith("explain\n\n[attached: selection]\n> x")).toBe(true);
  });
});
