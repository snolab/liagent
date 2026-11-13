import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { connectHub, hubTransport } from "../src/client.ts";
import { createChat } from "../src/core.ts";

/** A page socket the test plays the hub on. */
class FakeWS {
  static OPEN = 1;
  static all: FakeWS[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: (e: { code: number }) => void;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  hub(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const g = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, PropertyDescriptor | undefined> = {};
const KEYS = [
  "WebSocket",
  "document",
  "location",
  "history",
  "sessionStorage",
  "addEventListener",
  "removeEventListener",
];
let doc: { visibilityState: string; fire(): void };
let win: Map<string, Set<() => void>>;

beforeEach(() => {
  for (const k of KEYS) saved[k] = Object.getOwnPropertyDescriptor(g, k);
  FakeWS.all = [];
  const docL = new Set<() => void>();
  doc = {
    visibilityState: "visible",
    fire: () => docL.forEach((f) => f()),
  };
  win = new Map();
  const store = new Map<string, string>();
  const def = (k: string, value: unknown) =>
    Object.defineProperty(g, k, { value, configurable: true, writable: true });
  def("WebSocket", FakeWS);
  def("document", {
    get visibilityState() {
      return doc.visibilityState;
    },
    addEventListener: (_: string, f: () => void) => docL.add(f),
    removeEventListener: (_: string, f: () => void) => docL.delete(f),
  });
  def("location", { href: "https://app.example.com/settings", pathname: "/settings" });
  def("history", { pushState() {}, replaceState() {} });
  def("sessionStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  });
  def("addEventListener", (t: string, f: () => void) => {
    if (!win.has(t)) win.set(t, new Set());
    win.get(t)!.add(f);
  });
  def("removeEventListener", (t: string, f: () => void) => win.get(t)?.delete(f));
});

afterEach(() => {
  for (const k of KEYS) {
    const d = saved[k];
    if (d) Object.defineProperty(g, k, d);
    else delete g[k];
  }
});

const opts = { url: "/api/chat", label: "/settings test" };

describe("hubTransport", () => {
  it("connects with the label and the tab's page id, and goes live on open", () => {
    const chat = createChat({ transport: hubTransport(opts) });
    chat.start();
    expect(chat.getState().status).toBe("connecting");
    const ws = FakeWS.all[0]!;
    expect(ws.url).toBe("wss://app.example.com/api/chat?label=%2Fsettings+test");
    ws.open();
    expect(chat.getState().status).toBe("live");
    ws.hub({
      type: "state",
      pending: null,
      sessions: [],
      listeners: 1,
      pages: [],
      self: "page-123",
    });
    expect(chat.getState().listeners).toBe(1);
    // A reconnect carries the page id the hub gave this tab.
    ws.drop();
    expect(FakeWS.all[1]!.url).toContain("page=page-123");
  });

  it("never reconnects after a 4xxx close or a refusal", () => {
    const chat = createChat({ transport: hubTransport(opts) });
    chat.start();
    FakeWS.all[0]!.drop(); // never opened: refused
    expect(FakeWS.all.length).toBe(1);
    chat.update();
    FakeWS.all[1]!.open();
    FakeWS.all[1]!.drop(4403);
    expect(FakeWS.all.length).toBe(2);
    expect(chat.getState().status).toBe("offline");
  });

  it("runs eval only with evalCode, and reports the result", async () => {
    const off = createChat({ transport: hubTransport(opts) });
    off.start();
    const a = FakeWS.all[0]!;
    a.open();
    a.hub({ type: "eval", id: "e1", to: "p", code: "1 + 1" });
    await Bun.sleep(0);
    expect(a.sent).toEqual([]);
    off.close();

    const on = createChat({ transport: hubTransport({ ...opts, evalCode: true }) });
    on.start();
    const b = FakeWS.all[1]!;
    b.open();
    b.hub({ type: "eval", id: "e1", to: "p", code: "1 + 1" });
    await Bun.sleep(0);
    expect(b.sent[0]).toMatchObject({ type: "result", id: "e1", to: "p", ok: true, value: "2" });
    expect(on.getState().evalRan).toBe(true);
    on.close();
  });

  it("stop removes its listeners and closes; start again reconnects", async () => {
    const chat = createChat({ transport: hubTransport(opts) });
    chat.start();
    FakeWS.all[0]!.open();
    chat.stop();
    await Promise.resolve();
    expect(FakeWS.all[0]!.readyState).toBe(3);
    expect(win.get("pageshow")?.size ?? 0).toBe(0);
    chat.start();
    expect(FakeWS.all.length).toBe(2);
    expect(win.get("pageshow")?.size).toBe(1);
  });

  it("a hidden page keeps the socket until IDLE_MS; pageshow re-checks wanted()", () => {
    const chat = createChat({ transport: hubTransport(opts) });
    chat.start();
    FakeWS.all[0]!.open();
    doc.visibilityState = "hidden";
    doc.fire();
    expect(chat.getState().status).toBe("live"); // not yet: IDLE_MS
    chat.close();
    expect(chat.getState().status).toBe("closed");

    const again = createChat({ transport: hubTransport({ ...opts, wanted: () => false }) });
    again.start();
    expect(FakeWS.all.length).toBe(1);
    doc.visibilityState = "visible";
    for (const f of win.get("pageshow") ?? []) f();
    expect(FakeWS.all.length).toBe(1); // wanted() still says no
  });
});

describe("connectHub", () => {
  it("puts the box on a chat, and wires its callbacks to the chat's actions", () => {
    const box = {} as Parameters<typeof connectHub>[0];
    const hub = connectHub(box, opts);
    expect(box.chat).toBe(hub.chat);
    const ws = FakeWS.all[0]!;
    ws.open();
    expect(box.onSend!("hi", "/words")).toBe(true);
    expect(ws.sent[0]).toMatchObject({ type: "chat", text: "hi", to: "/words" });
    const attachments = [{ id: "f1", name: "a.png", type: "image/png", size: 3 }];
    box.onSend!("see", undefined, { context: { path: "/words" }, attachments });
    expect(ws.sent[1]).toMatchObject({ context: { path: "/words" }, attachments });
    box.onEnd!({ pair: "p", code: "c", label: "", at: 0 });
    expect(ws.sent[2]).toEqual({ type: "revoke", pair: "p" });
    hub.close();
    expect(hub.chat.getState().status).toBe("closed");
  });
});
