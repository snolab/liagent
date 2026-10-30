/**
 * The state tree, live: the hand-edited outline (state-tree.ts) stays the
 * base, and the progress hub's nodes (progress-hub.ts) are laid over it by
 * path. A live node for `/words/prefetch` updates the outline's `## /words`
 * › `prefetch` item — its status, owner flag, assignee, action and links,
 * with pct, ETA, needs and the latest note in its note — or adds it there
 * when the outline has none.
 *
 * overlayProgress is pure. progressFeed is the reader's side of the hub's
 * WebSocket: a snapshot, then every event, folded into a ProgressView.
 * Nothing polls: a close or an error schedules one reconnect with backoff,
 * and after GIVE_UP failures in a row it waits for the network or the tab
 * to come back. tree.ts's liveTreeSource joins the two into a TreeSource.
 */
import {
  type ProgressEntry,
  type ProgressStatus,
  type ProgressView,
  applyProgressMessage,
  isPathId,
  openTodoRefs,
  parseProgressMessage,
  waitsOnOwner,
} from "./progress.ts";
import { type ParseOptions, type TreeNode, type TreeStatus, findLinks } from "./state-tree.ts";

const STATUS: Record<ProgressStatus, TreeStatus> = {
  doing: "doing",
  review: "doing",
  blocked: "blocked",
  waiting: "open",
  "waiting-owner": "open",
  done: "done",
};

/** How an outline title answers to a path segment: its first word, or the whole title, as a slug. */
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9@/_]+/g, "-")
    .replace(/^-+|-+$/g, "");
const bare = (s: string) => s.replace(/^\//, "");
const matches = (title: string, seg: string) => {
  const first = title.trim().split(/\s+/)[0] ?? "";
  return bare(slug(first)) === seg || bare(slug(title)) === seg;
};

/** The live part of a node's note: "40% · ETA 15m · needs: … · <latest note>". */
export function liveNote(e: ProgressEntry): string {
  return [
    e.pct != null ? `${e.pct}%` : "",
    e.eta ? `ETA ${e.eta}` : "",
    e.needs ? `needs: ${e.needs}` : "",
    e.notes?.at(-1)?.text ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function apply(n: TreeNode, e: ProgressEntry, waiting: boolean, opts: ParseOptions) {
  n.status = STATUS[e.status];
  n.done = e.status === "done";
  if (waiting) n.needsOwner = true;
  else delete n.needsOwner;
  n.assignee = { type: e.assignee.type, name: e.assignee.name };
  if (e.action) n.action = e.action;
  const live = liveNote(e);
  if (live) n.note = n.note ? `${live}\n${n.note}` : live;
  const extra = [
    ...(e.pr ? findLinks(`#${e.pr}`, opts) : []),
    ...(e.link ? [{ text: e.link, url: e.link }] : []),
    ...(e.action ? findLinks(e.action, opts) : []),
  ];
  for (const l of extra) if (!n.links.some((x) => x.url === l.url)) n.links.push(l);
}

const clone = (n: TreeNode): TreeNode => ({
  ...n,
  links: [...n.links],
  children: n.children.map(clone),
});

export type OverlayOptions = ParseOptions & {
  /** The heading that slug ids (no path) go under. Default "Live". */
  liveTitle?: string;
};

/**
 * Lay the hub's nodes over the outline (parseTreeDoc's root). Path ids walk
 * the outline segment by segment ("/words" is the heading whose first word
 * is /words; deeper segments match an item's first word or its whole title
 * as a slug), adding what is missing; a slug id goes under a "Live" heading.
 * Groups and people are structure only. `opts.repo` makes `pr` a link. The
 * input is not changed.
 */
export function overlayProgress(
  base: TreeNode,
  entries: readonly ProgressEntry[],
  opts: OverlayOptions = {},
): TreeNode {
  const { liveTitle = "Live", ...parse } = opts;
  const root = clone(base);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const refs = openTodoRefs(entries);
  const place = (segs: string[], at: TreeNode, title: (i: number) => string) => {
    let n = at;
    segs.forEach((seg, i) => {
      let hit = n.children.find((c) => matches(c.title, seg));
      if (!hit) {
        hit = { title: title(i), links: [], children: [] };
        n.children.push(hit);
      }
      n = hit;
    });
    return n;
  };
  /** A new node's title: the hub's task for it, else the segment ("/words" at the top). */
  const titleOf = (segs: string[], i: number) => {
    const e = byId.get(`/${segs.slice(0, i + 1).join("/")}`);
    if (e && e.kind !== "person" && e.kind !== "group") return e.task;
    return i === 0 && !segs[0]!.startsWith("@") ? `/${segs[0]}` : segs[i]!;
  };
  // Parents first, so a child lands under its (possibly new) parent.
  const ordered = [...entries].sort((a, b) => a.id.split("/").length - b.id.split("/").length);
  for (const e of ordered) {
    if (e.kind === "group" || e.kind === "person") continue;
    let target: TreeNode;
    if (isPathId(e.id)) {
      const segs = e.id.slice(1).split("/");
      target = place(segs, root, (i) => titleOf(segs, i));
    } else {
      const live = place([slug(liveTitle)], root, () => liveTitle);
      target = live.children.find((c) => c.title === e.task) ?? place([e.id], live, () => e.task);
    }
    apply(target, e, waitsOnOwner(e, refs), parse);
  }
  return root;
}

/** The slice of a WebSocket the feed uses (a browser's, or a fake in tests). */
export type FeedSocket = {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send?(data: string): void;
  close(): void;
};

export type FeedOptions = {
  /** The hub's reader WebSocket URL (ws:// or wss://; http(s):// is converted). */
  url: string;
  socket?: (url: string) => FeedSocket;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
  /** Called with a function to run when the network or the tab comes back; returns its remover. */
  onWake?: (fn: () => void) => () => void;
};

/**
 * A live progress feed: `subscribe` gets the view on every hub message (and
 * `live` false when the socket is lost); `resolve` checks a node off on an
 * open socket ({type:"resolve", id, note?}) — false when none is open.
 */
export type ProgressFeed = {
  subscribe(onView: (view: ProgressView, live: boolean) => void): () => void;
  resolve(id: string, note?: string): boolean;
};

/** Reconnect delays: 1 s doubling to 60 s; after GIVE_UP failures in a row, wait for a wake. */
export const FEED_MAX_DELAY_MS = 60_000;
export const GIVE_UP = 10;

/** ws(s):// for an http(s):// URL; a relative path resolves against the page. */
export function progressSocketUrl(url: string, base?: string): string {
  const u = new URL(url, base ?? globalThis.location?.href);
  if (u.protocol === "https:") u.protocol = "wss:";
  if (u.protocol === "http:") u.protocol = "ws:";
  return u.toString();
}

/** Wake on `online` and on the tab becoming visible (a no-op outside a browser). */
export const browserWake = (fn: () => void): (() => void) => {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const vis = () => document.visibilityState === "visible" && fn();
  window.addEventListener("online", fn);
  document.addEventListener("visibilitychange", vis);
  return () => {
    window.removeEventListener("online", fn);
    document.removeEventListener("visibilitychange", vis);
  };
};

/** The reader's side of the progress hub: one socket per subscriber, reconnecting with backoff. */
export function progressFeed(opts: FeedOptions): ProgressFeed {
  const open = opts.socket ?? ((u: string) => new WebSocket(u) as unknown as FeedSocket);
  const later = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = opts.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const wake = opts.onWake ?? browserWake;
  const ready = new Set<FeedSocket>();
  return {
    resolve(id, note) {
      const ws = ready.values().next().value;
      if (!ws) return false;
      try {
        ws.send?.(JSON.stringify(note ? { type: "resolve", id, note } : { type: "resolve", id }));
        return true;
      } catch {
        return false;
      }
    },
    subscribe(onView) {
      let view: ProgressView = { rows: [], log: [] };
      let live = false;
      let ws: FeedSocket | null = null;
      let retry: unknown;
      let failures = 0;
      let stopped = false;
      const connect = () => {
        if (retry !== undefined) cancel(retry);
        retry = undefined;
        if (stopped || ws) return;
        const sock = open(progressSocketUrl(opts.url));
        ws = sock;
        sock.onopen = () => {
          failures = 0;
          ready.add(sock);
        };
        sock.onmessage = (ev) => {
          const msg = parseProgressMessage(ev.data);
          if (!msg || stopped) return;
          view = applyProgressMessage(view, msg);
          live = true;
          onView(view, true);
        };
        const lost = () => {
          ready.delete(sock);
          if (ws !== sock) return;
          ws = null;
          if (live && !stopped) {
            live = false;
            onView(view, false);
          }
          if (stopped || ++failures > GIVE_UP) return;
          retry = later(connect, Math.min(FEED_MAX_DELAY_MS, 1000 * 2 ** (failures - 1)));
        };
        sock.onclose = lost;
        sock.onerror = () => {
          lost();
          sock.close();
        };
      };
      const off = wake(() => {
        if (ws) return;
        failures = 0;
        connect();
      });
      connect();
      return () => {
        stopped = true;
        if (retry !== undefined) cancel(retry);
        off();
        if (ws) ready.delete(ws);
        ws?.close();
      };
    },
  };
}
