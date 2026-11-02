import { describe, expect, it } from "bun:test";
import { type Transport, type TransportSink, createChat, RAN_MS } from "../src/core.ts";
import { BUSY_AFTER_REPLY_MS, BUSY_MS, CHAT_HISTORY, type ChatMessage } from "../src/protocol.ts";

/** A clock and one-shot timers the test advances by hand. */
function clock() {
  let t = 1_000_000;
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
      for (const [id, x] of [...timers].sort((a, b) => a[1].at - b[1].at))
        if (x.at <= t && timers.delete(id)) x.f();
    },
  };
}

/** A transport that records what went out and lets the test play the hub. */
function fakeTransport(up = true) {
  const sent: Record<string, unknown>[] = [];
  const calls: string[] = [];
  let sink: TransportSink | null = null;
  const t: Transport & { up: boolean } = {
    up,
    start(s) {
      calls.push("start");
      sink = s;
    },
    send(msg) {
      if (!t.up) return false;
      sent.push(msg);
      return true;
    },
    update: () => void calls.push("update"),
    stop() {
      calls.push("stop");
      sink = null;
    },
  };
  return { t, sent, calls, sink: () => sink! };
}

const msg = (
  id: string,
  from: ChatMessage["from"] = "agent",
  text = `text ${id}`,
): ChatMessage => ({
  id,
  from,
  label: "x",
  text,
  at: 0,
});

describe("createChat state", () => {
  it("keeps one snapshot until something changes, and slices keep their reference", () => {
    const chat = createChat();
    const s0 = chat.getState();
    expect(chat.getState()).toBe(s0);
    expect(Object.isFrozen(s0)).toBe(true);
    chat.set({ listeners: 0, sessions: [] }); // the same values: no change
    expect(chat.getState()).toBe(s0);
    chat.push(msg("a"));
    const s1 = chat.getState();
    expect(s1).not.toBe(s0);
    chat.set({ listeners: 2 });
    expect(chat.getState().messages).toBe(s1.messages);
  });

  it("an equal list from the hub is no change", () => {
    const chat = createChat();
    const p = { pair: "p", code: "ab12", label: "agent", at: 1 };
    chat.set({ sessions: [p] });
    const s = chat.getState();
    let calls = 0;
    chat.subscribe(() => calls++);
    chat.set({ sessions: [{ ...p }] });
    expect(chat.getState()).toBe(s);
    expect(calls).toBe(0);
  });

  it("keeps a message once per id, and at most CHAT_HISTORY", () => {
    const chat = createChat();
    const live: string[] = [];
    chat.on("message", (m, { live: l }) => l && live.push(m.id));
    chat.push(msg("a"));
    chat.push(msg("a"));
    expect(chat.getState().messages.map((m) => m.id)).toEqual(["a"]);
    expect(live).toEqual(["a"]);
    chat.setMessages(Array.from({ length: CHAT_HISTORY + 5 }, (_, i) => msg(`h${i}`)));
    expect(chat.getState().messages.length).toBe(CHAT_HISTORY);
    expect(chat.getState().messages[0]!.id).toBe("h5");
  });

  it("history is its own event, never a live message", () => {
    const chat = createChat();
    const seen: string[] = [];
    chat.on("message", () => seen.push("message"));
    chat.on("history", (l) => seen.push(`history ${l.length}`));
    chat.receive({ type: "history", messages: [msg("a"), msg("b")] });
    expect(seen).toEqual(["history 2"]);
  });

  it("drops a malformed message", () => {
    const chat = createChat();
    chat.push({ id: 1, text: "x" } as unknown as ChatMessage);
    chat.receive({ type: "chat", message: null });
    chat.receive({ type: "chat" });
    expect(chat.getState().messages).toEqual([]);
  });

  it("applies an edit in place", () => {
    const chat = createChat();
    chat.push(msg("a", "owner", "helo"));
    const edits: string[] = [];
    chat.on("edit", (e) => edits.push(e.id));
    chat.receive({
      type: "edited",
      id: "a",
      thread: "owner",
      text: "hello",
      raw: "helo",
      edited: { at: 1, by: "x", count: 1 },
    });
    expect(chat.getState().messages[0]!.text).toBe("hello");
    expect(edits).toEqual(["a"]);
  });

  it("reads the hub's state frame", () => {
    const chat = createChat();
    const p = { pair: "p", code: "ab12", label: "agent", at: 1 };
    chat.receive({
      type: "state",
      pending: p,
      sessions: [p],
      pages: [{ id: "pg", label: "/ x", at: 1 }],
      self: "pg",
      nodes: ["/a", 3],
    });
    const s = chat.getState();
    expect(s.pending).toEqual(p);
    expect(s.listeners).toBe(1); // no listeners field: the sessions
    expect(s.nodes).toEqual(["/a"]);
    expect(s.self).toBe("pg");
  });

  it("announces a new pairing request once, and live replies", () => {
    const chat = createChat();
    const said: string[] = [];
    chat.on("announce", (t, kind) => said.push(`${kind}: ${t}`));
    const p = { pair: "p", code: "ab12", label: "Claude", at: 1 };
    chat.set({ pending: p });
    chat.set({ pending: { ...p } });
    chat.push(msg("r", "agent", "done"));
    chat.push(msg("o", "owner", "thanks"));
    expect(said).toEqual(["pairing: Claude asks to connect: code ab12", "reply: done"]);
  });

  it("friend status and rate limits", () => {
    const chat = createChat();
    chat.receive({ type: "friend-status", status: "blocked" });
    expect(chat.getState().friend).toBe(true);
    expect(chat.getState().notice).toMatch(/not available/);
    chat.receive({ type: "rate-limited", retryIn: 90_000 });
    expect(chat.getState().warning).toMatch(/2 min/);
    chat.push(msg("o", "owner")); // the user's own line clears it
    expect(chat.getState().warning).toBe("");
  });
});

describe("createChat busy", () => {
  it("a beat shows busy for BUSY_MS, and the next beat renews it", () => {
    const c = clock();
    const chat = createChat(c);
    chat.beat();
    expect(chat.getState().busy).toBe(true);
    c.advance(BUSY_MS - 1);
    chat.beat();
    c.advance(BUSY_MS - 1);
    expect(chat.getState().busy).toBe(true);
    c.advance(1);
    expect(chat.getState().busy).toBe(false);
  });

  it("a reply ends it, and a beat right after the reply is ignored", () => {
    const c = clock();
    const chat = createChat(c);
    chat.receive({ type: "busy" });
    chat.push(msg("r"));
    expect(chat.getState().busy).toBe(false);
    c.advance(BUSY_AFTER_REPLY_MS - 1);
    chat.beat();
    expect(chat.getState().busy).toBe(false);
    c.advance(1);
    chat.beat();
    expect(chat.getState().busy).toBe(true);
  });

  it("setting busy false cancels the timeout", () => {
    const c = clock();
    const chat = createChat(c);
    chat.beat();
    chat.set({ busy: false });
    chat.set({ busy: true }); // a host's own spinner: no timeout
    c.advance(BUSY_MS * 2);
    expect(chat.getState().busy).toBe(true);
  });
});

describe("createChat sending", () => {
  it("send: false when nothing could go out, and nothing kept", () => {
    const chat = createChat();
    expect(chat.send("hi")).toBe(false);
    const f = fakeTransport(false);
    const chat2 = createChat({ transport: f.t });
    chat2.start();
    expect(chat2.send("hi")).toBe(false);
    expect(chat2.getState().outbox).toEqual([]);
    expect(chat2.send("   ")).toBe(false);
  });

  it("a sent line waits in the outbox until the hub echoes it", () => {
    const f = fakeTransport();
    let n = 0;
    const chat = createChat({ transport: f.t, newId: () => `id${++n}` });
    chat.start();
    expect(chat.send(" hi ", { to: "/words", source: "stt" })).toBe(true);
    expect(f.sent).toEqual([{ type: "chat", id: "id1", text: "hi", to: "/words", source: "stt" }]);
    expect(chat.getState().outbox).toMatchObject([{ id: "id1", status: "sending" }]);
    chat.receive({ type: "chat", message: msg("id1", "owner", "hi") });
    expect(chat.getState().outbox).toEqual([]);
    expect(chat.getState().messages.map((m) => m.id)).toEqual(["id1"]);
  });

  it("a rate-limited or dropped line fails, and retry sends it again with its id", () => {
    const f = fakeTransport();
    let n = 0;
    const chat = createChat({ transport: f.t, newId: () => `id${++n}` });
    chat.start();
    chat.send("one");
    chat.send("two");
    chat.receive({ type: "rate-limited", id: "id1", retryIn: 1000 });
    expect(chat.getState().outbox.map((o) => o.status)).toEqual(["failed", "sending"]);
    f.sink().status("offline");
    expect(chat.getState().outbox.map((o) => o.status)).toEqual(["failed", "failed"]);
    expect(chat.retry("id1")).toBe(true);
    expect(f.sent.at(-1)).toEqual({ type: "chat", id: "id1", text: "one" });
    expect(chat.getState().outbox[0]!.status).toBe("sending");
    // The history after a reconnect holds the second: it was kept after all.
    chat.receive({ type: "history", messages: [msg("id2", "owner", "two")] });
    expect(chat.getState().outbox.map((o) => o.id)).toEqual(["id1"]);
    chat.dismiss("id1");
    expect(chat.getState().outbox).toEqual([]);
  });

  it("allow needs user activation where the browser reports it", () => {
    const f = fakeTransport();
    const chat = createChat({ transport: f.t });
    chat.start();
    const nav = globalThis.navigator as unknown as Record<string, unknown>;
    const had = Object.getOwnPropertyDescriptor(nav, "userActivation");
    try {
      Object.defineProperty(nav, "userActivation", {
        value: { isActive: false },
        configurable: true,
      });
      expect(chat.allow("p", { pages: "all" })).toBe(false);
      expect(f.sent).toEqual([]);
      expect(chat.deny("p")).toBe(true); // taking away needs nothing
      Object.defineProperty(nav, "userActivation", {
        value: { isActive: true },
        configurable: true,
      });
      expect(chat.allow("p", { pages: ["a"], scope: "chat" })).toBe(true);
      expect(f.sent.at(-1)).toEqual({ type: "allow", pair: "p", pages: ["a"], scope: "chat" });
      Object.defineProperty(nav, "userActivation", {
        value: { isActive: false },
        configurable: true,
      });
      const tests = createChat({ transport: f.t, requireActivation: false });
      tests.start();
      expect(tests.allow("q")).toBe(true);
    } finally {
      if (had) Object.defineProperty(nav, "userActivation", had);
      else delete nav.userActivation;
    }
  });

  it("end and endPage", () => {
    const f = fakeTransport();
    const chat = createChat({ transport: f.t });
    chat.start();
    chat.end("p");
    chat.endPage("pg");
    expect(f.sent).toEqual([
      { type: "revoke", pair: "p" },
      { type: "end-page", id: "pg" },
    ]);
  });
});

describe("createChat lifecycle", () => {
  it("start is idempotent, and a stop undone in the same tick keeps the transport", async () => {
    const f = fakeTransport();
    const chat = createChat({ transport: f.t });
    chat.start();
    chat.start();
    // StrictMode: effect, cleanup, effect.
    chat.stop();
    chat.start();
    await Promise.resolve();
    expect(f.calls).toEqual(["start"]);
    chat.stop();
    await Promise.resolve();
    expect(f.calls).toEqual(["start", "stop"]);
    chat.start();
    expect(f.calls).toEqual(["start", "stop", "start"]);
  });

  it("going down clears what the hub said; close is final", async () => {
    const f = fakeTransport();
    const chat = createChat({ transport: f.t });
    chat.start();
    const sink = f.sink();
    sink.status("live");
    chat.receive({
      type: "state",
      pending: { pair: "p", code: "c", label: "", at: 0 },
      sessions: [],
      pages: [],
      self: "x",
    });
    chat.beat();
    sink.status("offline");
    expect(chat.getState()).toMatchObject({ status: "offline", pending: null, busy: false });
    chat.close();
    expect(chat.getState().status).toBe("closed");
    expect(f.calls.at(-1)).toBe("stop");
    chat.start();
    sink.status("live");
    expect(chat.getState().status).toBe("closed");
    expect(chat.send("hi")).toBe(false);
  });

  it("update only reaches a started transport", () => {
    const f = fakeTransport();
    const chat = createChat({ transport: f.t });
    chat.update();
    chat.start();
    chat.update();
    expect(f.calls).toEqual(["start", "update"]);
  });

  it("evalRan pulses for RAN_MS", () => {
    const c = clock();
    const f = fakeTransport();
    const chat = createChat({ ...c, transport: f.t });
    chat.start();
    f.sink().ran();
    expect(chat.getState().evalRan).toBe(true);
    c.advance(RAN_MS);
    expect(chat.getState().evalRan).toBe(false);
  });
});
