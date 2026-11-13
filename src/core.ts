// liagent/core: the chat without a UI. One session object holds what a chat
// UI draws and the rules behind it; <liagent-chat> is one view of it, and a
// host can draw its own from scratch (docs/headless-plan.md).
//
//   import { createChat, hubTransport } from "liagent/core";
//   const chat = createChat({ transport: hubTransport({ url: "/api/chat" }) });
//   chat.subscribe(() => render(chat.getState()));
//   chat.on("message", (m, { live }) => live && m.from === "agent" && speak(m.text));
//   chat.start();                      // idempotent; stop() / close() to drop it
//   chat.send("hi");                   // false: not sent (keep the draft)
//
// The rules it keeps, whatever draws it:
//   - A message is kept once per id, at most CHAT_HISTORY of them. A live one
//     (`push`, or the hub's {type:"chat"}) is "message" with live: true; the
//     history (`setMessages`) is never live, so it is never read aloud.
//   - Busy: each beat shows it for BUSY_MS, an agent's reply ends it, and a
//     beat within BUSY_AFTER_REPLY_MS of a reply is that work's tail, ignored.
//   - The outbox: a line `send` handed to the transport is "sending" until
//     the hub echoes it (same id), "failed" if the hub rate-limits it or the
//     connection drops first. `retry(id)` sends it again, `dismiss(id)` drops it.
//   - `allow` needs a user's tap: where the browser reports user activation
//     (navigator.userActivation), it is refused without one, so no script,
//     message or timer can approve a pairing. `requireActivation: false`
//     turns this off (tests). `deny`, `end` and `endPage` only take away, and
//     need nothing.
//
// The snapshot is frozen and replaced, never changed in place: getState()
// returns the same object until something changes, and each slice keeps its
// reference while its value does (useSyncExternalStore, Svelte stores and
// selectors rely on that). Nothing touches the DOM or `window` at import or
// in createChat, so it is safe in server rendering.

import {
  BUSY_AFTER_REPLY_MS,
  BUSY_MS,
  type AttachmentRef,
  type ChatContext,
  type ChatMessage,
  type EditedEvent,
  type HubState,
  type MessageSource,
  type PageInfo,
  type PairInfo,
  applyEdit,
  chatText,
  trimHistory,
} from "./protocol.ts";
import { pageHidden, silenceFor } from "./speak-rules.ts";

/** How long `evalRan` stays true after code ran on this page. */
export const RAN_MS = 4_000;

/**
 * "idle": not started (or no transport); "connecting"; "live"; "offline":
 * dropped, or hidden, until the transport reconnects; "closed": close() ran.
 */
export type ChatStatus = "idle" | "connecting" | "live" | "offline" | "closed";

/** A line the user sent that the hub has not echoed yet. */
export type OutboxEntry = Readonly<{
  id: string;
  text: string;
  to?: string;
  source?: MessageSource;
  context?: ChatContext;
  attachments?: readonly AttachmentRef[];
  at: number;
  status: "sending" | "failed";
}>;

export type ChatState = Readonly<{
  status: ChatStatus;
  /** Oldest first, at most CHAT_HISTORY. */
  messages: readonly ChatMessage[];
  outbox: readonly OutboxEntry[];
  /** A pairing waiting for the user's answer. */
  pending: PairInfo | null;
  /** Approved agent sessions. */
  sessions: readonly PairInfo[];
  /** Chat-capable agents connected now. */
  listeners: number;
  /** The state-tree nodes agents listen at ("@/…" completions). */
  nodes: readonly string[];
  /** The user's connected pages, and which one this is. */
  pages: readonly PageInfo[];
  self: string;
  /** The agent is working. */
  busy: boolean;
  /** Code just ran on this page (for RAN_MS). */
  evalRan: boolean;
  /** This viewer is a friend, not the site's user. */
  friend: boolean;
  /** Set when this viewer cannot chat: shown instead of the input. */
  notice: string;
  /** A one-line note, e.g. a message dropped by a rate limit. */
  warning: string;
}>;

/** The fields a transport or a host sets directly (the rest have rules). */
export type HostState = Partial<
  Pick<
    ChatState,
    | "status"
    | "pending"
    | "sessions"
    | "listeners"
    | "nodes"
    | "pages"
    | "self"
    | "busy"
    | "evalRan"
    | "friend"
    | "notice"
    | "warning"
  >
>;

export type ChatEvents = {
  /** A message that arrived live; `live` is false only for an echo of history. */
  message: (m: ChatMessage, info: { live: boolean }) => void;
  /** The whole log was replaced (history on connect): never read aloud. */
  history: (messages: readonly ChatMessage[]) => void;
  /** A message changed in place (the agent polished a voice line). */
  edit: (e: Omit<EditedEvent, "type">) => void;
  /** Something a screen reader should hear: a live reply, a new pairing request. */
  announce: (text: string, kind: "reply" | "pairing") => void;
};

/** What a transport tells the chat. */
export type TransportSink = {
  /** One hub → page frame, parsed (src/protocol.ts). */
  receive(msg: unknown): void;
  status(s: Exclude<ChatStatus, "closed">): void;
  /** Code ran on this page. */
  ran(): void;
};

/**
 * Carries page → hub frames out and hub → page frames in. `start` may be
 * called again after `stop`.
 */
export type Transport = {
  start(sink: TransportSink): void;
  /** False if it could not go out now. */
  send(msg: Record<string, unknown>): boolean;
  /** Re-check whether to be connected (visibility, wanted()). */
  update?(): void;
  stop(): void;
};

export type ChatOptions = {
  transport?: Transport;
  /** Refuse allow() without user activation where the browser reports it. Default true. */
  requireActivation?: boolean;
  /** The clock and timers, for tests. */
  now?: () => number;
  setTimeout?: (f: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
  /** Ids for sent lines (default: 12 characters of a random UUID). */
  newId?: () => string;
};

/** What the user chose for a pairing: the pages (ids, or "all"), and "chat" for an older agent. */
export type AllowAnswer = { pages?: string[] | "all"; scope?: "chat" };

export type Chat = {
  getState(): ChatState;
  /** Called after every change; returns unsubscribe. */
  subscribe(fn: (s: ChatState) => void): () => void;
  on<K extends keyof ChatEvents>(event: K, fn: ChatEvents[K]): () => void;

  /** Send a line (to a state-tree node, or the main thread). False: not sent; keep the draft. */
  send(
    text: string,
    opts?: {
      to?: string;
      source?: MessageSource;
      context?: ChatContext;
      attachments?: readonly AttachmentRef[];
    },
  ): boolean;
  /** Send a failed outbox line again. */
  retry(id: string): boolean;
  /** Drop an outbox line. */
  dismiss(id: string): void;
  /** Allow a pairing: from a user's tap only (see the header). False: refused or not sent. */
  allow(pair: string, answer?: AllowAnswer): boolean;
  deny(pair: string): boolean;
  /** End an approved session. */
  end(pair: string): boolean;
  /** Close one of the user's pages. */
  endPage(id: string): boolean;

  /** Start the transport (safe to call twice). */
  start(): void;
  /** Stop it, after a microtask: a start() before then keeps the connection (StrictMode). */
  stop(): void;
  /** Re-check visibility and wanted() now. */
  update(): void;
  /** Stop for good. */
  close(): void;

  /** Feed one hub → page frame (a host with its own socket). */
  receive(msg: unknown): void;
  /** One live message (kept once per id). */
  push(m: ChatMessage): void;
  /** Replace the log (history): never read aloud. */
  setMessages(list: readonly ChatMessage[]): void;
  /** Apply an edit to a message in place. */
  edit(e: Omit<EditedEvent, "type">): void;
  /** One busy beat from the agent. */
  beat(at?: number): void;
  /** Set fields a host or transport owns directly. */
  set(patch: HostState): void;
};

const INITIAL: ChatState = Object.freeze({
  status: "idle",
  messages: Object.freeze([]) as readonly ChatMessage[],
  outbox: Object.freeze([]) as readonly OutboxEntry[],
  pending: null,
  sessions: Object.freeze([]) as readonly PairInfo[],
  listeners: 0,
  nodes: Object.freeze([]) as readonly string[],
  pages: Object.freeze([]) as readonly PageInfo[],
  self: "",
  busy: false,
  evalRan: false,
  friend: false,
  notice: "",
  warning: "",
});

/** The strings the core sets itself (the box shows them as they are). */
export const CHAT_STRINGS = {
  blocked: "Chat is not available for this account.",
  rateLimited: (min: number) =>
    `Too many messages: that one was not sent. Try again in ${min} min.`,
};

/** True when the browser says a user gesture is active now, or cannot say. */
export function userActive(): boolean {
  const ua = (globalThis.navigator as { userActivation?: { isActive: boolean } } | undefined)
    ?.userActivation;
  return !ua || ua.isActive;
}

/** Equal for the snapshot: the same value, or two lists with the same items. */
function same(a: unknown, b: unknown) {
  if (Object.is(a, b)) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((x, i) => Object.is(x, b[i]) || JSON.stringify(x) === JSON.stringify(b[i]));
}

/** A change to the snapshot. */
type Patch = { -readonly [K in keyof ChatState]?: ChatState[K] };

const list = <T>(v: unknown): readonly T[] => Object.freeze(Array.isArray(v) ? [...v] : []);

export function createChat(opts: ChatOptions = {}): Chat {
  const now = opts.now ?? Date.now;
  const later = opts.setTimeout ?? ((f, ms) => setTimeout(f, ms));
  const cancel = opts.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const newId = opts.newId ?? (() => crypto.randomUUID().slice(0, 12));
  const transport = opts.transport;

  let state = INITIAL;
  const subs = new Set<(s: ChatState) => void>();
  const handlers: { [K in keyof ChatEvents]: Set<ChatEvents[K]> } = {
    message: new Set(),
    history: new Set(),
    edit: new Set(),
    announce: new Set(),
  };
  let busyTimer: unknown;
  let ranTimer: unknown;
  let lastReplyAt = -Infinity;
  let started = false;
  let stopping = false;
  let closed = false;

  const emit = <K extends keyof ChatEvents>(k: K, ...a: Parameters<ChatEvents[K]>) => {
    for (const f of handlers[k]) (f as (...x: typeof a) => void)(...a);
  };

  /** Replace the snapshot with the changed fields; notify only if any changed. */
  const commit = (patch: Patch) => {
    let next: Record<string, unknown> | null = null;
    for (const [k, v] of Object.entries(patch)) {
      if (same((state as Record<string, unknown>)[k], v)) continue;
      next ??= { ...state };
      next[k] = v;
    }
    if (!next) return;
    if ("busy" in patch) cancel(busyTimer);
    state = Object.freeze(next) as ChatState;
    for (const f of subs) f(state);
  };

  /** The host's fields, cleaned the way the box's setters always cleaned them. */
  const set = (p: HostState) => {
    const out: Patch = {};
    if (p.status !== undefined) out.status = p.status;
    if ("pending" in p) out.pending = p.pending ?? null;
    if (p.sessions !== undefined) out.sessions = list<PairInfo>(p.sessions);
    if (p.listeners !== undefined) out.listeners = Number(p.listeners) || 0;
    if (p.nodes !== undefined)
      out.nodes = Object.freeze(
        list<unknown>(p.nodes).filter((n) => typeof n === "string"),
      ) as readonly string[];
    if (p.pages !== undefined) out.pages = list<PageInfo>(p.pages);
    if (p.self !== undefined) out.self = p.self ?? "";
    if (p.busy !== undefined) out.busy = !!p.busy;
    if (p.evalRan !== undefined) out.evalRan = !!p.evalRan;
    if (p.friend !== undefined) out.friend = !!p.friend;
    if ("notice" in p) out.notice = p.notice ?? "";
    if ("warning" in p) out.warning = p.warning ?? "";
    const wasPending = state.pending?.pair;
    commit(out);
    const pend = state.pending;
    if (pend && pend.pair !== wasPending)
      emit("announce", `${pend.label || "An agent"} asks to connect: code ${pend.code}`, "pairing");
  };

  const setOutbox = (f: (o: readonly OutboxEntry[]) => OutboxEntry[]) =>
    commit({ outbox: Object.freeze(f(state.outbox)) });

  const push = (m: ChatMessage) => {
    if (!m || typeof m !== "object" || typeof m.text !== "string" || typeof m.id !== "string")
      return;
    if (state.outbox.some((o) => o.id === m.id)) setOutbox((o) => o.filter((x) => x.id !== m.id));
    if (state.messages.some((x) => x.id === m.id)) return;
    const patch: Patch = {
      messages: Object.freeze(trimHistory([...state.messages, m])),
    };
    if (m.from !== "agent") patch.warning = "";
    else {
      // A reply ends the spinner for the work it answers.
      lastReplyAt = now();
      patch.busy = false;
    }
    commit(patch);
    emit("message", m, { live: true });
    if (m.from === "agent") emit("announce", m.text, "reply");
  };

  const setMessages = (v: readonly ChatMessage[]) => {
    const messages = Object.freeze(trimHistory(Array.isArray(v) ? [...v] : []));
    const ids = new Set(messages.map((m) => m.id));
    commit({ messages });
    if (state.outbox.some((o) => ids.has(o.id))) setOutbox((o) => o.filter((x) => !ids.has(x.id)));
    emit("history", state.messages);
  };

  const edit = (e: Omit<EditedEvent, "type">) => {
    if (!e || typeof e.id !== "string" || typeof e.text !== "string") return;
    commit({ messages: Object.freeze(state.messages.map((m) => applyEdit(m, e))) });
    emit("edit", e);
  };

  const beat = (at = now()) => {
    if (at - lastReplyAt < BUSY_AFTER_REPLY_MS) return;
    commit({ busy: true });
    cancel(busyTimer);
    busyTimer = later(() => commit({ busy: false }), BUSY_MS);
  };

  const receive = (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const msg = raw as Record<string, unknown>;
    switch (msg.type) {
      case "friend-status":
        return set({ friend: true, notice: msg.status === "blocked" ? CHAT_STRINGS.blocked : "" });
      case "rate-limited": {
        const min = Math.max(1, Math.ceil(Number(msg.retryIn) / 60_000) || 1);
        if (typeof msg.id === "string")
          setOutbox((o) => o.map((x) => (x.id === msg.id ? { ...x, status: "failed" } : x)));
        return set({ warning: CHAT_STRINGS.rateLimited(min) });
      }
      case "state": {
        const s = msg as unknown as HubState;
        const sessions = Array.isArray(s.sessions) ? s.sessions : [];
        return set({
          pending: (s.pending as PairInfo | null) ?? null,
          sessions,
          listeners: s.listeners ?? sessions.length,
          nodes: Array.isArray(s.nodes) ? s.nodes : [],
          pages: Array.isArray(s.pages) ? s.pages : [],
          self: typeof s.self === "string" ? s.self : "",
        });
      }
      case "busy":
        return beat();
      case "history":
        if (Array.isArray(msg.messages)) setMessages(msg.messages as ChatMessage[]);
        return;
      case "chat":
        return push(msg.message as ChatMessage);
      case "edited":
        return edit(msg as unknown as EditedEvent);
    }
  };

  const out = (msg: Record<string, unknown>) => !closed && !!transport?.send(msg);

  const sendLine = (e: Omit<OutboxEntry, "status" | "at">) =>
    out({
      type: "chat",
      id: e.id,
      text: e.text,
      ...(e.to ? { to: e.to } : {}),
      ...(e.source ? { source: e.source } : {}),
      ...(e.context ? { context: e.context } : {}),
      ...(e.attachments?.length ? { attachments: e.attachments } : {}),
    });

  const sink: TransportSink = {
    receive,
    status(s) {
      if (closed) return;
      if (s === "live" || s === "connecting") return commit({ status: s });
      // Down: what the hub told us no longer holds.
      commit({ status: s, pending: null, sessions: INITIAL.sessions, pages: INITIAL.pages });
      commit({ busy: false });
      if (state.outbox.some((o) => o.status === "sending"))
        setOutbox((o) => o.map((x) => (x.status === "sending" ? { ...x, status: "failed" } : x)));
    },
    ran() {
      cancel(ranTimer);
      commit({ evalRan: true });
      ranTimer = later(() => commit({ evalRan: false }), RAN_MS);
    },
  };

  const halt = () => {
    stopping = false;
    if (!started) return;
    started = false;
    transport?.stop();
  };

  return {
    getState: () => state,
    subscribe(fn) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    on(event, fn) {
      handlers[event].add(fn);
      return () => void handlers[event].delete(fn);
    },

    send(text, o = {}) {
      const t = chatText(text);
      if (!t) return false;
      const e = {
        id: newId(),
        text: t,
        ...(o.to ? { to: o.to } : {}),
        ...(o.source ? { source: o.source } : {}),
        ...(o.context ? { context: o.context } : {}),
        ...(o.attachments?.length ? { attachments: o.attachments } : {}),
      };
      if (!sendLine(e)) return false;
      setOutbox((x) => [...x, { ...e, at: now(), status: "sending" }]);
      return true;
    },
    retry(id) {
      const e = state.outbox.find((x) => x.id === id && x.status === "failed");
      if (!e || !sendLine(e)) return false;
      setOutbox((o) => o.map((x) => (x.id === id ? { ...x, status: "sending", at: now() } : x)));
      return true;
    },
    dismiss(id) {
      if (state.outbox.some((x) => x.id === id)) setOutbox((o) => o.filter((x) => x.id !== id));
    },
    allow(pair, answer = {}) {
      if (opts.requireActivation !== false && !userActive()) return false;
      return out({
        type: "allow",
        pair,
        ...(answer.pages ? { pages: answer.pages } : {}),
        ...(answer.scope ? { scope: answer.scope } : {}),
      });
    },
    deny: (pair) => out({ type: "deny", pair }),
    end: (pair) => out({ type: "revoke", pair }),
    endPage: (id) => out({ type: "end-page", id }),

    start() {
      if (closed) return;
      stopping = false;
      if (started) return;
      started = true;
      transport?.start(sink);
    },
    stop() {
      if (!started || stopping) return;
      stopping = true;
      queueMicrotask(() => stopping && halt());
    },
    update: () => void (started && transport?.update?.()),
    close() {
      if (closed) return;
      halt();
      closed = true;
      cancel(ranTimer);
      commit({ status: "closed", pending: null, sessions: INITIAL.sessions, pages: INITIAL.pages });
      commit({ busy: false, evalRan: false });
    },

    receive,
    push,
    setMessages,
    edit,
    beat,
    set,
  };
}

/** A voice output (liagent/voice's `voice()`, or the host's own). */
export type ChatSpeaker = { speak(text: string, id?: string): void };

/**
 * Read the agent's live replies through `v`, by the box's rules: never
 * history, never a `quiet` line, never while the page is hidden
 * (src/speak-rules.ts). Returns unhook.
 */
export function connectVoice(
  chat: Pick<Chat, "on">,
  v: ChatSpeaker,
  opts: { hidden?: () => boolean } = {},
): () => void {
  const hidden = opts.hidden ?? pageHidden;
  return chat.on("message", (m, { live }) => {
    if (!live || m.from !== "agent") return;
    if (silenceFor(m, { hidden: hidden() })) return;
    v.speak(m.text, m.id);
  });
}
