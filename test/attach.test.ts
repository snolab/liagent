import { describe, expect, it } from "bun:test";
import {
  type ChatAction,
  type ElLike,
  type SelectionDoc,
  SELECTION_TTL_MS,
  actionEnabled,
  actionsAt,
  createSelectionMemory,
  fileAction,
  isSensitive,
  menuGroups,
  readSelection,
  selectionAction,
} from "../src/attach.ts";
import { MAX_SELECTION } from "../src/protocol.ts";

const a = (id: string, more: Partial<ChatAction> = {}): ChatAction => ({ id, label: id, ...more });

describe("actions: where each goes", () => {
  it("places by `place` (menu by default), in the host's order, a duplicate id once", () => {
    const list = [
      a("sel"),
      a("tree", { place: "leading" }),
      a("file", { group: "Attach" }),
      a("sel", { place: "trailing" }),
      a("status", { place: "trailing" }),
    ];
    expect(actionsAt(list, "menu").map((x) => x.id)).toEqual(["sel", "file"]);
    expect(actionsAt(list, "leading").map((x) => x.id)).toEqual(["tree"]);
    expect(actionsAt(list, "trailing").map((x) => x.id)).toEqual(["status"]);
  });
  it("a feature moves from the bar into the menu by its place alone", () => {
    const tree = a("tree", { place: "leading" });
    expect(actionsAt([tree], "menu")).toEqual([]);
    expect(actionsAt([{ ...tree, place: "menu" }], "menu").map((x) => x.id)).toEqual(["tree"]);
  });
  it("groups the menu: ungrouped first, then each group in first-seen order", () => {
    const g = menuGroups([
      a("x", { group: "Add" }),
      a("y"),
      a("z", { group: "Attach" }),
      a("w", { group: "Add" }),
    ]);
    expect(g.map((x) => [x.group, x.items.map((i) => i.id)])).toEqual([
      [undefined, ["y"]],
      ["Add", ["x", "w"]],
      ["Attach", ["z"]],
    ]);
  });
  it("enabled(): absent is on; false or a throw is off", () => {
    expect(actionEnabled(a("x"))).toBe(true);
    expect(actionEnabled(a("x", { enabled: () => false }))).toBe(false);
    expect(
      actionEnabled(
        a("x", {
          enabled: () => {
            throw new Error("boom");
          },
        }),
      ),
    ).toBe(false);
  });
});

// A fake DOM: elements with a chat flag and a sensitive flag.
type FakeEl = ElLike & { chat?: boolean; sensitive?: boolean };
const el = (o: Partial<FakeEl> = {}): FakeEl => ({
  nodeType: 1,
  tagName: "P",
  closest: (sel: string) =>
    (sel.includes("data-sensitive") && o.sensitive) || (sel.includes("liagent-chat") && o.chat)
      ? {}
      : null,
  ...o,
});

function fakeDoc() {
  const handlers = new Map<string, (e: { target: unknown }) => void>();
  const state = {
    active: null as FakeEl | null,
    text: "",
    anchor: el() as FakeEl,
    fenced: [] as unknown[],
    crosses: false,
  };
  const doc: SelectionDoc = {
    get activeElement() {
      return state.active;
    },
    getSelection: () => ({
      rangeCount: state.text ? 1 : 0,
      isCollapsed: !state.text,
      anchorNode: state.anchor,
      focusNode: state.anchor,
      toString: () => state.text,
      getRangeAt: () => ({ intersectsNode: () => state.crosses }),
    }),
    querySelectorAll: () => state.fenced,
    addEventListener: (t, f) => void handlers.set(t, f),
    removeEventListener: (t) => void handlers.delete(t),
  };
  return { doc, state, handlers };
}
const inChat = (n: unknown) => !!(n as FakeEl | null)?.chat;

describe("page selection", () => {
  it("never reads password, one-time-code or card fields, or [data-sensitive]", () => {
    expect(isSensitive(el({ tagName: "INPUT", type: "password" }))).toBe(true);
    expect(isSensitive(el({ tagName: "INPUT", getAttribute: () => "one-time-code" }))).toBe(true);
    expect(isSensitive(el({ tagName: "INPUT", getAttribute: () => "cc-number" }))).toBe(true);
    expect(isSensitive(el({ sensitive: true }))).toBe(true);
    expect(isSensitive(el({ tagName: "INPUT", type: "text", getAttribute: () => null }))).toBe(
      false,
    );
  });
  it("reads a field's selected text, and leaves a sensitive field alone", () => {
    const { doc, state } = fakeDoc();
    state.active = el({
      tagName: "TEXTAREA",
      value: "hello world",
      selectionStart: 6,
      selectionEnd: 11,
    });
    expect(readSelection({ doc, inChat })).toBe("world");
    state.active = el({
      tagName: "INPUT",
      type: "password",
      value: "secret",
      selectionStart: 0,
      selectionEnd: 6,
    });
    expect(readSelection({ doc, inChat })).toBeNull();
  });
  it("a host's own fence covers fields and selections too", () => {
    const { doc, state } = fakeDoc();
    const priv = (o: Partial<FakeEl>) =>
      el({ ...o, closest: (sel: string) => (sel.includes(".private") ? {} : null) });
    state.active = priv({
      tagName: "TEXTAREA",
      value: "secret",
      selectionStart: 0,
      selectionEnd: 6,
    });
    expect(readSelection({ doc, inChat, fence: ".private" })).toBeNull();
    state.active = null;
    state.text = "secret";
    state.anchor = priv({});
    expect(readSelection({ doc, inChat, fence: ".private" })).toBeNull();
    expect(readSelection({ doc, inChat })).toBe("secret");
  });
  it("a selection in the chat, or one crossing a fenced part, is left alone", () => {
    const { doc, state } = fakeDoc();
    state.text = "inside";
    state.anchor = el({ chat: true });
    expect(readSelection({ doc, inChat })).toBeNull();
    state.anchor = el();
    state.fenced = [{}];
    state.crosses = true;
    expect(readSelection({ doc, inChat })).toBeNull();
    state.crosses = false;
    expect(readSelection({ doc, inChat })).toBe("inside");
  });
  it("remembers the last selection while the chat takes the focus, caps it, forgets it later", () => {
    const { doc, state } = fakeDoc();
    let now = 1000;
    const m = createSelectionMemory({
      doc,
      inChat,
      where: () => ({ path: "/docs/page?q=1#x", title: "  A   page " }),
      now: () => now,
    });
    m.start();
    state.text = `  ${"x".repeat(MAX_SELECTION + 50)}  `;
    m._events.onChange();
    const got = m.get()!;
    expect(got.selection.length).toBe(MAX_SELECTION);
    expect(got.path).toBe("/docs/page");
    expect(got.title).toBe("A page");
    // The input takes the focus: the page's selection collapses, the memory keeps it.
    m._events.onDown({ target: el({ chat: true }) });
    state.text = "";
    state.active = el({ chat: true });
    m._events.onChange();
    expect(m.get()).not.toBeNull();
    // Too old: gone.
    now += SELECTION_TTL_MS + 1;
    expect(m.get()).toBeNull();
  });
  it("a press elsewhere on the page that leaves nothing selected lets it go", () => {
    const { doc, state } = fakeDoc();
    const m = createSelectionMemory({ doc, inChat, where: () => ({}) });
    state.text = "words";
    m._events.onChange();
    expect(m.get()?.selection).toBe("words");
    m._events.onDown({ target: el() });
    state.text = "";
    state.active = null;
    m._events.onChange();
    expect(m.get()).toBeNull();
  });
  it("selectionAction: on only with a selection, attaches it with its page, a send lets it go", async () => {
    const { doc, state } = fakeDoc();
    const memory = createSelectionMemory({
      doc,
      inChat,
      where: () => ({ path: "/p", title: "T" }),
    });
    const act = selectionAction({ memory });
    expect(actionEnabled(act)).toBe(false);
    expect(act.hint?.()).toBe("Select text on the page first");
    let changed = 0;
    act.subscribe?.(() => changed++);
    state.text = "a  quote\nhere";
    memory._events.onChange();
    expect(changed).toBe(1);
    expect(actionEnabled(act)).toBe(true);
    expect(act.hint?.()).toBe("“a quote here”");
    const ctx = await act.attach?.({} as never);
    expect(ctx).toEqual({ selection: "a  quote\nhere", path: "/p", title: "T" });
    act.sent?.();
    expect(memory.get()).toBeNull();
  });
});

describe("fileAction", () => {
  it("attaches what the host's upload returns; a failed upload is a notice, not a crash", async () => {
    const notes: string[] = [];
    const act = fileAction({
      pick: async () => [{ name: "a.png" }, { name: "b.txt" }] as File[],
      upload: async (f) => {
        if (f.name === "b.txt") throw new Error("too big");
        return {
          name: f.name,
          url: "https://files.example.com/a.png",
          type: "image/png",
          size: 10,
        };
      },
    });
    const ctx = await act.attach?.({ notice: (t: string) => notes.push(t) } as never);
    expect(ctx).toEqual({
      files: [
        { name: "a.png", url: "https://files.example.com/a.png", type: "image/png", size: 10 },
      ],
    });
    expect(notes).toEqual(["Could not attach b.txt"]);
  });
  it("nothing picked: nothing attached", async () => {
    const act = fileAction({
      pick: async () => [],
      upload: async () => ({ name: "x", url: "/x" }),
    });
    expect(await act.attach?.({ notice() {} } as never)).toBeNull();
  });
});
