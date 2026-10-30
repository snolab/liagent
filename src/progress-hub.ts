// The progress hub: live progress on the state tree, as a Cloudflare Durable
// Object a site hosts in its own Worker, next to (not inside) the chat hub:
// its own class, its own routes, its own secret.
//
//   // worker.ts
//   import { progressHub, routeProgress } from "liagent/hub";
//   export const ProgressHub = progressHub();       // reads env.PROGRESS_TOKEN
//   export default {
//     async fetch(req, env) {
//       const res = await routeProgress(req, env.PROGRESS, {
//         secret: env.PROGRESS_TOKEN,
//         reader: async (req) => (await mySession(req))?.owner === true,
//       });
//       return res ?? new Response("not found", { status: 404 });
//     },
//   };
//
//   writers   Agents, through `liagent progress` (src/progress-cli.ts), with
//             `Authorization: Bearer <token>`: the secret itself (the root:
//             anywhere) or a scoped token (src/progress-token.ts: one node
//             and its subtree, with an expiry). routeProgress() refuses
//             browsers (any Origin) and answers 503 while the secret is
//             unset; the hub checks the token and the scope.
//   readers   The owner's pages (<liagent-state-tree> with a progress feed),
//             over a hibernatable WebSocket. liagent cannot know who the
//             owner is, so the host decides: routeProgress() calls its
//             `reader(req)` and, only when that says yes, sets
//             PROGRESS_READER_HEADER on the request it forwards (one a client
//             sent is always dropped). The same socket checks off nodes
//             ({type:"resolve", id, note?}). Any valid token may also read
//             the whole tree as JSON (GET).
//
// Every write is an event ({type:"progress", ...node}). State is the latest
// node per `id` (one storage key each), so a reload sees where everything
// stands, plus an append-only log of the last PROGRESS_LOG_MAX events (one key
// each, in order). Each event goes to every reader. A done node is pruned
// PROGRESS_DONE_TTL_MS after its last write by the Durable Object alarm — no
// timers, no polling — and auto-created groups left empty go with it. At most
// PROGRESS_MAX_ENTRIES are kept; past that the oldest done nodes go first.
//
// Writers are rate limited per name and in total, in memory: an evicted hub
// starts a fresh window, which is fine for a limit meant to stop a runaway loop.

import { type Socket, type Storage, pageOriginAllowed } from "./hub.ts";
import {
  PROGRESS_AUTO,
  PROGRESS_DONE_TTL_MS,
  PROGRESS_LIMITS,
  PROGRESS_LOG_MAX,
  PROGRESS_MAX_ENTRIES,
  type ProgressEntry,
  type ProgressEvent,
  type ProgressMessage,
  type ProgressReport,
  autoNode,
  isOwnerTodo,
  isPathId,
  isProgressId,
  mergeProgress,
  parseProgressReport,
  parseTtl,
  pathParent,
  progressEvent,
  progressKey,
} from "./progress.ts";
import { type ProgressAuth, mintProgressToken, verifyProgressToken } from "./progress-token.ts";
import { OWNER_NAME } from "./state-tree.ts";

/** Durable Object storage as the progress hub uses it: the key-value API and the alarm. */
export type ProgressStorage = Storage & {
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
};

export type ProgressState = {
  acceptWebSocket(ws: Socket): void;
  getWebSockets(): Socket[];
  storage: ProgressStorage;
};
declare const WebSocketPair: { new (): { 0: Socket; 1: Socket } };

/**
 * Set to "1" by routeProgress() once the host's `reader(req)` said yes; any a
 * client sent is dropped first. A host that routes to the hub itself must do
 * the same.
 */
export const PROGRESS_READER_HEADER = "x-liagent-progress-reader";
/** Writes allowed per window: per name, and for everyone together. */
export const RATE = { windowMs: 60_000, perName: 30, total: 120 } as const;
/** A report is a few hundred bytes; anything much bigger is not one. */
export const MAX_BODY = 4096;
/** The longest a minted token lives. */
export const GRANT_MAX_MS = 7 * 24 * 60 * 60 * 1000;
export const GRANT_DEFAULT = "8h";
/** The note a check-off writes. */
export const RESOLVED_NOTE = "resolved by owner";

const PREFIX = "e:";
/** Log keys sort in the order the events happened: time, then a sequence number. */
const LOG = "l:";
const logKey = (at: number, seq: number) =>
  `${LOG}${String(at).padStart(15, "0")}:${String(seq).padStart(6, "0")}`;

/**
 * The checks routeProgress() makes before a token route reaches the hub. null = go
 * on; otherwise the response. 403 from a browser (pages never use tokens),
 * 503 while the secret is unset (so a writer sees why), 401 with no bearer.
 */
export function progressGate(req: Request, secret: string | undefined): Response | null {
  if (req.headers.get("origin")) return new Response("forbidden", { status: 403 });
  if (!secret)
    return new Response("the state tree is not configured (no secret set)", { status: 503 });
  if (!/^Bearer \S+$/.test(req.headers.get("authorization") ?? ""))
    return new Response("unauthorized", { status: 401 });
  return null;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  json({ error, ...extra }, status);

export type ProgressHubOptions = {
  /** The env binding that holds the root secret. Default "PROGRESS_TOKEN". */
  secretVar?: string;
};

export class ProgressHub {
  private windows = new Map<string, { start: number; count: number }>();
  private seq = 0;
  private secret: string | undefined;

  /**
   * `env[secretVar]` (default PROGRESS_TOKEN) is the root secret: unset, every
   * token route answers 401 (routeProgress answers 503 first).
   */
  constructor(
    private ctx: ProgressState,
    env?: unknown,
    private now: () => number = Date.now,
    opts: ProgressHubOptions = {},
  ) {
    const v = (env as Record<string, unknown> | undefined)?.[opts.secretVar ?? "PROGRESS_TOKEN"];
    this.secret = typeof v === "string" && v ? v : undefined;
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (req.headers.get(PROGRESS_READER_HEADER) !== "1")
        return new Response("forbidden", { status: 403 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      await this.sendSnapshot([pair[1]]);
      return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
    }
    const token = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
    const auth = this.secret ? await verifyProgressToken(this.secret, token, this.now()) : null;
    if (!auth) return fail(401, "unauthorized (wrong, forged or expired token)");
    if (req.method === "GET") return json(await this.state());
    if (req.method !== "POST") return fail(405, "GET or POST");
    const body = await this.body(req);
    if (body instanceof Response) return body;
    if (path.endsWith("/grant")) return this.grant(auth, body);
    if (path.endsWith("/resolve")) {
      if (!auth.root) return fail(403, "only the owner (the root token) resolves");
      const b = body as { id?: unknown; note?: unknown };
      if (!isProgressId(b.id)) return fail(400, "id is required");
      const note = typeof b.note === "string" && b.note.trim() ? b.note.trim() : RESOLVED_NOTE;
      return this.resolve(b.id, note.slice(0, PROGRESS_LIMITS.note));
    }
    const report = parseProgressReport(body);
    if (report instanceof Error) return fail(400, report.message);
    return this.write(auth, report);
  }

  private async body(req: Request): Promise<unknown> {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return fail(413, "body too large");
    try {
      return JSON.parse(raw);
    } catch {
      return fail(400, "body must be JSON");
    }
  }

  private async all() {
    return new Map(
      [...(await this.ctx.storage.list<ProgressEntry>({ prefix: PREFIX })).values()].map((e) => [
        e.id,
        e,
      ]),
    );
  }

  /** The tree (newest first) and the log (oldest first). */
  private async state() {
    const entries = [...(await this.all()).values()].sort((a, b) => b.at - a.at);
    const log = [...(await this.ctx.storage.list<ProgressEvent>({ prefix: LOG })).values()];
    return { entries, log };
  }

  async sendSnapshot(to: Socket[] = this.ctx.getWebSockets()) {
    this.send(to, { type: "snapshot", ...(await this.state()) });
  }

  private send(to: Socket[], msg: ProgressMessage) {
    const data = JSON.stringify(msg);
    for (const ws of to)
      try {
        ws.send(data);
      } catch {}
  }

  /** Counts one write; false = over the limit. */
  private allow(name: string) {
    const t = this.now();
    const hit = (key: string, max: number) => {
      const w = this.windows.get(key);
      if (!w || t - w.start >= RATE.windowMs) {
        this.windows.set(key, { start: t, count: 1 });
        return true;
      }
      if (w.count >= max) return false;
      w.count++;
      return true;
    };
    return hit("*", RATE.total) && hit(`n:${name}`, RATE.perName);
  }

  private tooMany() {
    const res = fail(429, "too many updates; slow down");
    res.headers.set("retry-after", String(RATE.windowMs / 1000));
    return res;
  }

  /**
   * Is `id` inside the subtree of `node`? Walks parents: a path's directory,
   * otherwise the stored `parent` (`override` stands in for one node's).
   */
  private covers(
    all: Map<string, ProgressEntry>,
    node: string,
    id: string,
    override?: { id: string; parent?: string },
  ) {
    let x: string | undefined = id;
    for (let i = 0; x !== undefined && i < 64; i++) {
      if (x === node) return true;
      x = isPathId(x) ? pathParent(x) : x === override?.id ? override.parent : all.get(x)?.parent;
    }
    return false;
  }

  /** Would `parent` (through its own ancestors) lead back to `id`? */
  private loops(all: Map<string, ProgressEntry>, id: string, parent: string | undefined) {
    return parent !== undefined && this.covers(all, id, parent);
  }

  /** May this token write this report? A message for the 403, or null. */
  private refuse(
    all: Map<string, ProgressEntry>,
    auth: ProgressAuth,
    r: ProgressReport,
    prev: ProgressEntry | undefined,
  ): string | null {
    if (auth.root) return null;
    if (r.assignee.name !== auth.agent)
      return `this token is for ${auth.agent}; it cannot write as ${r.assignee.name}`;
    const newParent = r.parent ?? prev?.parent;
    // A to-do for the owner: anyone may ask, about a node in their own scope.
    if (isOwnerTodo(r.id) && !this.covers(all, auth.node, r.id)) {
      if (prev && prev.creator !== auth.agent) return "this to-do was written by someone else";
      const ref = r.ref ?? prev?.ref;
      if (!ref || !this.covers(all, auth.node, ref))
        return `a to-do for the owner needs a ref inside your scope (${auth.node})`;
      return null;
    }
    if (prev) {
      if (!this.covers(all, auth.node, r.id)) return `${r.id} is outside your scope (${auth.node})`;
      if (newParent !== prev.parent) {
        if (r.id === auth.node) return "you cannot move the root of your own scope";
        if (!newParent || !this.covers(all, auth.node, newParent))
          return `cannot move ${r.id} outside your scope (${auth.node})`;
      }
      // Status, pct and eta: the creator's, or an ancestor scope's.
      const mine =
        prev.creator === auth.agent || prev.creator === PROGRESS_AUTO || auth.node !== r.id;
      if (
        !mine &&
        (r.status !== prev.status ||
          (r.pct !== undefined && r.pct !== prev.pct) ||
          (r.eta !== undefined && r.eta !== prev.eta))
      )
        return `only ${prev.creator} (or a scope above) sets the status, pct and eta of ${r.id}`;
      return null;
    }
    if (r.id === auth.node) return null;
    if (!newParent) return `a new node in your scope needs a parent inside it (${auth.node})`;
    if (!this.covers(all, auth.node, r.id, { id: r.id, parent: newParent }))
      return `${r.id} is outside your scope (${auth.node})`;
    return null;
  }

  private async write(auth: ProgressAuth, r: ProgressReport): Promise<Response> {
    const all = await this.all();
    const prev = all.get(r.id);
    const refused = this.refuse(all, auth, r, prev);
    if (refused) return fail(403, refused);
    const parent = r.parent ?? prev?.parent;
    if (this.loops(all, r.id, parent)) return fail(400, `${parent} is inside ${r.id}: a loop`);
    if (parent && !isPathId(parent) && !all.has(parent))
      return fail(400, `unknown parent ${parent}`);
    if (r.rev !== undefined && prev && r.rev <= prev.rev)
      return fail(409, `stale rev ${r.rev}; ${r.id} is at ${prev.rev}`, { rev: prev.rev });
    if (!this.allow(r.assignee.name)) return this.tooMany();

    const t = this.now();
    // A path's missing ancestors become groups, outermost first.
    const missing: ProgressEntry[] = [];
    for (let p = parent; p !== undefined && isPathId(p) && !all.has(p); p = pathParent(p))
      missing.unshift(autoNode(p, r.assignee.name, t));
    const entry = mergeProgress(prev, r, t);
    const events = [...missing.map((e) => progressEvent(e)), progressEvent(entry, r.note)];
    const evicted = await this.store([...missing, entry], all);
    for (const ev of events) await this.append(ev);
    if (evicted) await this.sendSnapshot();
    else for (const ev of events) this.send(this.ctx.getWebSockets(), ev);
    return json({ ok: true, entry, readers: this.ctx.getWebSockets().length });
  }

  /** Put nodes, making room past PROGRESS_MAX_ENTRIES; true if any were dropped. */
  private async store(entries: ProgressEntry[], all: Map<string, ProgressEntry>) {
    const fresh = entries.filter((e) => !all.has(e.id)).length;
    const over = all.size + fresh - PROGRESS_MAX_ENTRIES;
    let dropped = false;
    if (over > 0) {
      const keep = new Set(entries.map((e) => e.id));
      const oldest = [...all.values()].filter((e) => !keep.has(e.id)).sort((a, b) => a.at - b.at);
      const order = [
        ...oldest.filter((e) => e.status === "done"),
        ...oldest.filter((e) => e.status !== "done"),
      ];
      for (const e of order.slice(0, over)) {
        await this.ctx.storage.delete(progressKey(e));
        dropped = true;
      }
    }
    for (const e of entries) {
      await this.ctx.storage.put(progressKey(e), e);
      if (e.status === "done") await this.schedule(e.at + PROGRESS_DONE_TTL_MS);
    }
    return dropped;
  }

  /** Append one event, dropping the oldest past PROGRESS_LOG_MAX. */
  private async append(ev: ProgressEvent) {
    await this.ctx.storage.put(logKey(ev.at, this.seq++ % 1_000_000), ev);
    const keys = [...(await this.ctx.storage.list({ prefix: LOG })).keys()];
    for (const k of keys.slice(0, Math.max(0, keys.length - PROGRESS_LOG_MAX)))
      await this.ctx.storage.delete(k);
  }

  /**
   * The owner checks off a node: done, `needs` cleared, the answer noted. An
   * owner to-do also resolves the decision or approval it refs.
   */
  async resolve(id: string, note: string = RESOLVED_NOTE): Promise<Response> {
    const all = await this.all();
    const target = all.get(id);
    if (!target) return fail(404, `no node ${id}`);
    if (!this.allow(OWNER_NAME)) return this.tooMany();
    const done: ProgressEntry[] = [];
    const close = (e: ProgressEntry) => {
      const r: ProgressReport = {
        id: e.id,
        assignee: { type: "human", name: OWNER_NAME },
        task: e.task,
        status: "done",
        needs: "",
        note,
      };
      done.push(mergeProgress(e, r, this.now()));
    };
    if (target.status !== "done") close(target);
    const ref = isOwnerTodo(id) && target.ref ? all.get(target.ref) : undefined;
    if (ref && ref.status !== "done" && (ref.kind === "decision" || ref.kind === "approval"))
      close(ref);
    for (const e of done) {
      // The node keeps its creator and assignee; only `by` says the owner did it.
      const was = all.get(e.id) as ProgressEntry;
      const kept = { ...e, assignee: was.assignee, creator: was.creator };
      await this.ctx.storage.put(progressKey(kept), kept);
      await this.schedule(kept.at + PROGRESS_DONE_TTL_MS);
      const ev = progressEvent(kept, note);
      await this.append(ev);
      this.send(this.ctx.getWebSockets(), ev);
    }
    return json({ ok: true, resolved: done.map((e) => e.id) });
  }

  /** Mint a token for `node` (inside the asking token's scope), signed with the root. */
  private async grant(auth: ProgressAuth, body: unknown): Promise<Response> {
    const b = (body ?? {}) as { node?: unknown; agent?: unknown; ttl?: unknown };
    if (!isProgressId(b.node)) return fail(400, "node must be a node id");
    if (typeof b.agent !== "string" || !b.agent.trim() || b.agent.length > PROGRESS_LIMITS.name)
      return fail(400, `agent must be a name of at most ${PROGRESS_LIMITS.name} characters`);
    const ttl = parseTtl(typeof b.ttl === "string" ? b.ttl : GRANT_DEFAULT);
    if (ttl instanceof Error) return fail(400, ttl.message);
    if (!auth.root && !this.covers(await this.all(), auth.node, b.node))
      return fail(403, `${b.node} is outside your scope (${auth.node})`);
    const t = this.now();
    const exp = Math.min(t + Math.min(ttl, GRANT_MAX_MS), auth.root ? Infinity : auth.exp);
    const grant = { node: b.node, agent: b.agent.trim(), exp, via: auth.root ? "root" : auth.node };
    return json({ token: await mintProgressToken(this.secret!, grant), ...grant });
  }

  /** Make sure the alarm goes off by `at` (one already due is the one running now). */
  private async schedule(at: number) {
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > at || cur <= this.now()) await this.ctx.storage.setAlarm(at);
  }

  /** The Durable Object alarm: prune done nodes past their TTL and empty auto groups, then wait for the next. */
  async alarm() {
    const t = this.now();
    const all = await this.all();
    let pruned = 0;
    let next = Infinity;
    for (const e of all.values()) {
      if (e.status !== "done") continue;
      const due = e.at + PROGRESS_DONE_TTL_MS;
      if (due <= t) {
        all.delete(e.id);
        await this.ctx.storage.delete(progressKey(e));
        pruned++;
      } else next = Math.min(next, due);
    }
    for (let again = pruned > 0; again;) {
      again = false;
      const parents = new Set([...all.values()].map((e) => e.parent));
      for (const e of all.values())
        if (e.creator === PROGRESS_AUTO && e.kind === "group" && !parents.has(e.id)) {
          all.delete(e.id);
          await this.ctx.storage.delete(progressKey(e));
          again = true;
        }
    }
    if (next !== Infinity) await this.ctx.storage.setAlarm(next);
    if (pruned) await this.sendSnapshot();
  }

  /** The owner's page checks off a node: {type:"resolve", id, note?}. Nothing else is heard. */
  async webSocketMessage(_ws: Socket, raw: string | ArrayBuffer) {
    let m: { type?: unknown; id?: unknown; note?: unknown };
    try {
      m = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (m?.type !== "resolve" || !isProgressId(m.id)) return;
    const note = typeof m.note === "string" && m.note.trim() ? m.note.trim() : RESOLVED_NOTE;
    await this.resolve(m.id, note.slice(0, PROGRESS_LIMITS.note));
  }
  webSocketClose(ws: Socket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {}
  }
  webSocketError(ws: Socket) {
    this.webSocketClose(ws, 1011);
  }
}

/**
 * A ProgressHub class with these options baked in, to export from your Worker
 * as the Durable Object: `export const ProgressHub = progressHub()`.
 */
export function progressHub(opts: ProgressHubOptions = {}): typeof ProgressHub {
  return class extends ProgressHub {
    constructor(ctx: ProgressState, env?: unknown) {
      super(ctx, env, Date.now, opts);
    }
  };
}

type Stub = { fetch(req: Request): Promise<Response> };
type Namespace = { idFromName(name: string): unknown; get(id: unknown): Stub };

export type ProgressRouteOptions = {
  /** The hub's root secret (the same the Durable Object reads); unset answers 503 to writers. */
  secret: string | undefined;
  /**
   * May this WebSocket request read the tree (and check nodes off)? The host's
   * own session check — typically "is this the owner". Only called for a
   * socket from an allowed Origin; a throw counts as no.
   */
  reader: (req: Request) => Promise<boolean> | boolean;
  /** The path (writers POST here and to /grant, /resolve below it; readers open a socket). Default /api/progress. */
  path?: string;
  /** The Durable Object's name in the namespace. Default "progress". */
  name?: string;
  /** Origins, besides the request's own, whose pages may open the reader socket (exact match). */
  allowedOrigins?: string[];
};

/**
 * Route a request to the progress hub if it is under `path`; null otherwise
 * (so the site's own routes go on). A WebSocket is a reader: from an allowed
 * Origin and only if `reader(req)` says so, marked with
 * PROGRESS_READER_HEADER. Anything else is a writer (progressGate: no
 * Origin, a secret set, a bearer token), forwarded without that header.
 */
export async function routeProgress(
  req: Request,
  ns: Namespace,
  opts: ProgressRouteOptions,
): Promise<Response | null> {
  const url = new URL(req.url);
  const path = (opts.path ?? "/api/progress").replace(/\/+$/, "");
  if (url.pathname !== path && !url.pathname.startsWith(`${path}/`)) return null;
  const headers = new Headers(req.headers);
  headers.delete(PROGRESS_READER_HEADER);
  const hub = ns.get(ns.idFromName(opts.name ?? "progress"));
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    const refused = progressGate(req, opts.secret);
    if (refused) return refused;
    return hub.fetch(new Request(req, { headers }));
  }
  if (!pageOriginAllowed(req, opts.allowedOrigins))
    return new Response("forbidden origin", { status: 403 });
  let ok = false;
  try {
    ok = (await opts.reader(req)) === true;
  } catch {
    ok = false;
  }
  if (!ok) return new Response("forbidden", { status: 403 });
  headers.set(PROGRESS_READER_HEADER, "1");
  return hub.fetch(new Request(req, { headers }));
}
