import { describe, expect, it } from "bun:test";
import {
  assigneeOf,
  countOpen,
  crumbs,
  filterNeedsOwner,
  findLinks,
  frontier,
  localeChain,
  parseTree,
  parseTreeDoc,
} from "../src/state-tree.ts";
import { type TreeNode, watchTree } from "../src/tree.ts";

type N7 = [TreeNode, TreeNode, TreeNode, TreeNode, TreeNode, TreeNode, TreeNode];

// Mirrors snolab/lianki unit/state-tree.test.ts (the parser is the same file).
const opts = { repo: "acme/app" };

describe("parseTree", () => {
  it("reads headings, boxes, (!), actions, notes and nesting", () => {
    const md = [
      "# Title (ignored)",
      "",
      "Legend: [ ] open (ignored)",
      "",
      "## Owner",
      "- [ ] (!) Merge #12",
      "      → gh pr merge 12",
      "- Payments",
      "  - [x] Keys set",
      "  - [ ] (!) Webhook → https://example.com/hook",
      "        (two events)",
      "        → bunx a",
      "        → bunx b",
      "        → https://example.com/hook",
      "        → https://example.com/docs",
      "## Later",
      "- Plain idea",
    ].join("\n");
    const t = parseTree(md, opts);
    expect(t.map((n) => n.title)).toEqual(["Owner", "Later"]);
    const [merge, pay] = t[0]!.children as N7;
    expect(merge).toEqual({
      title: "Merge #12",
      status: "open",
      done: false,
      needsOwner: true,
      action: "gh pr merge 12",
      links: [{ text: "#12", url: "https://github.com/acme/app/pull/12" }],
      children: [],
    });
    expect(pay.done).toBeUndefined();
    expect(pay.children.map((c) => [c.title, c.done, !!c.needsOwner])).toEqual([
      ["Keys set", true, false],
      ["Webhook → https://example.com/hook", false, true],
    ]);
    const hook = pay.children[1]!;
    expect(hook.note).toBe("(two events)");
    expect(hook.action).toBe("bunx a\nbunx b\nhttps://example.com/hook\nhttps://example.com/docs");
    expect(hook.links.map((l) => l.url)).toEqual([
      "https://example.com/hook",
      "https://example.com/docs",
    ]);
    expect(t[1]!.children[0]!.title).toBe("Plain idea");
  });

  it("keeps CJK text and wide punctuation intact", () => {
    const t = parseTree(
      "## 学习伙伴\n- [ ] (!) 确认：删除旧页面（#7）\n  - [x] 日本語のテスト 完了\n",
      opts,
    );
    expect(t[0]!.title).toBe("学习伙伴");
    const item = t[0]!.children[0]!;
    expect(item.title).toBe("确认：删除旧页面（#7）");
    expect(item.needsOwner).toBe(true);
    expect(item.links).toEqual([{ text: "#7", url: "https://github.com/acme/app/pull/7" }]);
    expect(item.children[0]!.title).toBe("日本語のテスト 完了");
    expect(item.children[0]!.done).toBe(true);
  });

  it("survives malformed indentation", () => {
    const md = [
      "- top before any heading",
      "      - jumps three levels",
      "   - between levels",
      "\t- a tab",
      "- [X] capital X",
      "-not an item",
      "    → orphan action goes to the last item",
      "→ unindented action is ignored",
    ].join("\n");
    const t = parseTree(md);
    expect(t.map((n) => n.title)).toEqual(["top before any heading", "capital X"]);
    expect(t[0]!.children.map((n) => n.title)).toEqual([
      "jumps three levels",
      "between levels",
      "a tab",
    ]);
    expect(t[1]!.done).toBe(true);
    expect(t[1]!.note).toBeUndefined(); // not indented past its item
    expect(t[1]!.action).toBe("orphan action goes to the last item");
  });

  it("handles empty input, CRLF and empty actions", () => {
    expect(parseTree("")).toEqual([]);
    const t = parseTree("## A\r\n- [ ] b\r\n  →   \r\n");
    expect(t[0]!.children[0]!).toEqual({
      title: "b",
      status: "open",
      done: false,
      links: [],
      children: [],
    });
  });

  it("a paragraph under a heading is its note; a # title ends the heading", () => {
    const t = parseTree("## A\nsome words\n# New doc\n- loose");
    expect(t[0]!.note).toBe("some words");
    expect(t.map((n) => n.title)).toEqual(["A", "loose"]);
  });
});

describe("findLinks", () => {
  it("links owner/repo#N, bare #N only with a repo, and URLs once", () => {
    const s = "see snolab/liagent#1, #2 and https://x.dev/a. again https://x.dev/a";
    expect(findLinks(s, opts)).toEqual([
      { text: "snolab/liagent#1", url: "https://github.com/snolab/liagent/pull/1" },
      { text: "#2", url: "https://github.com/acme/app/pull/2" },
      { text: "https://x.dev/a", url: "https://x.dev/a" },
    ]);
    expect(findLinks("#2 a&#39;b c#3", {})).toEqual([]);
    expect(findLinks("#5", { repo: "o/r", host: "https://gh.example/" })[0]!.url).toBe(
      "https://gh.example/o/r/pull/5",
    );
  });
});

describe("counts and the Needs me filter", () => {
  const t = parseTree(
    [
      "## A",
      "- [ ] (!) one",
      "  - [ ] child",
      "  - [x] (!) done child",
      "- [x] (!) closed",
      "- group",
      "  - [ ] (!) deep",
      "## B",
      "- [ ] nothing for you",
    ].join("\n"),
  );
  it("counts open and needs-you items below a node", () => {
    expect(countOpen(t[0]!)).toEqual({ open: 3, needsOwner: 2 });
    expect(countOpen(t[1]!)).toEqual({ open: 1, needsOwner: 0 });
  });
  it("keeps only open (!) items and their ancestors", () => {
    const f = filterNeedsOwner(t);
    expect(f.map((n) => n.title)).toEqual(["A"]);
    expect(f[0]!.children.map((n) => n.title)).toEqual(["one", "group"]);
    expect(f[0]!.children[0]!.children).toEqual([]);
    expect(f[0]!.children[1]!.children.map((n) => n.title)).toEqual(["deep"]);
  });
});

describe("statuses, markers, assignees, summaries", () => {
  it("reads [~] [!] (any order), (done …), @assignee and inherits it", () => {
    const t = parseTree(
      [
        "<!-- ## not a heading",
        "- [ ] not an item -->",
        "## Lane (any order) @main-lane",
        "- [~] doing it",
        "- [!] blocked",
        "- [x] shipped (done 2026-10-30 01:12) @words-agent#a89eb1",
        "  - [ ] child of words",
        "- [ ] ask @owner",
        "- [ ] owner with id @owner#abc",
        "- [ ] bad id @bot#host.example.com:22",
        "- [ ] mid @mention stays in the title",
      ].join("\n"),
    );
    expect(t.length).toBe(1);
    const [lane] = t as N7;
    expect(lane.title).toBe("Lane");
    expect(lane.unordered).toBe(true);
    expect(lane.assignee).toEqual({ type: "agent", name: "main-lane" });
    const [doing, blocked, shipped, ask, ownerId, bad, mid] = lane.children as N7;
    expect([doing.status, blocked.status, shipped.status]).toEqual(["doing", "blocked", "done"]);
    expect([doing.done, blocked.done, shipped.done]).toEqual([false, false, true]);
    expect(doing.assignee?.name).toBe("main-lane");
    expect(shipped.title).toBe("shipped");
    expect(shipped.doneAt).toBe("2026-10-30T01:12");
    expect(shipped.assignee).toEqual({ type: "agent", name: "words-agent", id: "a89eb1" });
    expect(shipped.children[0]!.assignee?.name).toBe("words-agent");
    expect(ask.assignee).toEqual({ type: "human", name: "owner" });
    expect(ask.title).toBe("ask");
    expect(ownerId.assignee).toEqual({ type: "human", name: "owner" });
    expect(bad.assignee).toEqual({ type: "agent", name: "bot" });
    expect(bad.title).toBe("bad id");
    expect(mid.title).toBe("mid @mention stays in the title");
    expect(assigneeOf("x", "a".repeat(41))).toEqual({ type: "agent", name: "x" });
  });

  it("reads ≈ summaries per locale, on the tree and on nodes", () => {
    const doc = parseTreeDoc(
      [
        "# T",
        "≈ done: 捷报频传 · doing: 多线并进 · next: 蓄势待发",
        "≈en done: Wins keep coming",
        "≈ nothing here",
        "## A",
        "≈ next：来日方长",
        "- [ ] x",
        "  ≈ja done: 順調",
      ].join("\n"),
    );
    expect(doc.summaries).toEqual({
      zh: { done: "捷报频传", doing: "多线并进", next: "蓄势待发" },
      en: { done: "Wins keep coming" },
    });
    expect(doc.children[0]!.summaries).toEqual({ zh: { next: "来日方长" } });
    expect(doc.children[0]!.children[0]!.summaries).toEqual({ ja: { done: "順調" } });
  });

  it("localeChain falls back to zh, then en", () => {
    expect(localeChain("zh-CN")).toEqual(["zh-cn", "zh", "en"]);
    expect(localeChain("ja")).toEqual(["ja", "zh", "en"]);
    expect(localeChain()).toEqual(["zh", "en"]);
  });
});

describe("frontier", () => {
  it("is empty for empty input and an unknown scope", () => {
    expect(frontier([])).toEqual({});
    expect(frontier(parseTree(""))).toEqual({});
    expect(frontier(parseTree("## A\n- [ ] x"), { scope: ["B"] })).toEqual({});
  });

  it("everything done: only the done line, the last in file order", () => {
    const f = frontier(parseTree("## A\n- [x] one\n- [x] two\n## B\n- [x] three"));
    expect(f.doing).toBeUndefined();
    expect(f.next).toBeUndefined();
    expect(f.done?.title).toBe("three");
    expect(f.done?.path).toEqual(["B"]);
    expect(f.done?.count).toBe(3);
    expect(f.done?.summary).toBeUndefined();
    expect(f.done?.items.map((i) => i.title)).toEqual(["one", "two", "three"]);
  });

  it("done: the latest (done …) date wins over file order", () => {
    const f = frontier(
      parseTree("- [x] a (done 2026-10-30T09:00)\n- [x] b (done 2026-10-29)\n- [x] c"),
    );
    expect(f.done?.title).toBe("a");
  });

  it("an open (!) item comes before [~]; next is the first not started", () => {
    const t = parseTree(
      [
        "## Agent",
        "- [x] old",
        "- [ ] first open @bot",
        "- group",
        "  - [~] working @bot",
        "  - [ ] after working",
        "## Owner",
        "- [ ] (!) decide @owner",
        "- [!] stuck",
      ].join("\n"),
    );
    const f = frontier(t);
    expect(f.doing?.title).toBe("decide");
    expect(f.doing?.assignee).toEqual({ type: "human", name: "owner" });
    expect(f.doing?.items.map((i) => [i.title, i.assignee?.name])).toEqual([
      ["decide", "owner"],
      ["working", "bot"],
    ]);
    // Now is the owner's: next is the first agent item not started.
    expect(f.next?.title).toBe("first open");
    expect(f.next?.items.map((i) => i.title)).toEqual(["first open", "after working"]);
    // Without the owner item: in progress is [~], next comes after it (nested).
    const g = frontier(t, { scope: ["Agent"] });
    expect(g.doing?.title).toBe("working");
    expect(g.doing?.path).toEqual(["Agent", "group"]);
    expect(crumbs(g.doing!.path)).toBe("Agent › group");
    expect(g.next?.title).toBe("after working");
  });

  it("falls back to the first [ ] when nothing is in progress or past the last [~]", () => {
    const f = frontier(parseTree("- [ ] a\n- [~] b\n- [x] c"));
    expect(f.doing?.title).toBe("b");
    expect(f.next?.title).toBe("a");
  });

  it("an (any order) parent puts its [~] children first", () => {
    const t = parseTree("## A (any order)\n- [ ] x\n- [!] y\n- [~] z\n- [ ] w");
    const f = frontier(t);
    expect(f.doing?.title).toBe("z");
    expect(f.next?.title).toBe("x");
    expect(f.next?.items.map((i) => i.title)).toEqual(["x", "w"]);
  });

  it("groups take the ≈ summary of their nearest common ancestor, by locale", () => {
    const md = [
      "≈ done: 捷报频传 · doing: 多线并进 · next: 蓄势待发",
      "≈en done: Wins keep coming · next: Ready to go",
      "## A",
      "≈ next: 来日方长",
      "- [x] a1",
      "- [ ] a2",
      "- [ ] a3",
      "## B",
      "- [x] b1",
      "- [~] b2",
    ].join("\n");
    const doc = parseTreeDoc(md);
    const zh = frontier(doc, { locale: "zh-CN" });
    expect(zh.done?.summary).toBe("捷报频传");
    expect(zh.done?.count).toBe(2);
    expect(zh.done?.title).toBe("b1");
    expect(zh.doing?.summary).toBeUndefined(); // one item: its title
    expect(zh.doing?.title).toBe("b2");
    expect(zh.next?.summary).toBe("来日方长"); // A is the common ancestor
    expect(frontier(doc, { locale: "en" }).done?.summary).toBe("Wins keep coming");
    expect(frontier(doc, { locale: "en" }).next?.summary).toBe("来日方长"); // A has zh only
    expect(frontier(doc, { locale: "ja" }).done?.summary).toBe("捷报频传");
    // Without the document's summaries (nodes only), a cross-heading group has none.
    expect(frontier(doc.children).done?.summary).toBeUndefined();
  });
});

describe("watchTree", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  it("a function source loads once; a feed pushes every update until stopped", async () => {
    const got: [string, boolean][] = [];
    watchTree(
      () => "## A",
      {},
      (r, live) => got.push([r.children[0]!.title, live]),
      () => {},
    );
    await tick();
    expect(got).toEqual([["A", false]]);

    let push: ((v: string, m?: { live?: boolean }) => void) | undefined;
    let off = 0;
    const stop = watchTree(
      { subscribe: (fn) => ((push = fn), () => void off++) },
      {},
      (r, live) => got.push([r.children[0]!.title, live]),
      () => {},
    );
    push!("## B", { live: true });
    push!("## C");
    stop();
    push!("## D", { live: true });
    expect(got.slice(1)).toEqual([
      ["B", true],
      ["C", false],
    ]);
    expect(off).toBe(1);
  });
  it("reports a failing source", async () => {
    const errors: unknown[] = [];
    watchTree(
      async () => {
        throw new Error("nope");
      },
      {},
      () => {},
      (e) => errors.push(e),
    );
    await tick();
    expect((errors[0]! as Error).message).toBe("nope");
  });
});
