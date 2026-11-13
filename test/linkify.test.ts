import { describe, expect, it } from "bun:test";
import { linkParts, linkify, sameOrigin, trimUrl } from "../src/linkify.ts";

type FakeEl = { tag: string; href?: string; target?: string; rel?: string; textContent?: string };
const doc = {
  createTextNode: (data: string) => ({ data }),
  createElement: (tag: string) => ({ tag }),
} as unknown as Document;

const urls = (s: string) => linkParts(s).flatMap((p) => ("url" in p ? [p.url] : []));

describe("linkParts: boundaries", () => {
  it("keeps trailing punctuation and quotes outside", () => {
    for (const end of [".", ",", ";", ":", "!", "?", ")", "]", "}", "'", '"', "...", ")."])
      expect(urls(`see https://a.example/x${end} next`)).toEqual(["https://a.example/x"]);
    expect(urls("(https://a.example/x)")).toEqual(["https://a.example/x"]);
  });
  it("keeps balanced parens inside", () => {
    expect(urls("wiki https://en.wikipedia.org/wiki/Foo_(bar)).")).toEqual([
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ]);
    expect(trimUrl("https://a.example/[x]")).toBe("https://a.example/[x]");
  });
  it("stops at Japanese punctuation and full-width spaces", () => {
    for (const stop of [
      "、",
      "。",
      "（",
      "）",
      "「",
      "」",
      "『",
      "』",
      "【",
      "】",
      "〔",
      "〕",
      "　",
    ])
      expect(urls(`「https://form.symval.net/a?b=1${stop}次`)).toEqual([
        "https://form.symval.net/a?b=1",
      ]);
  });
  it("keeps the text around links and handles several", () => {
    const parts = linkParts("a http://x.example b https://y.example/p?q=1#h c");
    expect(parts.map((p) => p.text).join("")).toBe(
      "a http://x.example b https://y.example/p?q=1#h c",
    );
    expect(urls("a http://x.example b HTTPS://y.example/p c")).toEqual([
      "http://x.example",
      "HTTPS://y.example/p",
    ]);
  });
  it("links nothing in plain text or bare schemes", () => {
    expect(linkParts("no links here")).toEqual([{ text: "no links here" }]);
    expect(urls("https:// and http://")).toEqual([]);
  });
});

describe("linkify: XSS", () => {
  it("never links javascript:, data: or other schemes", () => {
    expect(urls("javascript:alert(1) data:text/html,<b> ftp://x.example")).toEqual([]);
    expect(urls("xjavascript:https://a.example")).toEqual(["https://a.example"]);
  });
  it("keeps <script> as text and out of links", () => {
    const s = '<script>alert(1)</script> https://a.example/<script>"x';
    expect(urls(s)).toEqual(["https://a.example/"]);
    const nodes = linkify(s, doc, "https://form.symval.net") as unknown as (
      | FakeEl
      | { data: string }
    )[];
    expect(nodes[0]).toEqual({ data: "<script>alert(1)</script> " });
    expect((nodes[1] as FakeEl).href).toBe("https://a.example/");
    expect(nodes[2]).toEqual({ data: '<script>"x' });
  });
});

describe("linkify: same host vs external", () => {
  const page = "https://form.symval.net";
  it("external hosts open in a new tab with noopener noreferrer", () => {
    const [a] = linkify("https://evil.example/x", doc, page) as unknown as FakeEl[];
    expect(a).toEqual({
      tag: "a",
      href: "https://evil.example/x",
      textContent: "https://evil.example/x",
      target: "_blank",
      rel: "noopener noreferrer",
    });
  });
  it("same-origin links stay in the tab", () => {
    const [a] = linkify("https://form.symval.net/r/1", doc, page) as unknown as FakeEl[];
    expect(a!.target).toBeUndefined();
    expect(a!.rel).toBeUndefined();
    expect(a!.href).toBe("https://form.symval.net/r/1");
  });
  it("origin compares scheme, host and port", () => {
    expect(sameOrigin("http://form.symval.net/", page)).toBe(false);
    expect(sameOrigin("https://form.symval.net:8443/", page)).toBe(false);
    expect(sameOrigin("https://sub.form.symval.net/", page)).toBe(false);
    expect(sameOrigin("https://FORM.symval.net/x", page)).toBe(true);
    expect(sameOrigin("https://form.symval.net/", undefined)).toBe(false);
  });
});
