import { describe, expect, it } from "bun:test";
import { bindDraft, createDraft } from "../src/draft.ts";
import { connectVoice, createChat } from "../src/core.ts";
import { DEBOUNCE_MS } from "../src/input.ts";
import type { ChatMessage } from "../src/protocol.ts";

function clock() {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; f: () => void }>();
  return {
    now: () => t,
    setTimeout: (f: () => void, ms: number) => {
      timers.set(++seq, { at: t + ms, f });
      return seq;
    },
    clearTimeout: (id: unknown) => void timers.delete(id as number),
    advance(ms: number) {
      t += ms;
      for (const [id, x] of [...timers]) if (x.at <= t && timers.delete(id)) x.f();
    },
  };
}

function setup(ok = true, hold = false) {
  const c = clock();
  const sent: string[] = [];
  const draft = createDraft({
    ...c,
    send: (t) => (ok ? (sent.push(t), true) : false),
    hold: () => hold,
  });
  return { c, sent, draft };
}

describe("createDraft", () => {
  it("sends DEBOUNCE_MS after the last change, and each change re-arms", () => {
    const { c, sent, draft } = setup();
    draft.input("he");
    expect(draft.getState().armedUntil).toBe(DEBOUNCE_MS);
    c.advance(DEBOUNCE_MS - 1);
    draft.input("hello");
    c.advance(DEBOUNCE_MS - 1);
    expect(sent).toEqual([]);
    c.advance(1);
    expect(sent).toEqual(["hello"]);
    expect(draft.getState()).toMatchObject({ text: "", armedUntil: null });
  });

  it("Enter sends at once; Shift+Enter and a composing Enter do not", () => {
    const { sent, draft } = setup();
    draft.input("a line");
    expect(draft.keydown({ key: "Enter", shiftKey: true })).toBe(false);
    draft.compositionStart();
    expect(draft.getState().armedUntil).toBeNull();
    expect(draft.keydown({ key: "Enter", shiftKey: false })).toBe(false);
    draft.compositionEnd();
    expect(draft.keydown({ key: "Enter", shiftKey: false, keyCode: 229 })).toBe(false);
    expect(draft.keydown({ key: "Enter", shiftKey: false })).toBe(true);
    expect(sent).toEqual(["a line"]);
  });

  it("an Android line break sends, unless it follows Shift+Enter", () => {
    const { sent, draft } = setup();
    draft.input("one");
    draft.keydown({ key: "Enter", shiftKey: true });
    expect(draft.beforeInput({ inputType: "insertLineBreak" })).toBe(false);
    draft.keydown({ key: "a", shiftKey: false });
    expect(draft.beforeInput({ inputType: "insertParagraph" })).toBe(true);
    expect(sent).toEqual(["one"]);
  });

  it("a dictated sentence goes out at once; set() is never a burst", () => {
    const { sent, draft } = setup();
    draft.input("Make the toggle bigger please.");
    expect(sent).toEqual(["Make the toggle bigger please."]);
    draft.set("Another whole sentence here.");
    expect(sent.length).toBe(1);
    expect(draft.getState().armedUntil).not.toBeNull();
  });

  it("hold() keeps the debounce from sending; Enter still sends", () => {
    const { c, sent, draft } = setup(true, true);
    draft.input("on the mic");
    c.advance(DEBOUNCE_MS * 2);
    expect(sent).toEqual([]);
    draft.submit();
    expect(sent).toEqual(["on the mic"]);
  });

  it("a draft that could not go out is kept, and marked failed until it changes", () => {
    const { draft } = setup(false);
    draft.input("offline");
    expect(draft.submit()).toBe(false);
    expect(draft.getState()).toMatchObject({ text: "offline", failed: true });
    draft.input("offline!");
    expect(draft.getState().failed).toBe(false);
  });

  it("bindDraft wires a textarea and clears it when the line goes out", () => {
    const { sent, draft } = setup();
    const ls = new Map<string, (e: Event) => void>();
    const el = {
      value: "",
      addEventListener: (t: string, f: (e: Event) => void) => ls.set(t, f),
      removeEventListener: (t: string) => ls.delete(t),
    };
    const unbind = bindDraft(el, draft);
    el.value = "typed";
    ls.get("input")!({} as Event);
    let prevented = false;
    ls.get("keydown")!({
      key: "Enter",
      shiftKey: false,
      preventDefault: () => (prevented = true),
    } as unknown as Event);
    expect(sent).toEqual(["typed"]);
    expect(prevented).toBe(true);
    expect(el.value).toBe("");
    unbind();
    expect(ls.size).toBe(0);
  });
});

describe("connectVoice", () => {
  const m = (id: string, from: ChatMessage["from"], extra: object = {}): ChatMessage => ({
    id,
    from,
    label: "",
    text: `t ${id}`,
    at: 0,
    ...extra,
  });

  it("reads live agent replies only: not history, not the user's, not quiet ones", () => {
    const chat = createChat();
    const said: string[] = [];
    let hidden = false;
    const off = connectVoice(chat, { speak: (_t, id) => said.push(id!) }, { hidden: () => hidden });
    chat.setMessages([m("h", "agent")]);
    chat.push(m("o", "owner"));
    chat.push(m("q", "agent", { quiet: true }));
    chat.push(m("a", "agent"));
    hidden = true;
    chat.push(m("b", "agent"));
    off();
    hidden = false;
    chat.push(m("c", "agent"));
    expect(said).toEqual(["a"]);
  });
});
