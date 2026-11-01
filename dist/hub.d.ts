import { ChatMessage } from "./protocol.js";

//#region src/progress-hub.d.ts
/** Durable Object storage as the progress hub uses it: the key-value API and the alarm. */
type ProgressStorage = Storage & {
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
};
type ProgressState = {
  acceptWebSocket(ws: Socket): void;
  getWebSockets(): Socket[];
  storage: ProgressStorage;
};
/**
 * Set to "1" by routeProgress() once the host's `reader(req)` said yes; any a
 * client sent is dropped first. A host that routes to the hub itself must do
 * the same.
 */
declare const PROGRESS_READER_HEADER = "x-liagent-progress-reader";
/** Writes allowed per window: per name, and for everyone together. */
declare const RATE: {
  readonly windowMs: 60000;
  readonly perName: 30;
  readonly total: 120;
};
/** A report is a few hundred bytes; anything much bigger is not one. */
declare const MAX_BODY = 4096;
/** The longest a minted token lives. */
declare const GRANT_MAX_MS: number;
declare const GRANT_DEFAULT = "8h";
/** The note a check-off writes. */
declare const RESOLVED_NOTE = "resolved by owner";
/**
 * The checks routeProgress() makes before a token route reaches the hub. null = go
 * on; otherwise the response. 403 from a browser (pages never use tokens),
 * 503 while the secret is unset (so a writer sees why), 401 with no bearer.
 */
declare function progressGate(req: Request, secret: string | undefined): Response | null;
type ProgressHubOptions = {
  /** The env binding that holds the root secret. Default "PROGRESS_TOKEN". */secretVar?: string;
};
declare class ProgressHub {
  private ctx;
  private now;
  private windows;
  private seq;
  private secret;
  /**
   * `env[secretVar]` (default PROGRESS_TOKEN) is the root secret: unset, every
   * token route answers 401 (routeProgress answers 503 first).
   */
  constructor(ctx: ProgressState, env?: unknown, now?: () => number, opts?: ProgressHubOptions);
  fetch(req: Request): Promise<Response>;
  private body;
  private all;
  /** The tree (newest first) and the log (oldest first). */
  private state;
  sendSnapshot(to?: Socket[]): Promise<void>;
  private send;
  /** Counts one write; false = over the limit. */
  private allow;
  private tooMany;
  /**
   * Is `id` inside the subtree of `node`? Walks parents: a path's directory,
   * otherwise the stored `parent` (`override` stands in for one node's).
   */
  private covers;
  /** Would `parent` (through its own ancestors) lead back to `id`? */
  private loops;
  /** May this token write this report? A message for the 403, or null. */
  private refuse;
  private write;
  /** Put nodes, making room past PROGRESS_MAX_ENTRIES; true if any were dropped. */
  private store;
  /** Append one event, dropping the oldest past PROGRESS_LOG_MAX. */
  private append;
  /**
   * The owner checks off a node: done, `needs` cleared, the answer noted. An
   * owner to-do also resolves the decision or approval it refs.
   */
  resolve(id: string, note?: string): Promise<Response>;
  /** Mint a token for `node` (inside the asking token's scope), signed with the root. */
  private grant;
  /** Make sure the alarm goes off by `at` (one already due is the one running now). */
  private schedule;
  /** The Durable Object alarm: prune done nodes past their TTL and empty auto groups, then wait for the next. */
  alarm(): Promise<void>;
  /** The owner's page checks off a node: {type:"resolve", id, note?}. Nothing else is heard. */
  webSocketMessage(_ws: Socket, raw: string | ArrayBuffer): Promise<void>;
  webSocketClose(ws: Socket, code: number): void;
  webSocketError(ws: Socket): void;
}
/**
 * A ProgressHub class with these options baked in, to export from your Worker
 * as the Durable Object: `export const ProgressHub = progressHub()`.
 */
declare function progressHub(opts?: ProgressHubOptions): typeof ProgressHub;
type Stub$1 = {
  fetch(req: Request): Promise<Response>;
};
type Namespace$1 = {
  idFromName(name: string): unknown;
  get(id: unknown): Stub$1;
};
type ProgressRouteOptions = {
  /** The hub's root secret (the same the Durable Object reads); unset answers 503 to writers. */secret: string | undefined;
  /**
   * May this WebSocket request read the tree (and check nodes off)? The host's
   * own session check — typically "is this the owner". Only called for a
   * socket from an allowed Origin; a throw counts as no.
   */
  reader: (req: Request) => Promise<boolean> | boolean; /** The path (writers POST here and to /grant, /resolve below it; readers open a socket). Default /api/progress. */
  path?: string; /** The Durable Object's name in the namespace. Default "progress". */
  name?: string; /** Origins, besides the request's own, whose pages may open the reader socket (exact match). */
  allowedOrigins?: string[];
};
/**
 * Route a request to the progress hub if it is under `path`; null otherwise
 * (so the site's own routes go on). A WebSocket is a reader: from an allowed
 * Origin and only if `reader(req)` says so, marked with
 * PROGRESS_READER_HEADER. Anything else is a writer (progressGate: no
 * Origin, a secret set, a bearer token), forwarded without that header.
 */
declare function routeProgress(req: Request, ns: Namespace$1, opts: ProgressRouteOptions): Promise<Response | null>;
//#endregion
//#region src/hub.d.ts
/** The owner's chat thread; every other thread is a friend's user id. */
declare const OWNER_THREAD = "owner";
/** Who a page belongs to, as the site says (routeChat's `identify`). */
type Identity = {
  userId: string;
  email: string;
  owner: boolean;
};
/** A user id usable as a thread and a storage key: no separators, bounded. */
declare const isUserId: (v: unknown) => v is string;
/** A friend who has used the chat (`friend:<userId>`). */
type FriendRecord = {
  email: string;
  firstSeen: number;
  lastAt: number;
  count: number;
  blocked?: boolean;
  blockedAt?: number;
};
type HubOptions = {
  /** Let an eval approval run code on the approved pages (8 hours). Default false. */eval?: boolean; /** Messages a friend may send per window. Default 30. */
  friendChatMax?: number; /** That window. Default 10 minutes. */
  friendWindowMs?: number;
  /**
   * Put the start of each message (80 chars) and of eval code (200) in the
   * Worker logs. Default false: logs keep only lengths, since they hold what
   * the user and their friends wrote.
   */
  logContent?: boolean;
};
type Socket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState?: number;
  serializeAttachment(v: unknown): void;
  deserializeAttachment(): unknown;
};
type Storage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(opts: {
    prefix: string;
    reverse?: boolean;
    limit?: number;
  }): Promise<Map<string, T>>;
};
type DOState = {
  acceptWebSocket(ws: Socket): void;
  getWebSockets(): Socket[];
  storage: Storage; /** Cloudflare's: holds every event until `fn` is done (used to load state on wake). */
  blockConcurrencyWhile?<T>(fn: () => Promise<T>): Promise<T>;
};
/** Who a page is: set by routeChat() from the site's answer, never by the page. */
declare const IDENTITY_HEADERS: {
  readonly user: "x-liagent-user";
  readonly email: "x-liagent-email";
  readonly owner: "x-liagent-owner";
};
/** The agent's client IP, set by routeChat from cf-connecting-ip (never by the client). */
declare const IP_HEADER = "x-liagent-ip";
/** The header an agent resumes its chat grant with. */
declare const TOKEN_HEADER = "x-liagent-token";
declare const hashToken: (token: string) => Promise<string>;
/** After the user denies a pairing, that audience takes no new request for this long. */
declare const PAIR_COOLDOWN_MS = 60000;
/**
 * At most PAIR_MAX pairing requests per audience and client IP per
 * PAIR_WINDOW_MS, and PAIR_AUDIENCE_MAX per audience from all IPs together
 * (which bounds the prompts the user sees). Keyed by IP too, so a stranger
 * using up their own quota cannot lock the user's agent out. A request waits
 * up to PENDING_MS (2 min), so the window must be longer than PAIR_MAX of
 * those, or re-knocking as each lapses would never hit the cap.
 */
declare const PAIR_MAX = 3;
declare const PAIR_AUDIENCE_MAX = 10;
declare const PAIR_WINDOW_MS: number;
/** A friend's page may relabel at most once per this long; faster ones are dropped. */
declare const FRIEND_RELABEL_MS = 1000;
/** A friend may hold at most this many page sockets at once. */
declare const FRIEND_MAX_PAGES = 8;
declare class ChatHub {
  private ctx;
  private now;
  protected opts: Required<HubOptions>;
  /** `{head}` for a log line, only when the hub logs content. */
  private head;
  constructor(ctx: DOState, _env?: unknown, now?: () => number, opts?: HubOptions);
  /**
   * Every stored grant by hash: read once per instance (an evicted hub reads
   * it again), then kept in step with each write. Only the listing of
   * sleeping eval grants uses it; a resume always asks storage itself.
   */
  private grants?;
  /**
   * Pairing requests per (audience, IP) and per audience, to bound the
   * prompts anyone can raise: the window's start and count, and when the
   * user last denied one. Read synchronously from this map, written through
   * to storage (`knock:<key>`), and loaded back when a hub wakes from
   * hibernation (under blockConcurrencyWhile, before any event), so an
   * evicted hub does not forget them. Where the host has no
   * blockConcurrencyWhile they are kept in memory only.
   */
  private knocks;
  private setKnock;
  /** Load the stored counters; drop those whose window and cooldown have both passed. */
  private loadKnocks;
  /**
   * Room for one more pairing request for audience `who` from client `ip`:
   * false (and `ws` closed with 4429) if not. Per (audience, IP): a
   * cooldown after the user denied that IP's request, and PAIR_MAX per
   * window. Per audience: PAIR_AUDIENCE_MAX per window from all IPs. Without
   * an IP (a hub not behind routeChat on Cloudflare), every request shares
   * one key.
   */
  private knockAllowed;
  private loadingGrants?;
  private loadGrants;
  private putGrant;
  private dropGrant;
  /** Open sockets of one role, optionally leaving one out (the one closing). */
  private sockets;
  private pages;
  /**
   * Owner-approved agents still in time. They hear every thread and may `say`
   * to any. A pairing made for a friend is not one.
   */
  private listeners;
  /** What one audience's pages see: its pairings, how many agents listen, its pages. */
  private state;
  /** Send every page its audience's state; `skip` is left out of the sending only. */
  private broadcast;
  private controller;
  /** One thread's kept chat, oldest first. */
  history(thread?: string): Promise<ChatMessage[]>;
  /**
   * Keep one message (dropping its thread's oldest past CHAT_HISTORY) and send
   * it on. An agent's reply in the owner's thread goes live only to the pages
   * of its grant (`only`); every page still gets it in its history.
   */
  private post;
  /**
   * The agent polishes the owner's latest voice line (see "Voice edits"
   * above). Every refusal is an {type:"error"} naming the rule it broke.
   */
  private edit;
  /** The live node grants (`ngrant:`), lapsed ones dropped as they are met. */
  private nodeGrants;
  /** Everyone who has used the chat, most recent first. */
  friends(): Promise<({
    userId: string;
  } & FriendRecord)[]>;
  /** A friend by user id or (any case) email. */
  private findFriend;
  fetch(req: Request): Promise<Response>;
  /**
   * The owner's friends API — route it only from an owner-only path of your
   * own (routeChat never does):
   *   GET  /internal/friends                → {friends}
   *   GET  /internal/friends/thread?user=id → {messages}
   *   POST /internal/friends {userId, action: "block" | "unblock"}
   */
  private friendsApi;
  /** Block (or unblock) a friend: blocking closes their pages and every pairing made for them. */
  block(userId: string, blocked: boolean): Promise<FriendRecord | null>;
  /**
   * A page joins: it gets its own thread's history and its audience's state.
   * A blocked friend is told and closed. With no identity (tests) it is the owner's.
   */
  connectPage(ws: Socket, url: URL, who?: Identity): Promise<void>;
  /**
   * An agent knocks. `?for=<email>` asks a friend's pages for an eval pairing
   * (owner grant and an eval hub only). With just a grant token it is back
   * in chat scope at once. Otherwise it waits for the owner: one pending
   * pairing per audience, and only with a page to ask.
   */
  connectController(ws: Socket, url: URL, token?: string | null, ip?: string): Promise<void>;
  /** Make room for one audience's pairing: false (and `ws` closed) if one is still waiting. */
  private clearPending;
  private knock;
  /** The owner's live grant behind a token, or null (and a lapsed one deleted). */
  private liveGrant;
  /** An eval pairing on one friend's pages: the owner's agent asks, the friend answers. */
  private pairForFriend;
  /** Reconnecting with a grant token: chat scope again, no prompt — or 4498 if it is not live. */
  private resume;
  webSocketMessage(ws: Socket, raw: string | ArrayBuffer): void | Promise<void>;
  private fromPage;
  /**
   * A friend's message: no approval needed, but a blocked friend is closed
   * and more than friendChatMax in a window is dropped (and the page told).
   * Their first ever message tells the agents ({type:"friend-new"}).
   */
  private friendChat;
  /** The pages an Allow names: live ones of the answering page's audience; by default that page. */
  private choosePages;
  /** Whether any live page of `thread` is covered by `pages`. */
  private anyCovered;
  /** Add pages to an approved agent's grant: every socket of it, and the stored grant. */
  private addPages;
  /** A page reports client-side navigation: relabel it, update the lists, tell the agents. */
  private relabel;
  /** A page went away: update the lists, and start the clock on grants it was the last page of. */
  private pageClosed;
  /**
   * Grants whose pages are all closed: note when that began, forget it when
   * a page of theirs is back, and after PAGES_GONE_MS tell the agent to pair
   * again (4409) and drop the grant. Run on every event (no timers).
   */
  private sweep;
  /** End (revoke) a sleeping eval grant, or add the answering page to it. */
  private dormant;
  /**
   * Allow for code. The user's: eval and chat for EVAL_GRANT_MS, with a grant
   * token the agent resumes with (pages and all). A friend's preview: eval
   * only, for APPROVAL_MS, on this socket only — no token. On a hub without
   * eval, an older agent's "8h" answer is an hour of chat on this socket.
   */
  private allowHour;
  /** "Allow chat for 30 days": chat only, with a grant token the agent can resume with. */
  private allowChat;
  /** Deny a pairing, or End a session — and with it the grant behind it, on every socket using it. */
  private end;
  /** Where an agent's `say` goes: the owner's thread, or a friend's by user id or email. */
  private sayTarget;
  /**
   * A node grant: senders within `from` may address nodes within `to`, for
   * `ms` (EVAL_GRANT_MS by default). Only an agent whose node holds both may
   * grant it or take it back; the root's always may.
   */
  private nodeGrant;
  private fromController;
  webSocketClose(ws: Socket, code: number): void | Promise<void>;
}
/**
 * A ChatHub class with these options baked in, to export from your Worker as
 * the Durable Object: `export const ChatHub = chatHub({ eval: true })`.
 */
declare function chatHub(opts?: HubOptions): typeof ChatHub;
type Stub = {
  fetch(req: Request): Promise<Response>;
};
type Namespace = {
  idFromName(name: string): unknown;
  get(id: unknown): Stub;
};
type RouteOptions = {
  /** Who this page request is, from the site's own session; null refuses it. */identify: (req: Request) => Promise<Identity | null> | Identity | null; /** The page socket's path. Default /api/chat. */
  pagePath?: string; /** The agent socket's path. Default <pagePath>/control. */
  controlPath?: string; /** The Durable Object's name in the namespace (one hub per name). Default "chat". */
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
declare function pageOriginAllowed(req: Request, allowed?: readonly string[]): boolean;
/**
 * Route a request to the hub if it is one of its two sockets; null otherwise
 * (so the site's own routes go on). Pages are identified by the site and
 * their identity is passed in IDENTITY_HEADERS (any the client sent are
 * dropped). A page socket from a foreign Origin is refused (see
 * `allowedOrigins`); an agent socket is refused if it carries any Origin
 * (a web page).
 */
declare function routeChat(req: Request, ns: Namespace, opts: RouteOptions): Promise<Response | null>;
//#endregion
export { ChatHub, DOState, FRIEND_MAX_PAGES, FRIEND_RELABEL_MS, FriendRecord, GRANT_DEFAULT, GRANT_MAX_MS, HubOptions, IDENTITY_HEADERS, IP_HEADER, Identity, MAX_BODY, OWNER_THREAD, PAIR_AUDIENCE_MAX, PAIR_COOLDOWN_MS, PAIR_MAX, PAIR_WINDOW_MS, PROGRESS_READER_HEADER, ProgressHub, ProgressHubOptions, ProgressRouteOptions, ProgressState, ProgressStorage, RATE, RESOLVED_NOTE, RouteOptions, Socket, Storage, TOKEN_HEADER, chatHub, hashToken, isUserId, pageOriginAllowed, progressGate, progressHub, routeChat, routeProgress };
//# sourceMappingURL=hub.d.ts.map