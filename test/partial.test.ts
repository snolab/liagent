import { describe, expect, it } from "bun:test";
import { partialTail } from "../src/input.ts";
import { frontierView } from "../src/frontier-view.ts";
import { frontier, parseTreeDoc } from "../src/state-tree.ts";

describe("partialTail", () => {
  it("nothing for no partial", () => {
    expect(partialTail("hi", null)).toBe("");
    expect(partialTail("hi", "  ")).toBe("");
  });
  it("a space between words, none after a space or on an empty draft", () => {
    expect(partialTail("hello", "world")).toBe(" world");
    expect(partialTail("hello ", "world")).toBe("world");
    expect(partialTail("", "world")).toBe("world");
    expect(partialTail("line\n", "two")).toBe("two");
  });
  it("no space next to CJK text", () => {
    expect(partialTail("你好", "世界")).toBe("世界");
    expect(partialTail("ok", "世界")).toBe("世界");
    expect(partialTail("こんにちは。", "world")).toBe("world");
  });
});

describe("frontierView", () => {
  it("nothing to show: undefined", () => {
    expect(frontierView(frontier(parseTreeDoc("## A\n")))).toBeUndefined();
  });
  it("one item: its title; a group: its summary, count and items with breadcrumbs", () => {
    const md = `
≈en done: Wins · doing: Many fronts · next: Ready
## A
- [x] shipped
- [~] build @lane#abc123
- [~] test
- [ ] later
`;
    const v = frontierView(frontier(parseTreeDoc(md), { locale: "en" }))!;
    expect(v.done).toEqual({ text: "shipped", count: 1 });
    expect(v.doing?.text).toBe("Many fronts");
    expect(v.doing?.count).toBe(2);
    expect(v.doing?.assignee).toEqual({ type: "agent", name: "lane", id: "abc123" });
    expect(v.doing?.items?.map((i) => [i.title, i.path])).toEqual([
      ["build", "A"],
      ["test", "A"],
    ]);
    expect(v.next).toEqual({ text: "later", count: 1 });
  });
});
