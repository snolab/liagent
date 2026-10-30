// The chat hub: a Cloudflare Durable Object a site hosts in its own Worker,
// because only the site can say who a page belongs to.
//
//   // worker.ts
//   import { chatHub, routeChat } from "liagent/hub";
//   export const ChatHub = chatHub({ eval: false });
//   export default {
//     async fetch(req, env) {
//       const res = await routeChat(req, env.CHAT, {
//         identify: async (req) => mySession(req), // {userId, email, owner} | null
//       });
//       return res ?? new Response("not found", { status: 404 });
//     },
//   };
//
// Two kinds of socket meet here, both held with the hibernation API (all
// state lives in each socket's attachment, so eviction loses nothing):
//
//   page        A signed-in user's page (src/client.ts). routeChat() has asked
//               the site who it is and passes that on in IDENTITY_HEADERS,
//               which a client can never set itself. Each page belongs to a
//               thread: "owner" for the owner's pages, the user id for anyone
//               else (a "friend").
//   controller  The agent (`liagent pair|listen|say`, src/cli.ts).
//               Unauthenticated, so it can do nothing until approved on a
//               page: the hub shows a prompt with its label and a short code
//               the CLI prints too. A browser always sends Origin, so
//               routeChat() refuses a controller that has one: web pages
//               cannot raise prompts.
//
// Approvals. An agent knocks asking for a scope (?scope=chat|eval). "chat"
// grants 30 days of chat, always on all of the user's pages (it must
// survive app switches), with a random grant token the agent resumes with
// (header x-liagent-token); only its SHA-256 is stored. "eval" (only on a
// hub made with {eval: true}) grants 8 hours of eval and chat, with a
// resumable token too, for the pages the user ticks (by id: the page they answer on by
// default) or "all" (including pages that connect later); eval, busy beats
// and live replies reach only those pages, while history stays shared.
// Allowing it again from another page adds that page. A tab keeps its page
// id across reconnects (?page=), so an app switch keeps the grant. When
// every page of a grant has stayed closed for PAGES_GONE_MS, the agent's
// socket is closed (4409, checked at the next event, no timers), but the
// stored grant stays: it resumes with its token once a page is back. A
// stored eval grant that no socket holds is listed to the user's pages as a
// session with code "idle", so End still reaches it.
// An agent that names no scope (an older client) gets what the owner's answer
// says: {scope:"chat"} is the 30-day chat grant, anything else the hour.
// End revokes a grant, on every socket using it.
//
// Audiences. A pairing is for the owner, or (`?for=<email>`, asked with an
// owner grant, and only on an eval hub) for one friend: its prompt shows only
// on that audience's pages, only they can answer it, and its evals reach only
// them. One pairing may wait per audience (PENDING_MS at most).
//
// Chat. A page sends {type:"chat"}; an owner-approved agent sends
// {type:"say", text, to?}. Each becomes a ChatMessage in its thread (the
// last CHAT_HISTORY per thread, one storage key each), sent to that thread's
// pages and to every owner-approved agent in time — which hear every thread.
// Friends chat without approval, at most `friendChatMax` per
// `friendWindowMs`; the owner can block one (block(), or the internal API).
//
// Pages. Each page socket has an id; `state` lists the audience's pages
// ({id, label, at}) and the receiving page's own id (`self`). A page reports
// client-side navigation with {type:"page", label}: the hub relabels it and
// tells the agents {type:"page-changed", label, thread, at} (never stored).
// The owner can close one of their pages with {type:"end-page", id} (4410).
//
// Busy. An agent sends {type:"busy", to?} as a heartbeat while it works; the
// hub relays {type:"busy", label, at} to that thread's pages (the owner's:
// only the pages of its grant). Pages show a spinner while the last beat is
// under BUSY_MS old and no reply came since; the hub keeps no busy state.
//
// Node paths. Messages are addressed to state-tree nodes ("/words/prefetch");
// a node's assignee (an agent or a human) receives them. An agent listens at
// a node with ?node=<path>&agent=<id> (absent = "/", the main thread, as
// before). A line with `to: P` (the owner's "@/words …", or an agent's say to
// "/…") reaches the agents at P, and every ancestor's as `observed: true` — the
// root's sees everything; siblings and descendants never. An agent line
// carries `taskPath` and `agentId`. An agent may address its own subtree and
// any ancestor; anything else needs a node grant ({type:"grant", from, to})
// from an agent whose node holds both (the root's always may), stored as
// `ngrant:<from>><to>`, else {type:"error", reason:"out of scope: …"}. The
// owner's pages see every line, whatever its node.
//
// Voice edits. A page marks an owner line sent from the box's mic, unchanged,
// `source: "stt"`. The agent may polish it ({type:"edit", id, text}) — STT
// gets words wrong and has no context — only if all hold: the sender holds a
// live owner grant (chat or eval; never a friend's pairing), the line is the
// owner's latest in the owner thread, it is `stt`, and it was polished fewer
// than MAX_EDITS times. The first STT text stays as `raw`; `edited: {at, by,
// count}` marks it. Pages and listeners hear {type:"edited", id, thread,
// text, raw, edited}. Friends' lines never.
//
// No timers and no polling: expiry is checked whenever the next event
// arrives. Storage keys match the hub this was ported from (owner thread
// `seq`/`msg:<seq>`, friends `t:<id>:…`, `friend:<id>`, `grant:<hash>`), so
// an existing namespace keeps its history.

import {
  APPROVAL_MS,
  CHAT_HISTORY,
  EVAL_GRANT_MS,
  CHAT_MS,
  type ChatMessage,
  type EditedEvent,
  type HubState,
  MAX_EDITS,
  MAX_LABEL,
  type NodeGrant,
  ROOT_NODE,
  agentIdOf,
  isWithin,
  mayAddress,
  nodePath,
  routeTo,
  PAGES_GONE_MS,
  PENDING_MS,
  type PageInfo,
  type PairInfo,
  type Scope,
  cleanLabel,
  isPageId,
  matchesTarget,
  parseControllerMessage,
  parsePageMessage,
  shortCode,
} from "./protocol.ts";

/** The owner's chat thread; every other thread is a friend's user id. */
export const OWNER_THREAD = "owner";
/** Who a page belongs to, as the site says (routeChat's `identify`). */
export type Identity = { userId: string; email: string; owner: boolean };
/** A user id usable as a thread and a storage key: no separators, bounded. */
export const isUserId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) && v !== OWNER_THREAD;
/** A friend who has used the chat (`friend:<userId>`). */
export type FriendRecord = {
  email: string;
  firstSeen: number;
  lastAt: number;
  count: number;
  blocked?: boolean;
  blockedAt?: number;
};

export type HubOptions = {
  /** Let an eval approval run code on the approved pages (8 hours). Default false. */
  eval?: boolean;
  /** Messages a friend may send per window. Default 30. */
  friendChatMax?: number;
  /** That window. Default 10 minutes. */
  friendWindowMs?: number;
  /**
   * Put the start of each message (80 chars) and of eval code (200) in the
   * Worker logs. Default false: logs keep only lengths, since they hold what
   * the user and their friends wrote.
   */
  logContent?: boolean;
};

export type Socket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState?: number;
  serializeAttachment(v: unknown): void;
  deserializeAttachment(): unknown;
};
export type Storage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(opts: { prefix: string; reverse?: boolean; limit?: number }): Promise<Map<string, T>>;
};
export type DOState = {
  acceptWebSocket(ws: Socket): void;
  getWebSockets(): Socket[];
  storage: Storage;
  /** Cloudflare's: holds every event until `fn` is done (used to load state on wake). */
  blockConcurrencyWhile?<T>(fn: () => Promise<T>): Promise<T>;
};

/** Who a page is: set by routeChat() from the site's answer, never by the page. */
export const IDENTITY_HEADERS = {
  user: "x-liagent-user",
  email: "x-liagent-email",
  owner: "x-liagent-owner",
} as const;
/** The agent's client IP, set by routeChat from cf-connecting-ip (never by the client). */
export const IP_HEADER = "x-liagent-ip";
/** The header an agent resumes its chat grant with. */
export const TOKEN_HEADER = "x-liagent-token";

type PageAtt = {
  role: "page";
  id: string;
  label: string;
  at: number;
  thread: string;
  email?: string;
  /** When a friend's page last relabelled (they are limited; the user's pages are not). */
  relabelAt?: number;
};
/**
 * `grant`: the hash of the token this socket resumed or got. `forUser`: the
 * friend it is for. `want`: the scope it asked for (absent: an older client).
 */
type ControllerAtt = {
  role: "controller";
  grant?: string;
  forUser?: string;
  forEmail?: string;
  want?: Scope;
  /** The client IP it knocked from (routeChat's IP_HEADER), for the pairing limits. */
  ip?: string;
  /** When the last page of its grant closed (pages it may reopen with the same id). */
  goneSince?: number;
  /** The state-tree node this agent listens at (`?node=`); absent = "/". */
  node?: string;
  /** The node's assignee (`?agent=`): the agent's id on its lines. */
  assignee?: string;
} & PairInfo;
/**
 * A stored grant (`grant:<sha256 of its token>`). `scope` absent = "chat"
 * (older grants). `pages`: the page ids an eval grant covers. `at`: when it
 * was allowed.
 */
type Grant = { label: string; until: number; pages?: string[] | "all"; scope?: Scope; at?: number };
/** A sleeping eval grant's pair id in the pages' state: "g:" + the start of its hash. */
const DORMANT = "g:";
const dormantPair = (hash: string) => `${DORMANT}${hash.slice(0, 40)}`;
type Rate = { start: number; count: number };
/** A pairing-limit counter: its window's start and count, and the last deny. */
type Knock = { start: number; count: number; deniedAt?: number };
type Att = PageAtt | ControllerAtt;
declare const WebSocketPair: { new (): { 0: Socket; 1: Socket } };

const att = (ws: Socket): Att | null => {
  try {
    return (ws.deserializeAttachment() as Att | null) ?? null;
  } catch {
    return null;
  }
};
const send = (ws: Socket, msg: unknown) => {
  try {
    ws.send(JSON.stringify(msg));
  } catch {}
};
const close = (ws: Socket, code: number, reason: string) => {
  try {
    ws.close(code, reason);
  } catch {}
};
const info = ({ pair, code, label, at, until, scope, want, pages }: ControllerAtt): PairInfo =>
  until
    ? { pair, code, label, at, until, scope: scope ?? "eval", pages: pages ?? "all" }
    : want
      ? { pair, code, label, at, scope: want }
      : { pair, code, label, at };
/** Whether a grant covers a page: "all" (or an older grant with no list), or by id. */
const covers = (pages: string[] | "all" | undefined, id: string) =>
  pages === undefined || pages === "all" || pages.includes(id);
const pageId = () => crypto.randomUUID().slice(0, 8);
const hex = (b: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
export const hashToken = async (token: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
const log = (o: Record<string, unknown>) => console.log(JSON.stringify(o));
const nodeGrantKey = (from: string, to: string) => `ngrant:${from}>${to}`;
/** Where an agent listens, from its knock: `?node=` (a node path) and `?agent=`. */
const whereOf = (url: URL): { node?: string; assignee?: string } => {
  const node = nodePath(url.searchParams.get("node") ?? undefined);
  const assignee = agentIdOf(url.searchParams.get("agent") ?? undefined);
  const out: { node?: string; assignee?: string } = {};
  if (node && node !== ROOT_NODE) out.node = node;
  if (assignee) out.assignee = assignee;
  return out;
};
/** A history as one agent sees it: only the lines routed to its node. */
const forNode = (list: ChatMessage[], node?: string) =>
  node ? list.filter((m) => routeTo(node, m.to)) : list;
/** Whose a socket is: a page's thread, or the audience a controller was paired for. */
const audience = (a: Att) => (a.role === "page" ? a.thread : (a.forUser ?? OWNER_THREAD));
const threadKeys = (thread: string) =>
  thread === OWNER_THREAD
    ? { seq: "seq", prefix: "msg:" }
    : { seq: `t:${thread}:seq`, prefix: `t:${thread}:msg:` };
const msgKey = (thread: string, seq: number) =>
  `${threadKeys(thread).prefix}${String(seq).padStart(12, "0")}`;
const friendKey = (userId: string) => `friend:${userId}`;
/** The pairing limits' keys: one per (audience, client IP), and one per audience. */
const knockKey = (who: string, ip?: string) => (ip === undefined ? `${who}\n*` : `${who}\n${ip}`);
/** After the user denies a pairing, that audience takes no new request for this long. */
export const PAIR_COOLDOWN_MS = 60_000;
/**
 * At most PAIR_MAX pairing requests per audience and client IP per
 * PAIR_WINDOW_MS, and PAIR_AUDIENCE_MAX per audience from all IPs together
 * (which bounds the prompts the user sees). Keyed by IP too, so a stranger
 * using up their own quota cannot lock the user's agent out. A request waits
 * up to PENDING_MS (2 min), so the window must be longer than PAIR_MAX of
 * those, or re-knocking as each lapses would never hit the cap.
 */
export const PAIR_MAX = 3;
export const PAIR_AUDIENCE_MAX = 10;
export const PAIR_WINDOW_MS = 15 * 60_000;
/** A friend's page may relabel at most once per this long; faster ones are dropped. */
export const FRIEND_RELABEL_MS = 1_000;
/** A friend may hold at most this many page sockets at once. */
export const FRIEND_MAX_PAGES = 8;

export class ChatHub {
  protected opts: Required<HubOptions> = {
    eval: false,
    friendChatMax: 30,
    friendWindowMs: 10 * 60_000,
    logContent: false,
  };

  /** `{head}` for a log line, only when the hub logs content. */
  private head(text: string, n = 80): { head?: string } {
    return this.opts.logContent ? { head: text.slice(0, n) } : {};
  }

  constructor(
    private ctx: DOState,
    _env?: unknown,
    private now: () => number = Date.now,
    opts: HubOptions = {},
  ) {
    this.opts = { ...this.opts, ...stripUndefined(opts) };
    // The pairing limits survive hibernation: load them before any event.
    if (ctx.blockConcurrencyWhile) void ctx.blockConcurrencyWhile(() => this.loadKnocks());
  }

  /**
   * Every stored grant by hash: read once per instance (an evicted hub reads
   * it again), then kept in step with each write. Only the listing of
   * sleeping eval grants uses it; a resume always asks storage itself.
   */
  private grants?: Map<string, Grant>;
  /**
   * Pairing requests per (audience, IP) and per audience, to bound the
   * prompts anyone can raise: the window's start and count, and when the
   * user last denied one. Read synchronously from this map, written through
   * to storage (`knock:<key>`), and loaded back when a hub wakes from
   * hibernation (under blockConcurrencyWhile, before any event), so an
   * evicted hub does not forget them. Where the host has no
   * blockConcurrencyWhile they are kept in memory only.
   */
  private knocks = new Map<string, Knock>();

  private setKnock(key: string, k: Knock) {
    this.knocks.set(key, k);
    // Durable Objects hold outgoing messages until this write commits.
    void this.ctx.storage.put(`knock:${key}`, k);
  }

  /** Load the stored counters; drop those whose window and cooldown have both passed. */
  private async loadKnocks() {
    const t = this.now();
    const m = await this.ctx.storage.list<Knock>({ prefix: "knock:" });
    for (const [k, v] of m) {
      const key = k.slice("knock:".length);
      const live =
        t - v.start < PAIR_WINDOW_MS ||
        (v.deniedAt !== undefined && t - v.deniedAt < PAIR_COOLDOWN_MS);
      if (live) this.knocks.set(key, v);
      else await this.ctx.storage.delete(k);
    }
  }

  /**
   * Room for one more pairing request for audience `who` from client `ip`:
   * false (and `ws` closed with 4429) if not. Per (audience, IP): a
   * cooldown after the user denied that IP's request, and PAIR_MAX per
   * window. Per audience: PAIR_AUDIENCE_MAX per window from all IPs. Without
   * an IP (a hub not behind routeChat on Cloudflare), every request shares
   * one key.
   */
  private knockAllowed(ws: Socket, who: string, ip = "?") {
    const t = this.now();
    const fresh = (k?: Knock) =>
      !k || t - k.start >= PAIR_WINDOW_MS ? { start: t, count: 0, deniedAt: k?.deniedAt } : k;
    const mine = fresh(this.knocks.get(knockKey(who, ip)));
    const all = fresh(this.knocks.get(knockKey(who)));
    if (mine.deniedAt && t - mine.deniedAt < PAIR_COOLDOWN_MS) {
      send(ws, { type: "error", error: "a pairing was just denied: try again in a minute" });
      close(ws, 4429, "pairing cooling down");
      return false;
    }
    if (mine.count >= PAIR_MAX || all.count >= PAIR_AUDIENCE_MAX) {
      send(ws, { type: "error", error: "too many pairing requests: try again later" });
      close(ws, 4429, "pairing rate limit");
      return false;
    }
    this.setKnock(knockKey(who, ip), { ...mine, count: mine.count + 1 });
    this.setKnock(knockKey(who), { ...all, count: all.count + 1 });
    return true;
  }
  private loadingGrants?: Promise<void>;

  private loadGrants(): Promise<void> {
    if (this.grants) return Promise.resolve();
    this.loadingGrants ??= this.ctx.storage.list<Grant>({ prefix: "grant:" }).then((m) => {
      this.grants = new Map([...m].map(([k, g]) => [k.slice("grant:".length), g]));
      this.loadingGrants = undefined;
    });
    return this.loadingGrants;
  }

  private async putGrant(hash: string, g: Grant) {
    await this.loadGrants();
    await this.ctx.storage.put(`grant:${hash}`, g);
    this.grants?.set(hash, g);
  }

  private async dropGrant(hash: string) {
    await this.loadGrants();
    await this.ctx.storage.delete(`grant:${hash}`);
    this.grants?.delete(hash);
  }

  /** Open sockets of one role, optionally leaving one out (the one closing). */
  private sockets<R extends Att["role"]>(role: R, except?: Socket) {
    const out: { ws: Socket; a: Extract<Att, { role: R }> }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || (ws.readyState !== undefined && ws.readyState > 1)) continue;
      const a = att(ws);
      if (a?.role === role) out.push({ ws, a: a as Extract<Att, { role: R }> });
    }
    return out;
  }

  private pages(thread: string, except?: Socket) {
    return this.sockets("page", except).filter((p) => p.a.thread === thread);
  }

  /**
   * Owner-approved agents still in time. They hear every thread and may `say`
   * to any. A pairing made for a friend is not one.
   */
  private listeners(except?: Socket) {
    const t = this.now();
    return this.sockets("controller", except).filter(
      (c) => !c.a.forUser && c.a.until && c.a.until > t,
    );
  }

  /** What one audience's pages see: its pairings, how many agents listen, its pages. */
  private state(who: string, except?: Socket, self = ""): HubState {
    const t = this.now();
    let pending: PairInfo | null = null;
    const sessions: PairInfo[] = [];
    const held = new Set<string>();
    for (const { a } of this.sockets("controller", except)) {
      if (a.grant) held.add(a.grant);
      if (audience(a) !== who) continue;
      if (a.until) {
        if (a.until > t) sessions.push(info(a));
      } else if (t - a.at < PENDING_MS) pending = info(a);
    }
    // The user's eval grants that no socket holds now: asleep, but End reaches them.
    if (who === OWNER_THREAD)
      for (const [hash, g] of this.grants ?? [])
        if (g.scope === "eval" && g.until > t && !held.has(hash))
          sessions.push({
            pair: dormantPair(hash),
            code: "idle",
            label: g.label,
            at: g.at ?? 0,
            until: g.until,
            scope: "eval",
            pages: g.pages ?? "all",
          });
    const pages: PageInfo[] = this.pages(who, except).map(({ a }) => ({
      id: a.id,
      label: a.label,
      at: a.at,
    }));
    const agents = this.listeners(except);
    const nodes = [...new Set(agents.map((c) => c.a.node).filter((n): n is string => !!n))].sort();
    return {
      type: "state",
      pending,
      sessions,
      listeners: agents.length,
      pages,
      self,
      ...(nodes.length ? { nodes } : {}),
    };
  }

  /** Send every page its audience's state; `skip` is left out of the sending only. */
  private broadcast(except?: Socket, skip?: Socket) {
    const by = new Map<string, HubState>();
    for (const { ws, a } of this.sockets("page", except)) {
      if (ws === skip) continue;
      let s = by.get(a.thread);
      if (!s) by.set(a.thread, (s = this.state(a.thread, except)));
      send(ws, { ...s, self: a.id });
    }
  }

  private controller(pair: string) {
    return this.sockets("controller").find((c) => c.a.pair === pair);
  }

  /** One thread's kept chat, oldest first. */
  async history(thread: string = OWNER_THREAD): Promise<ChatMessage[]> {
    const m = await this.ctx.storage.list<ChatMessage>({
      prefix: threadKeys(thread).prefix,
      reverse: true,
      limit: CHAT_HISTORY,
    });
    return [...m.values()].reverse().map((x) => ({ thread, ...x }));
  }

  /**
   * Keep one message (dropping its thread's oldest past CHAT_HISTORY) and send
   * it on. An agent's reply in the owner's thread goes live only to the pages
   * of its grant (`only`); every page still gets it in its history.
   */
  private async post(m: ChatMessage & { thread: string; email?: string }, only?: string[] | "all") {
    const { seq: seqKey } = threadKeys(m.thread);
    const seq = ((await this.ctx.storage.get<number>(seqKey)) ?? 0) + 1;
    await this.ctx.storage.put(seqKey, seq);
    await this.ctx.storage.put(msgKey(m.thread, seq), m);
    if (seq > CHAT_HISTORY) await this.ctx.storage.delete(msgKey(m.thread, seq - CHAT_HISTORY));
    const out = { type: "chat", message: m };
    for (const { ws, a } of this.pages(m.thread)) if (covers(only, a.id)) send(ws, out);
    // Agents by node: that node's, and its ancestors' as observers (the root's sees all).
    for (const { ws, a } of this.listeners()) {
      const route = routeTo(a.node, m.to);
      if (route) send(ws, route === "observed" ? { ...out, observed: true } : out);
    }
  }

  /**
   * The agent polishes the owner's latest voice line (see "Voice edits"
   * above). Every refusal is an {type:"error"} naming the rule it broke.
   */
  private async edit(ws: Socket, c: ControllerAtt, m: { id: string; text: string }) {
    const fail = (reason: string) => send(ws, { type: "error", error: reason, reason });
    if (c.forUser) return fail("a pairing for a friend cannot edit");
    const g = c.grant ? await this.ctx.storage.get<Grant>(`grant:${c.grant}`) : undefined;
    if (!g || g.until <= this.now()) return fail("edit needs a live chat grant from the owner");
    // The owner's latest line in the owner thread, and its storage key.
    const kept = await this.ctx.storage.list<ChatMessage>({
      prefix: threadKeys(OWNER_THREAD).prefix,
      reverse: true,
      limit: CHAT_HISTORY,
    });
    const latest = [...kept].find(([, x]) => x.from === "owner");
    if (!latest || latest[1].id !== m.id) {
      const known = [...kept].some(([, x]) => x.id === m.id);
      return fail(
        known
          ? `message ${m.id} is not the owner's latest: only the latest may be polished`
          : `no message ${m.id} in the owner's thread (friends' lines can never be edited)`,
      );
    }
    const [key, line] = latest;
    if (line.source !== "stt")
      return fail(`message ${m.id} was typed, not spoken: only voice (stt) lines may be polished`);
    const count = line.edited?.count ?? 0;
    if (count >= MAX_EDITS) return fail(`message ${m.id} was already polished ${MAX_EDITS} times`);
    if (m.text === line.text) return fail(`message ${m.id} already reads that way`);
    const t = this.now();
    const by = cleanLabel(c.assignee ?? c.label, 80) || "agent";
    const raw = line.raw ?? line.text;
    const edited = { at: t, by, count: count + 1 };
    await this.ctx.storage.put(key, { ...line, text: m.text, raw, edited } satisfies ChatMessage);
    const out: EditedEvent = {
      type: "edited",
      id: line.id,
      thread: OWNER_THREAD,
      text: m.text,
      raw,
      edited,
    };
    log({
      msg: "chat.edit",
      pair: c.pair,
      id: line.id,
      by,
      count: count + 1,
      len: m.text.length,
      ...this.head(m.text),
    });
    for (const { ws: p } of this.pages(OWNER_THREAD)) send(p, out);
    let told = false;
    for (const { ws: l, a } of this.listeners()) {
      const route = routeTo(a.node, line.to);
      if (!route) continue;
      if (l === ws) told = true;
      send(l, route === "observed" ? { ...out, observed: true } : out);
    }
    if (!told) send(ws, out);
  }

  /** The live node grants (`ngrant:`), lapsed ones dropped as they are met. */
  private async nodeGrants(): Promise<NodeGrant[]> {
    const t = this.now();
    const out: NodeGrant[] = [];
    for (const [k, g] of await this.ctx.storage.list<NodeGrant>({ prefix: "ngrant:" }))
      if (g.until > t) out.push(g);
      else await this.ctx.storage.delete(k);
    return out;
  }

  /** Everyone who has used the chat, most recent first. */
  async friends(): Promise<({ userId: string } & FriendRecord)[]> {
    const m = await this.ctx.storage.list<FriendRecord>({ prefix: "friend:" });
    return [...m.entries()]
      .map(([k, v]) => ({ userId: k.slice("friend:".length), ...v }))
      .sort((a, b) => b.lastAt - a.lastAt);
  }

  /** A friend by user id or (any case) email. */
  private async findFriend(key: string) {
    if (isUserId(key)) {
      const rec = await this.ctx.storage.get<FriendRecord>(friendKey(key));
      if (rec) return { userId: key, ...rec };
    }
    const want = key.trim().toLowerCase();
    return (await this.friends()).find((f) => f.email.toLowerCase() === want);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/internal/friends")) return this.friendsApi(req, url);
    const control = url.pathname.endsWith("/control");
    let who: Identity | undefined;
    if (!control) {
      // Fail closed: a page with no identity from routeChat() is nobody.
      const h = req.headers;
      const userId = h.get(IDENTITY_HEADERS.user) ?? "";
      const owner = h.get(IDENTITY_HEADERS.owner) === "1";
      if (!owner && !isUserId(userId)) return new Response("forbidden", { status: 403 });
      who = { userId, email: h.get(IDENTITY_HEADERS.email) ?? "", owner };
    }
    const pair = new WebSocketPair();
    const ws = pair[1];
    this.ctx.acceptWebSocket(ws);
    if (control)
      await this.connectController(
        ws,
        url,
        req.headers.get(TOKEN_HEADER),
        req.headers.get(IP_HEADER) ?? undefined,
      );
    else await this.connectPage(ws, url, who);
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  /**
   * The owner's friends API — route it only from an owner-only path of your
   * own (routeChat never does):
   *   GET  /internal/friends                → {friends}
   *   GET  /internal/friends/thread?user=id → {messages}
   *   POST /internal/friends {userId, action: "block" | "unblock"}
   */
  private async friendsApi(req: Request, url: URL): Promise<Response> {
    if (req.method === "GET" && url.pathname.endsWith("/thread")) {
      const user = url.searchParams.get("user");
      if (!isUserId(user)) return Response.json({ error: "bad user" }, { status: 400 });
      return Response.json({ messages: await this.history(user) });
    }
    if (req.method === "GET") return Response.json({ friends: await this.friends() });
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    let body: { userId?: unknown; action?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: "bad json" }, { status: 400 });
    }
    if (!isUserId(body.userId) || (body.action !== "block" && body.action !== "unblock"))
      return Response.json({ error: "expected {userId, action: block|unblock}" }, { status: 400 });
    const rec = await this.block(body.userId, body.action === "block");
    if (!rec) return Response.json({ error: "no such chat user" }, { status: 404 });
    return Response.json({ ok: true, friend: { userId: body.userId, ...rec } });
  }

  /** Block (or unblock) a friend: blocking closes their pages and every pairing made for them. */
  async block(userId: string, blocked: boolean): Promise<FriendRecord | null> {
    const rec = await this.ctx.storage.get<FriendRecord>(friendKey(userId));
    if (!rec) return null;
    const next: FriendRecord = blocked
      ? { ...rec, blocked: true, blockedAt: this.now() }
      : { ...rec, blocked: false };
    await this.ctx.storage.put(friendKey(userId), next);
    log({ msg: blocked ? "chat.block" : "chat.unblock", userId });
    if (!blocked) return next;
    for (const p of this.pages(userId)) {
      send(p.ws, { type: "friend-status", status: "blocked" });
      close(p.ws, 4403, "blocked");
    }
    for (const c of this.sockets("controller"))
      if (c.a.forUser === userId) {
        send(c.ws, { type: "revoked" });
        close(c.ws, 4401, "revoke");
      }
    this.broadcast();
    return next;
  }

  /**
   * A page joins: it gets its own thread's history and its audience's state.
   * A blocked friend is told and closed. With no identity (tests) it is the owner's.
   */
  async connectPage(ws: Socket, url: URL, who?: Identity) {
    const label = cleanLabel(url.searchParams.get("label"), MAX_LABEL);
    // The tab's own id when it has one and no live page holds it (a
    // duplicated tab copies sessionStorage); else a fresh one.
    const asked = url.searchParams.get("page");
    const id =
      isPageId(asked) && !this.sockets("page", ws).some((p) => p.a.id === asked) ? asked : pageId();
    if (who && !who.owner) {
      if (!isUserId(who.userId)) return close(ws, 4403, "no identity");
      const rec = await this.ctx.storage.get<FriendRecord>(friendKey(who.userId));
      if (rec?.blocked) {
        send(ws, { type: "friend-status", status: "blocked" });
        return close(ws, 4403, "blocked");
      }
      if (this.pages(who.userId, ws).length >= FRIEND_MAX_PAGES) {
        send(ws, { type: "error", error: "too many open pages" });
        return close(ws, 4429, "too many pages");
      }
      ws.serializeAttachment({
        role: "page",
        id,
        label,
        at: this.now(),
        thread: who.userId,
        email: cleanLabel(who.email, 320),
      } satisfies PageAtt);
      send(ws, { type: "friend-status", status: "open" });
    } else
      ws.serializeAttachment({
        role: "page",
        id,
        label,
        at: this.now(),
        thread: OWNER_THREAD,
      } satisfies PageAtt);
    const a = att(ws) as PageAtt;
    // First page since the hub woke: list the sleeping eval grants too, once loaded.
    if (a.thread === OWNER_THREAD && !this.grants)
      void this.loadGrants().then(() => this.grants?.size && this.broadcast());
    void this.sweep();
    // Everyone else sees the new page in their list.
    this.broadcast(undefined, ws);
    send(ws, this.state(a.thread, undefined, a.id));
    send(ws, { type: "history", messages: await this.history(a.thread) });
  }

  /**
   * An agent knocks. `?for=<email>` asks a friend's pages for an eval pairing
   * (owner grant and an eval hub only). With just a grant token it is back
   * in chat scope at once. Otherwise it waits for the owner: one pending
   * pairing per audience, and only with a page to ask.
   */
  async connectController(ws: Socket, url: URL, token?: string | null, ip?: string) {
    const forKey = url.searchParams.get("for")?.trim();
    if (forKey) return this.pairForFriend(ws, url, forKey, token, ip);
    if (token) return this.resume(ws, url, token);
    const label = cleanLabel(url.searchParams.get("label"), 80) || "unnamed agent";
    const sc = url.searchParams.get("scope");
    const want: Scope | undefined = sc === "chat" || sc === "eval" ? sc : undefined;
    if (want === "eval" && !this.opts.eval) {
      send(ws, { type: "error", error: "eval is not enabled on this hub" });
      return close(ws, 4403, "no eval");
    }
    if (!this.clearPending(ws, OWNER_THREAD)) return;
    if (this.pages(OWNER_THREAD, ws).length === 0) {
      send(ws, { type: "error", error: "no owner page is open to approve this" });
      return close(ws, 4404, "no page");
    }
    if (!this.knockAllowed(ws, OWNER_THREAD, ip)) return;
    this.knock(ws, { label, ...(want ? { want } : {}), ...(ip ? { ip } : {}), ...whereOf(url) });
  }

  /** Make room for one audience's pairing: false (and `ws` closed) if one is still waiting. */
  private clearPending(ws: Socket, who: string) {
    const t = this.now();
    for (const c of this.sockets("controller", ws)) {
      if (c.a.until || audience(c.a) !== who) continue;
      if (t - c.a.at < PENDING_MS) {
        send(ws, { type: "error", error: "another pairing request is waiting for an answer" });
        close(ws, 4429, "pairing busy");
        return false;
      }
      send(c.ws, { type: "expired" });
      close(c.ws, 4408, "pairing expired");
    }
    return true;
  }

  private knock(
    ws: Socket,
    extra: {
      label: string;
      forUser?: string;
      forEmail?: string;
      want?: Scope;
      ip?: string;
      node?: string;
      assignee?: string;
    },
  ) {
    const a: ControllerAtt = {
      role: "controller",
      pair: crypto.randomUUID(),
      code: shortCode(crypto.getRandomValues(new Uint8Array(2))),
      at: this.now(),
      ...extra,
    };
    ws.serializeAttachment(a);
    send(ws, { type: "pending", code: a.code, expiresIn: PENDING_MS, for: a.forEmail });
    log({ msg: "chat.pair", pair: a.pair, code: a.code, label: a.label, for: a.forUser });
    this.broadcast();
  }

  /** The owner's live grant behind a token, or null (and a lapsed one deleted). */
  private async liveGrant(token: string) {
    const hash = await hashToken(token.slice(0, 256));
    const g = await this.ctx.storage.get<Grant>(`grant:${hash}`);
    if (g && g.until > this.now()) return { hash, g };
    if (g) await this.dropGrant(hash);
    return null;
  }

  /** An eval pairing on one friend's pages: the owner's agent asks, the friend answers. */
  private async pairForFriend(
    ws: Socket,
    url: URL,
    key: string,
    token?: string | null,
    ip?: string,
  ) {
    if (!this.opts.eval) {
      send(ws, { type: "error", error: "eval is not enabled on this hub" });
      return close(ws, 4403, "no eval");
    }
    const live = token ? await this.liveGrant(token) : null;
    if (!live) {
      send(ws, { type: "error", error: "pairing with a friend needs the owner's chat grant" });
      return close(ws, 4498, "grant invalid");
    }
    const f = await this.findFriend(key);
    if (!f || f.blocked) {
      send(ws, { type: "error", error: `no chat user ${key} (or blocked)` });
      return close(ws, 4404, "no such friend");
    }
    if (!this.clearPending(ws, f.userId)) return;
    if (this.pages(f.userId, ws).length === 0) {
      send(ws, { type: "error", error: `no page of ${f.email} is open` });
      return close(ws, 4404, "no page");
    }
    if (!this.knockAllowed(ws, f.userId, ip)) return;
    this.knock(ws, {
      label: cleanLabel(url.searchParams.get("label"), 80) || live.g.label,
      forUser: f.userId,
      forEmail: f.email,
      want: "eval",
      ...(ip ? { ip } : {}),
    });
  }

  /** Reconnecting with a grant token: chat scope again, no prompt — or 4498 if it is not live. */
  private async resume(ws: Socket, url: URL, token: string) {
    const live = await this.liveGrant(token);
    if (!live) {
      send(ws, { type: "error", error: "grant is not valid (expired or ended)" });
      return close(ws, 4498, "grant invalid");
    }
    const { hash, g } = live;
    // Its scope and pages again, with no prompt, even with no page open. An
    // eval grant on a hub that no longer allows eval comes back as chat.
    const scope: Scope = g.scope === "eval" && this.opts.eval ? "eval" : "chat";
    const pages = scope === "eval" ? (g.pages ?? "all") : "all";
    const a: ControllerAtt = {
      role: "controller",
      pair: crypto.randomUUID(),
      code: shortCode(crypto.getRandomValues(new Uint8Array(2))),
      label: cleanLabel(url.searchParams.get("label"), 80) || g.label,
      at: this.now(),
      until: g.until,
      scope,
      grant: hash,
      pages,
      ...whereOf(url),
    };
    ws.serializeAttachment(a);
    send(ws, { type: "approved", until: g.until, scope, pages, resumed: true });
    send(ws, { type: "history", messages: forNode(await this.history(), a.node) });
    log({ msg: "chat.resume", pair: a.pair, label: a.label, scope });
    this.broadcast();
  }

  webSocketMessage(ws: Socket, raw: string | ArrayBuffer): void | Promise<void> {
    void this.sweep();
    const a = att(ws);
    if (a?.role === "page") return this.fromPage(ws, a, raw);
    if (a?.role === "controller") return this.fromController(ws, a, raw);
  }

  private fromPage(ws: Socket, page: PageAtt, raw: unknown): void | Promise<void> {
    const m = parsePageMessage(raw);
    if (!m) return;
    const t = this.now();
    if (m.type === "chat") {
      log({
        msg: "chat.owner",
        page: page.label,
        thread: page.thread,
        len: m.text.length,
        ...this.head(m.text),
      });
      if (page.thread !== OWNER_THREAD) return this.friendChat(ws, page, m.id, m.text);
      return this.post({
        id: m.id,
        from: "owner",
        label: page.label,
        text: m.text,
        at: t,
        thread: OWNER_THREAD,
        ...(m.to ? { to: m.to } : {}),
        ...(m.source ? { source: m.source } : {}),
      });
    }
    if (m.type === "page") return this.relabel(ws, page, m.label);
    if (m.type === "end-page") {
      const target = this.pages(page.thread).find((p) => p.a.id === m.id);
      if (!target) return send(ws, this.state(page.thread, undefined, page.id));
      log({ msg: "chat.end-page", id: m.id, label: target.a.label });
      close(target.ws, 4410, "page ended");
      return this.pageClosed(target.ws, target.a);
    }
    // A sleeping eval grant (listed to the user's pages only): End it, or add a page.
    if ((m.type === "revoke" || m.type === "allow") && m.pair.startsWith(DORMANT)) {
      if (page.thread !== OWNER_THREAD)
        return send(ws, this.state(page.thread, undefined, page.id));
      return this.dormant(ws, page, m);
    }
    // Only a pairing made for this page's own audience can be answered or sent results.
    const c = this.controller(m.type === "result" ? m.to : m.pair);
    const mine = () => send(ws, this.state(page.thread, undefined, page.id));
    if (!c || audience(c.a) !== page.thread) return mine();
    if (m.type === "allow") {
      const pages = this.choosePages(page, m.pages);
      // Approved already: Allow from another page adds the pages to its grant.
      if (c.a.until) return c.a.until > t ? this.addPages(c.ws, c.a, pages) : mine();
      if (t - c.a.at >= PENDING_MS) return mine();
      // A friend's answer is always eval on their own pages, never a chat grant.
      if (c.a.forUser) return this.allowHour(c.ws, c.a, pages);
      const chat = c.a.want ? c.a.want === "chat" : m.scope === "chat";
      // Chat is low-risk and must survive app switches: always every page.
      return chat ? this.allowChat(c.ws, c.a, "all") : this.allowHour(c.ws, c.a, pages);
    }
    if (m.type === "deny" || m.type === "revoke") return this.end(m.type, c.ws, c.a);
    // A result goes back only to an approved agent that is still in time.
    if (m.type !== "result" || !c.a.until || c.a.until <= t) return;
    const { type: _t, to: _to, ...rest } = m;
    send(c.ws, { type: "result", ...rest, page: page.label });
  }

  /**
   * A friend's message: no approval needed, but a blocked friend is closed
   * and more than friendChatMax in a window is dropped (and the page told).
   * Their first ever message tells the agents ({type:"friend-new"}).
   */
  private async friendChat(ws: Socket, page: PageAtt, id: string, text: string) {
    const t = this.now();
    const userId = page.thread;
    const rec = await this.ctx.storage.get<FriendRecord>(friendKey(userId));
    if (rec?.blocked) {
      send(ws, { type: "friend-status", status: "blocked" });
      return close(ws, 4403, "blocked");
    }
    const rateKey = `rate:${userId}`;
    let rate = (await this.ctx.storage.get<Rate>(rateKey)) ?? { start: t, count: 0 };
    if (t - rate.start >= this.opts.friendWindowMs) rate = { start: t, count: 0 };
    if (rate.count >= this.opts.friendChatMax)
      return send(ws, {
        type: "rate-limited",
        id,
        retryIn: rate.start + this.opts.friendWindowMs - t,
      });
    await this.ctx.storage.put(rateKey, {
      start: rate.start,
      count: rate.count + 1,
    } satisfies Rate);
    const email = rec?.email || page.email || "";
    await this.ctx.storage.put(friendKey(userId), {
      ...(rec ?? { firstSeen: t }),
      email,
      lastAt: t,
      count: (rec?.count ?? 0) + 1,
    } satisfies FriendRecord);
    if (!rec) {
      log({ msg: "chat.friend-new", userId });
      for (const l of this.listeners()) send(l.ws, { type: "friend-new", userId, email, at: t });
    }
    return this.post({ id, from: "friend", label: page.label, text, at: t, thread: userId, email });
  }

  /** The pages an Allow names: live ones of the answering page's audience; by default that page. */
  private choosePages(page: PageAtt, asked?: string[] | "all"): string[] | "all" {
    if (asked === "all") return "all";
    const live = new Set(this.pages(page.thread).map((p) => p.a.id));
    const ids = (asked ?? []).filter((id) => live.has(id));
    return ids.length ? [...new Set(ids)] : [page.id];
  }

  /** Whether any live page of `thread` is covered by `pages`. */
  private anyCovered(thread: string, pages: string[] | "all" | undefined, except?: Socket) {
    if (pages === undefined || pages === "all") return true;
    return this.pages(thread, except).some((p) => covers(pages, p.a.id));
  }

  /** Add pages to an approved agent's grant: every socket of it, and the stored grant. */
  private async addPages(ws: Socket, a: ControllerAtt, more: string[] | "all") {
    const merged = (cur: string[] | "all" | undefined): string[] | "all" =>
      more === "all" || cur === undefined || cur === "all"
        ? "all"
        : [...new Set([...cur, ...more])];
    const pages = merged(a.pages);
    for (const o of this.sockets("controller"))
      if (o.ws === ws || (a.grant !== undefined && o.a.grant === a.grant)) {
        o.ws.serializeAttachment({ ...o.a, pages } satisfies ControllerAtt);
        send(o.ws, { type: "approved", until: o.a.until, scope: o.a.scope, pages, added: true });
      }
    if (a.grant) {
      const g = await this.ctx.storage.get<Grant>(`grant:${a.grant}`);
      if (g) await this.putGrant(a.grant, { ...g, pages } satisfies Grant);
    }
    log({ msg: "chat.add-pages", pair: a.pair, pages });
    this.broadcast();
  }

  /** A page reports client-side navigation: relabel it, update the lists, tell the agents. */
  private relabel(ws: Socket, page: PageAtt, raw: string) {
    const label = cleanLabel(raw, MAX_LABEL);
    if (!label || label === page.label) return;
    const t = this.now();
    // A friend cannot flood the agents with page-changed (the user's pages are trusted).
    const friend = page.thread !== OWNER_THREAD;
    if (friend && page.relabelAt !== undefined && t - page.relabelAt < FRIEND_RELABEL_MS) return;
    ws.serializeAttachment({
      ...page,
      label,
      ...(friend ? { relabelAt: t } : {}),
    } satisfies PageAtt);
    const ev = { type: "page-changed", label, thread: page.thread, at: t };
    for (const l of this.listeners()) send(l.ws, ev);
    for (const c of this.sockets("controller"))
      if (c.a.forUser === page.thread && c.a.until) send(c.ws, ev);
    this.broadcast();
  }

  /** A page went away: update the lists, and start the clock on grants it was the last page of. */
  private pageClosed(ws: Socket, _page: PageAtt): void | Promise<void> {
    const done = this.sweep(ws);
    this.broadcast(ws);
    return done;
  }

  /**
   * Grants whose pages are all closed: note when that began, forget it when
   * a page of theirs is back, and after PAGES_GONE_MS tell the agent to pair
   * again (4409) and drop the grant. Run on every event (no timers).
   */
  private sweep(except?: Socket): void {
    const t = this.now();
    for (const c of this.sockets("controller", except)) {
      const { pages } = c.a;
      if (!c.a.until || c.a.until <= t || pages === undefined || pages === "all") continue;
      if (this.anyCovered(audience(c.a), pages, except)) {
        if (c.a.goneSince)
          c.ws.serializeAttachment({ ...c.a, goneSince: undefined } satisfies ControllerAtt);
        continue;
      }
      if (!c.a.goneSince) {
        c.ws.serializeAttachment({ ...c.a, goneSince: t } satisfies ControllerAtt);
        continue;
      }
      if (t - c.a.goneSince < PAGES_GONE_MS) continue;
      send(c.ws, {
        type: "error",
        error: c.a.grant
          ? "the pages this agent was allowed on are gone: this socket closes, but the grant stays; reconnect with its token when a page is back"
          : "the pages this agent was allowed on are gone: pair again",
      });
      close(c.ws, 4409, "pages gone");
    }
  }

  /** End (revoke) a sleeping eval grant, or add the answering page to it. */
  private async dormant(
    ws: Socket,
    page: PageAtt,
    m: { type: string; pair: string; pages?: string[] | "all" },
  ) {
    await this.loadGrants();
    const prefix = m.pair.slice(DORMANT.length);
    const found =
      prefix.length === 40 ? [...(this.grants ?? [])].find(([h]) => h.startsWith(prefix)) : null;
    if (!found || found[1].scope !== "eval")
      return send(ws, this.state(page.thread, undefined, page.id));
    const [hash, g] = found;
    if (m.type === "revoke") {
      await this.dropGrant(hash);
      // Nothing should hold it (it was listed as asleep), but close any that does.
      for (const c of this.sockets("controller"))
        if (c.a.grant === hash) {
          send(c.ws, { type: "revoked" });
          close(c.ws, 4401, "revoke");
        }
      log({ msg: "chat.revoke", grant: "idle", label: g.label });
      return this.broadcast();
    }
    const more = this.choosePages(page, m.pages);
    const cur = g.pages ?? "all";
    const pages: string[] | "all" =
      more === "all" || cur === "all" ? "all" : [...new Set([...cur, ...more])];
    await this.putGrant(hash, { ...g, pages });
    log({ msg: "chat.add-pages", grant: "idle", pages });
    this.broadcast();
  }

  /**
   * Allow for code. The user's: eval and chat for EVAL_GRANT_MS, with a grant
   * token the agent resumes with (pages and all). A friend's preview: eval
   * only, for APPROVAL_MS, on this socket only — no token. On a hub without
   * eval, an older agent's "8h" answer is an hour of chat on this socket.
   */
  private async allowHour(ws: Socket, a: ControllerAtt, pages: string[] | "all") {
    const t = this.now();
    if (a.forUser || !this.opts.eval) {
      const until = t + APPROVAL_MS;
      const scope: Scope = this.opts.eval ? "eval" : "chat";
      ws.serializeAttachment({ ...a, until, scope, pages } satisfies ControllerAtt);
      send(ws, { type: "approved", until, scope, pages, for: a.forEmail });
      log({ msg: "chat.allow", pair: a.pair, label: a.label, until, scope, for: a.forUser });
      this.broadcast();
      // A pairing for a friend is eval only: it is handed no chat.
      if (a.forUser) return;
      return send(ws, { type: "history", messages: forNode(await this.history(), a.node) });
    }
    const until = t + EVAL_GRANT_MS;
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const grant = await hashToken(token);
    await this.putGrant(grant, {
      label: a.label,
      until,
      scope: "eval",
      pages,
      at: t,
    } satisfies Grant);
    ws.serializeAttachment({ ...a, until, scope: "eval", pages, grant } satisfies ControllerAtt);
    send(ws, { type: "approved", until, scope: "eval", pages, token });
    log({ msg: "chat.allow", pair: a.pair, label: a.label, until, scope: "eval" });
    this.broadcast();
    send(ws, { type: "history", messages: forNode(await this.history(), a.node) });
  }

  /** "Allow chat for 30 days": chat only, with a grant token the agent can resume with. */
  private async allowChat(ws: Socket, a: ControllerAtt, pages: string[] | "all") {
    const until = this.now() + CHAT_MS;
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const grant = await hashToken(token);
    await this.putGrant(grant, {
      label: a.label,
      until,
      pages,
      scope: "chat",
      at: this.now(),
    } satisfies Grant);
    ws.serializeAttachment({ ...a, until, scope: "chat", grant, pages } satisfies ControllerAtt);
    send(ws, { type: "approved", until, scope: "chat", pages, token });
    log({ msg: "chat.allow", pair: a.pair, label: a.label, until, scope: "chat" });
    this.broadcast();
    send(ws, { type: "history", messages: forNode(await this.history(), a.node) });
  }

  /** Deny a pairing, or End a session — and with it the grant behind it, on every socket using it. */
  private end(kind: "deny" | "revoke", ws: Socket, a: ControllerAtt): void | Promise<void> {
    if (kind === "deny") {
      // The cooldown is for the IP that knocked, not for everyone.
      const key = knockKey(audience(a), a.ip ?? "?");
      const t = this.now();
      this.setKnock(key, { ...(this.knocks.get(key) ?? { start: t, count: 0 }), deniedAt: t });
    }
    const targets = a.grant
      ? this.sockets("controller").filter((c) => c.a.grant === a.grant)
      : [{ ws, a }];
    for (const c of targets) {
      send(c.ws, { type: kind === "deny" ? "denied" : "revoked" });
      close(c.ws, kind === "deny" ? 4403 : 4401, kind);
    }
    log({ msg: `chat.${kind}`, pair: a.pair, label: a.label });
    if (!a.grant) return this.broadcast(ws);
    return this.dropGrant(a.grant).then(() => this.broadcast(ws));
  }

  /** Where an agent's `say` goes: the owner's thread, or a friend's by user id or email. */
  private async sayTarget(
    to?: string,
  ): Promise<{ thread: string; email?: string } | { error: string }> {
    if (!to || to === OWNER_THREAD) return { thread: OWNER_THREAD };
    const f = await this.findFriend(to);
    if (!f) return { error: `no chat thread for ${to}` };
    if (f.blocked) return { error: `${f.email} is blocked` };
    return { thread: f.userId, email: f.email };
  }

  /**
   * A node grant: senders within `from` may address nodes within `to`, for
   * `ms` (EVAL_GRANT_MS by default). Only an agent whose node holds both may
   * grant it or take it back; the root's always may.
   */
  private async nodeGrant(
    ws: Socket,
    c: ControllerAtt,
    m: { type: "grant" | "ungrant"; from: string; to: string; ms?: number },
  ) {
    const home = c.node ?? ROOT_NODE;
    if (!isWithin(m.from, home) || !isWithin(m.to, home)) {
      const reason = `out of scope: an agent at ${home} cannot grant ${m.from} → ${m.to}`;
      return send(ws, { type: "error", error: reason, reason });
    }
    const key = nodeGrantKey(m.from, m.to);
    if (m.type === "ungrant") {
      await this.ctx.storage.delete(key);
      log({ msg: "chat.node-ungrant", from: m.from, to: m.to });
      return send(ws, { type: "ungranted", from: m.from, to: m.to });
    }
    const until = this.now() + (m.ms ?? EVAL_GRANT_MS);
    await this.ctx.storage.put(key, { from: m.from, to: m.to, until } satisfies NodeGrant);
    log({ msg: "chat.node-grant", from: m.from, to: m.to, until, by: home });
    send(ws, { type: "granted", from: m.from, to: m.to, until });
  }

  private fromController(ws: Socket, c: ControllerAtt, raw: unknown): void | Promise<void> {
    const t = this.now();
    if (!c.until) return send(ws, { type: "error", error: "not approved yet" });
    if (c.until <= t) {
      send(ws, { type: "expired" });
      close(ws, 4408, "approval expired");
      return this.broadcast(ws);
    }
    const m = parseControllerMessage(raw);
    if (!m.ok) return send(ws, { type: "error", error: m.error });
    if (m.value.type === "busy") {
      // A relay, nothing kept: the pages time it out themselves. `on: false`
      // (older clients) has nothing to relay — the reply ends the spinner.
      if (c.forUser || m.value.on === false) return;
      return this.sayTarget(m.value.to).then((dest) => {
        if ("error" in dest) return send(ws, { type: "error", error: dest.error });
        const beat = { type: "busy", label: c.label, at: t };
        for (const p of this.pages(dest.thread))
          if (dest.thread !== OWNER_THREAD || covers(c.pages, p.a.id)) send(p.ws, beat);
      });
    }
    if (m.value.type === "grant" || m.value.type === "ungrant") {
      if (c.forUser)
        return send(ws, { type: "error", error: "a pairing for a friend cannot chat" });
      return this.nodeGrant(ws, c, m.value);
    }
    if (m.value.type === "edit") return this.edit(ws, c, m.value);
    if (m.value.type === "say") {
      if (c.forUser)
        return send(ws, { type: "error", error: "a pairing for a friend cannot chat" });
      const { text, to, node, agentId } = m.value;
      // The sender's node: what the line says, within the node its socket listens at.
      const home = c.node ?? ROOT_NODE;
      const from = m.value.taskPath ?? home;
      if (!isWithin(from, home)) {
        const reason = `taskPath ${from} is outside this agent's node ${home}`;
        return send(ws, { type: "error", error: reason, reason });
      }
      if (node && to) {
        const reason = "address a thread or a node, not both";
        return send(ws, { type: "error", error: reason, reason });
      }
      const scoped = node
        ? this.nodeGrants().then((grants) => mayAddress(from, node, grants, t))
        : Promise.resolve({ ok: true as const });
      return Promise.all([scoped, this.sayTarget(to)]).then(async ([scope, dest]) => {
        if (!scope.ok) return send(ws, { type: "error", error: scope.error, reason: scope.error });
        if ("error" in dest) return send(ws, { type: "error", error: dest.error });
        const who = agentId ?? c.assignee;
        const said: ChatMessage & { thread: string; email?: string } = {
          id: crypto.randomUUID().slice(0, 8),
          from: "agent",
          label: c.label,
          text,
          at: t,
          ...dest,
          ...(from !== ROOT_NODE ? { taskPath: from } : {}),
          ...(who ? { agentId: who } : {}),
          ...(node ? { to: node } : {}),
        };
        log({
          msg: "chat.say",
          pair: c.pair,
          agent: c.label,
          thread: said.thread,
          len: text.length,
          ...this.head(text),
        });
        // Live, the owner's thread hears it only on the grant's pages.
        await this.post(said, said.thread === OWNER_THREAD ? c.pages : undefined);
        send(ws, { type: "said", id: said.id, thread: said.thread });
      });
    }
    if (c.scope === "chat")
      return send(ws, { type: "error", error: "this session is chat-only: it cannot eval" });
    // Eval is off unless this hub was made with {eval: true} — checked here
    // too, for a socket approved before a deploy turned it off.
    if (!this.opts.eval)
      return send(ws, { type: "error", error: "eval is not enabled on this hub" });
    const id = crypto.randomUUID().slice(0, 8);
    const labels: string[] = [];
    // Only the pages of the grant, in the audience that approved it.
    for (const p of this.pages(audience(c))) {
      if (!covers(c.pages, p.a.id) || !matchesTarget(p.a.label, m.value.target)) continue;
      send(p.ws, { type: "eval", id, code: m.value.code, to: c.pair });
      labels.push(p.a.label);
    }
    log({
      msg: "chat.eval",
      id,
      pair: c.pair,
      agent: c.label,
      for: c.forUser,
      len: m.value.code.length,
      target: m.value.target,
      ...this.head(m.value.code, 200),
      delivered: labels.length,
    });
    send(ws, { type: "sent", id, delivered: labels.length, labels });
  }

  webSocketClose(ws: Socket, code: number): void | Promise<void> {
    close(ws, code === 1005 ? 1000 : code, "");
    const a = att(ws);
    if (a?.role === "controller") return this.broadcast(ws);
    if (a?.role === "page") return this.pageClosed(ws, a);
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * A ChatHub class with these options baked in, to export from your Worker as
 * the Durable Object: `export const ChatHub = chatHub({ eval: true })`.
 */
export function chatHub(opts: HubOptions = {}): typeof ChatHub {
  return class extends ChatHub {
    constructor(ctx: DOState, env?: unknown) {
      super(ctx, env, Date.now, opts);
    }
  };
}

type Stub = { fetch(req: Request): Promise<Response> };
type Namespace = { idFromName(name: string): unknown; get(id: unknown): Stub };

export type RouteOptions = {
  /** Who this page request is, from the site's own session; null refuses it. */
  identify: (req: Request) => Promise<Identity | null> | Identity | null;
  /** The page socket's path. Default /api/chat. */
  pagePath?: string;
  /** The agent socket's path. Default <pagePath>/control. */
  controlPath?: string;
  /** The Durable Object's name in the namespace (one hub per name). Default "chat". */
  name?: string;
  /**
   * Origins, besides the request's own, whose pages may open the page socket
   * (e.g. ["https://app.example.com"] when the hub is on api.example.com).
   * Any other Origin is refused before `identify` runs, so a site the user
   * visits cannot ride their cookie into the chat (cross-site WebSocket
   * hijacking). Exact match: scheme, host and port.
   */
  allowedOrigins?: string[];
};

/**
 * Whether a page socket's Origin may connect: the request's own origin, or
 * one listed in `allowed`. A request with no Origin is not from a browser
 * page (browsers always send one on a WebSocket), so it can only use
 * credentials it already holds: it goes on to `identify` like any other.
 */
export function pageOriginAllowed(req: Request, allowed: readonly string[] = []): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  return origin === new URL(req.url).origin || allowed.includes(origin);
}

/**
 * Route a request to the hub if it is one of its two sockets; null otherwise
 * (so the site's own routes go on). Pages are identified by the site and
 * their identity is passed in IDENTITY_HEADERS (any the client sent are
 * dropped). A page socket from a foreign Origin is refused (see
 * `allowedOrigins`); an agent socket is refused if it carries any Origin
 * (a web page).
 */
export async function routeChat(
  req: Request,
  ns: Namespace,
  opts: RouteOptions,
): Promise<Response | null> {
  const url = new URL(req.url);
  const pagePath = opts.pagePath ?? "/api/chat";
  const controlPath = opts.controlPath ?? `${pagePath}/control`;
  if (url.pathname !== pagePath && url.pathname !== controlPath) return null;
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return new Response("WebSocket only", { status: 426 });
  const headers = new Headers(req.headers);
  for (const h of Object.values(IDENTITY_HEADERS)) headers.delete(h);
  headers.delete(IP_HEADER);
  const hub = ns.get(ns.idFromName(opts.name ?? "chat"));
  // The DO tells the two apart by the path's ending.
  const inner = new URL(url);
  if (url.pathname === controlPath) {
    if (req.headers.get("origin")) return new Response("forbidden", { status: 403 });
    // Cloudflare's own header (a client cannot set it through Cloudflare),
    // for the per-IP pairing limits.
    const ip = req.headers.get("cf-connecting-ip");
    if (ip) headers.set(IP_HEADER, ip.slice(0, 64));
    inner.pathname = "/control";
    return hub.fetch(new Request(inner, { headers }));
  }
  // Before identify reads the cookie: a foreign site's page is nobody.
  if (!pageOriginAllowed(req, opts.allowedOrigins))
    return new Response("forbidden origin", { status: 403 });
  let who: Identity | null = null;
  try {
    who = await opts.identify(req);
  } catch {
    who = null;
  }
  if (!who || (!who.owner && !isUserId(who.userId)))
    return new Response("forbidden", { status: 403 });
  headers.set(IDENTITY_HEADERS.user, who.owner ? OWNER_THREAD : who.userId);
  headers.set(IDENTITY_HEADERS.email, who.email ?? "");
  headers.set(IDENTITY_HEADERS.owner, who.owner ? "1" : "0");
  inner.pathname = "/page";
  return hub.fetch(new Request(inner, { headers }));
}
