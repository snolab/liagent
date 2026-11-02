// A hub's page socket (src/hub.ts, or any hub speaking src/protocol.ts) as a
// transport for the headless chat (src/core.ts), and connectHub, which puts
// a <liagent-chat> box on one. Framework-free; the box can be used without
// it, with any transport, through box.onSend / box.push.
//
//   import { defineChatBox } from "liagent/box";
//   import { connectHub } from "liagent/client";
//   defineChatBox();
//   const box = document.body.appendChild(document.createElement("liagent-chat"));
//   const hub = connectHub(box, { url: "wss://example.com/api/chat" });
//   // … hub.close() to drop it.
//
// Headless (no box): createChat({ transport: hubTransport(opts) }) from
// liagent/core, then chat.start().
//
// The socket is held only while the page is visible (and `wanted()` says
// so): hidden for IDLE_MS, it is dropped; visible again, it reopens. It
// reconnects when the network drops it, never after a close the hub meant
// (4xxx) or one that never opened (refused). No timer touches the network.
// A page restored from the back-forward cache (pageshow) is checked again too.
//
// Eval: a hub may send {type:"eval", id, code, to} from an agent the owner
// approved on this device. It runs only with `evalCode: true`; the result
// goes back to that agent. Off by default — running code is the site's call.

import type { ChatBox } from "./box.ts";
import { type Chat, type Transport, type TransportSink, createChat } from "./core.ts";
import { PAGE_DEBOUNCE_MS, compile, summarize } from "./protocol.ts";

/** Hidden this long before the socket is dropped. */
export const IDLE_MS = 30_000;

export type HubOptions = {
  /** The hub's page-socket URL (ws:// or wss://, or a path on this origin). */
  url: string;
  /**
   * This page's label, shown to agents; default: path + (pwa) + user agent.
   * A function is asked again after each client-side navigation.
   */
  label?: string | (() => string);
  /** Report client-side navigation to the hub ({type:"page"}). Default true. */
  trackPages?: boolean;
  /** Run code approved agents send (eval scope). Default false. */
  evalCode?: boolean;
  /** Whether the socket should be up at all (beyond visibility). Default always. */
  wanted?: () => boolean;
  /** Each eval result, for the site's own logging. */
  onEval?: (r: { id: string; ok: boolean } & Record<string, unknown>) => void;
};

export type HubConnection = {
  /** Re-check visibility and wanted() now (call it when wanted() may have changed). */
  update(): void;
  close(): void;
  /** The headless chat behind the box. */
  chat: Chat;
};

/** This tab's page id, kept for the tab's life so a reconnect keeps its grants. */
const PAGE_KEY = "liagent:page";
const readPageId = () => {
  try {
    return sessionStorage.getItem(PAGE_KEY) ?? "";
  } catch {
    return "";
  }
};
const savePageId = (id: string) => {
  try {
    if (id) sessionStorage.setItem(PAGE_KEY, id);
  } catch {}
};

function socketUrl(url: string, label: string) {
  const u = new URL(url, location.href);
  if (u.protocol === "http:") u.protocol = "ws:";
  if (u.protocol === "https:") u.protocol = "wss:";
  u.searchParams.set("label", label);
  const page = readPageId();
  if (page) u.searchParams.set("page", page);
  return u.toString();
}

/**
 * The hub's page socket as a transport: held while the page is visible and
 * `wanted()`, reconnected after a network drop, the tab's page id kept, its
 * client-side navigation reported, and approved eval run (only with
 * `evalCode: true`). Stop it and start it again as often as you like.
 */
export function hubTransport(opts: HubOptions): Transport {
  let ws: WebSocket | null = null;
  let sink: TransportSink | null = null;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let nav: ReturnType<typeof setTimeout> | undefined;
  const pageLabel = () => {
    if (typeof opts.label === "function") return opts.label();
    if (opts.label) return opts.label;
    const standalone = matchMedia?.("(display-mode: standalone)").matches ? "pwa " : "";
    return `${location.pathname} ${standalone}${navigator.userAgent}`;
  };
  let sentLabel = "";
  const opened = new WeakSet<WebSocket>();
  const wanted = () =>
    !!sink && document.visibilityState === "visible" && (opts.wanted?.() ?? true);

  const send = (sock: WebSocket | null, msg: unknown) => {
    if (!sock || sock.readyState !== WebSocket.OPEN) return false;
    try {
      sock.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  };

  const run = async (sock: WebSocket, id: string, to: string, code: string) => {
    sink?.ran();
    const t0 = performance.now();
    let result: { ok: boolean } & Record<string, unknown>;
    try {
      const value = await compile(code)();
      result = {
        ok: true,
        ms: Math.round(performance.now() - t0),
        value: summarize(value),
      };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      result = {
        ok: false,
        error: `${err.name}: ${err.message}`.slice(0, 1000),
        stack: (err.stack ?? "").slice(0, 2000),
      };
    }
    opts.onEval?.({ id, ...result });
    send(sock, { type: "result", id, to, ...result });
  };

  const connect = () => {
    if (ws) return;
    const label = (sentLabel = pageLabel());
    const sock = new WebSocket(socketUrl(opts.url, label));
    ws = sock;
    sink?.status("connecting");
    sock.onopen = () => {
      opened.add(sock);
      if (ws === sock) sink?.status("live");
    };
    sock.onmessage = (e) => {
      if (ws !== sock) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (msg?.type === "state" && typeof msg.self === "string")
        // The hub's id for this tab (ours, or a fresh one if ours was taken).
        savePageId(msg.self);
      if (msg?.type !== "eval") return sink?.receive(msg);
      if (!opts.evalCode) return;
      if (typeof msg.id !== "string" || typeof msg.to !== "string") return;
      if (typeof msg.code !== "string") return;
      void run(sock, msg.id, msg.to, msg.code);
    };
    // Dropped by the network: reopen if still wanted. One that never opened
    // was refused, and one the hub closed on purpose (4xxx) stays closed,
    // until the next visibility change or update().
    sock.onclose = (e) => {
      if (ws !== sock) return;
      ws = null;
      sink?.status("offline");
      if (opened.has(sock) && e.code < 4000 && wanted()) connect();
    };
  };

  const disconnect = () => {
    clearTimeout(idle);
    const sock = ws;
    ws = null;
    if (sock) sink?.status("offline");
    sock?.close();
  };

  const update = () => {
    clearTimeout(idle);
    if (wanted()) connect();
    else if (!sink || !(opts.wanted?.() ?? true)) disconnect();
    else if (ws) idle = setTimeout(disconnect, IDLE_MS);
  };

  // Client-side navigation: tell the hub this page's new label (debounced),
  // so agents hear page-changed. History API calls and back/forward both.
  const navigated = () => {
    clearTimeout(nav);
    nav = setTimeout(() => {
      const label = pageLabel();
      if (label === sentLabel) return;
      if (send(ws, { type: "page", label })) sentLabel = label;
    }, PAGE_DEBOUNCE_MS);
  };
  let unhook: (() => void)[] = [];

  return {
    start(s) {
      if (sink) return;
      sink = s;
      if (opts.trackPages !== false) {
        for (const k of ["pushState", "replaceState"] as const) {
          const orig = history[k];
          history[k] = function (this: History, ...a: Parameters<History["pushState"]>) {
            const r = orig.apply(this, a);
            navigated();
            return r;
          };
          unhook.push(() => (history[k] = orig));
        }
        addEventListener("popstate", navigated);
        unhook.push(() => removeEventListener("popstate", navigated));
      }
      document.addEventListener("visibilitychange", update);
      addEventListener("pageshow", update);
      unhook.push(() => {
        document.removeEventListener("visibilitychange", update);
        removeEventListener("pageshow", update);
      });
      update();
    },
    send: (msg) => send(ws, msg),
    update,
    stop() {
      if (!sink) return;
      clearTimeout(nav);
      for (const u of unhook) u();
      unhook = [];
      disconnect();
      sink = null;
    },
  };
}

/** Drive a <liagent-chat> box from a hub's page socket (see the header). */
export function connectHub(box: ChatBox, opts: HubOptions): HubConnection {
  const chat = createChat({ transport: hubTransport(opts) });
  box.chat = chat;
  box.onSend = (text, to, o) => chat.send(text, { to, source: o?.source });
  box.onAnswer = (type, p, answer) =>
    void (type === "deny" ? chat.deny(p.pair) : chat.allow(p.pair, answer));
  box.onEnd = (p) => void chat.end(p.pair);
  box.onEndPage = (id) => void chat.endPage(id);
  chat.start();
  return { update: () => chat.update(), close: () => chat.close(), chat };
}
