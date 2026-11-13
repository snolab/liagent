// The draft, headless: when a line the user is typing goes out, for any
// input a host draws (src/input.ts has the rules; the box keeps its own copy
// of this wiring, with its "@/node" and mic extras).
//
//   import { createChat, createDraft, bindDraft } from "liagent/core";
//   const draft = createDraft({ send: (text) => chat.send(text) });
//   const unbind = bindDraft(textarea, draft);   // or call its handlers yourself
//   draft.subscribe(() => drawDrainBar(draft.getState().armedUntil));
//
//   - DEBOUNCE_MS after the last change, unless `hold()` says to wait (a mic
//     is on, a transcript is still coming in);
//   - at once on Enter (Shift+Enter is a newline), never inside an IME
//     composition or on the Enter that confirms a candidate;
//   - on Android, the line break itself (beforeinput) is the cue;
//   - at once when dictation drops in a sentence of more than BURST_CHARS.
//
// A draft that could not go out (send returned false) is kept, and `failed`
// says so until the next change.

import { DEBOUNCE_MS, type KeyInfo, afterChange, enterSends, lineBreakSends } from "./input.ts";
import { MAX_CHAT } from "./protocol.ts";

export type DraftState = Readonly<{
  text: string;
  composing: boolean;
  /** When the debounce sends it (the clock's time), or null if nothing is armed. */
  armedUntil: number | null;
  /** The last try to send it failed: it is kept. */
  failed: boolean;
}>;

export type DraftOptions = {
  /** Send the line; false if it could not go out (the draft is kept). */
  send: (text: string) => boolean;
  /** True while nothing should go out by itself (only Enter or submit() sends). */
  hold?: () => boolean;
  now?: () => number;
  setTimeout?: (f: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
};

export type Draft = {
  getState(): DraftState;
  subscribe(fn: (s: DraftState) => void): () => void;
  /** The input's text changed (an input event). */
  input(text: string): void;
  compositionStart(): void;
  compositionEnd(): void;
  /** A keydown; true if it sent the draft (call preventDefault). */
  keydown(e: KeyInfo): boolean;
  /** A beforeinput; true if it sent the draft (call preventDefault). */
  beforeInput(e: { inputType: string; isComposing?: boolean }): boolean;
  /** Send now, as Enter would; true if it went out. */
  submit(): boolean;
  /** Replace the text without sending (no burst). */
  set(text: string): void;
  /** Drop any armed send. */
  dispose(): void;
};

export function createDraft(opts: DraftOptions): Draft {
  const now = opts.now ?? Date.now;
  const later = opts.setTimeout ?? ((f, ms) => setTimeout(f, ms));
  const cancel = opts.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let state: DraftState = Object.freeze({
    text: "",
    composing: false,
    armedUntil: null,
    failed: false,
  });
  const subs = new Set<(s: DraftState) => void>();
  let timer: unknown;
  let settledLen = 0;
  let shiftEnter = false;

  const commit = (p: Partial<DraftState>) => {
    const next = { ...state, ...p };
    if ((Object.keys(p) as (keyof DraftState)[]).every((k) => Object.is(state[k], next[k]))) return;
    state = Object.freeze(next);
    for (const f of subs) f(state);
  };
  const disarm = () => {
    cancel(timer);
    timer = undefined;
    commit({ armedUntil: null });
  };
  const submit = () => {
    disarm();
    const text = state.text.trim();
    if (!text) return false;
    if (!opts.send(text)) {
      commit({ failed: true });
      return false;
    }
    settledLen = 0;
    commit({ text: "", failed: false });
    return true;
  };
  const arm = () => {
    disarm();
    const next = afterChange(state.text, settledLen, state.composing);
    if (!state.composing) settledLen = state.text.length;
    if (next === "send") return void submit();
    if (next === "idle" || opts.hold?.()) return;
    timer = later(submit, DEBOUNCE_MS);
    commit({ armedUntil: now() + DEBOUNCE_MS });
  };

  return {
    getState: () => state,
    subscribe(fn) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    input(text) {
      commit({ text: String(text ?? "").slice(0, MAX_CHAT), failed: false });
      arm();
    },
    compositionStart() {
      commit({ composing: true });
      disarm();
    },
    compositionEnd() {
      commit({ composing: false });
      arm();
    },
    keydown(e) {
      shiftEnter = e.key === "Enter" && e.shiftKey;
      if (!enterSends(e, state.composing)) return false;
      submit();
      return true;
    },
    beforeInput(e) {
      const sends = lineBreakSends(e.inputType, {
        composing: state.composing,
        isComposing: e.isComposing,
        shiftEnter,
      });
      if (sends) submit();
      return sends;
    },
    submit,
    set(text) {
      const t = String(text ?? "").slice(0, MAX_CHAT);
      settledLen = t.length; // not a typed burst
      commit({ text: t, failed: false });
      arm();
    },
    dispose: disarm,
  };
}

type TextInput = {
  value: string;
  addEventListener(type: string, f: (e: Event) => void): void;
  removeEventListener(type: string, f: (e: Event) => void): void;
};

/**
 * Wire a <textarea> (or <input>) to a draft: its events in, and its value
 * cleared when the line goes out. Returns unbind.
 */
export function bindDraft(el: TextInput, draft: Draft): () => void {
  const on: [string, (e: Event) => void][] = [
    ["input", () => draft.input(el.value)],
    ["compositionstart", () => draft.compositionStart()],
    ["compositionend", () => draft.compositionEnd()],
    [
      "keydown",
      (e) => {
        if (draft.keydown(e as unknown as KeyInfo)) e.preventDefault();
      },
    ],
    [
      "beforeinput",
      (e) => {
        if (draft.beforeInput(e as InputEvent)) e.preventDefault();
      },
    ],
  ];
  for (const [t, f] of on) el.addEventListener(t, f);
  const unsub = draft.subscribe((s) => {
    if (el.value !== s.text) el.value = s.text;
  });
  return () => {
    unsub();
    for (const [t, f] of on) el.removeEventListener(t, f);
  };
}
