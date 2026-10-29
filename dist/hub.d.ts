import { ChatMessage } from "./protocol.js";

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
  storage: Storage;
};
/** Who a page is: set by routeChat() from the site's answer, never by the page. */
declare const IDENTITY_HEADERS: {
  readonly user: "x-liagent-user";
  readonly email: "x-liagent-email";
  readonly owner: "x-liagent-owner";
};
/** The header an agent resumes its chat grant with. */
declare const TOKEN_HEADER = "x-liagent-token";
declare const hashToken: (token: string) => Promise<string>;
/** After the user denies a pairing, that audience takes no new request for this long. */
declare const PAIR_COOLDOWN_MS = 60000;
/**
 * At most PAIR_MAX pairing requests per audience per PAIR_WINDOW_MS. A
 * request waits up to PENDING_MS (2 min), so the window must be longer than
 * PAIR_MAX of those, or re-knocking as each lapses would never hit the cap.
 */
declare const PAIR_MAX = 3;
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
   * Pairing requests per audience, to bound the prompts anyone can raise:
   * the window's start and count, and when the user last denied one. Kept in
   * memory (a hub woken from hibernation starts afresh): it only has to stop
   * a stream of prompts, and the knock stays synchronous.
   */
  private knocks;
  /** Room for one more pairing request for `who`: false (and `ws` closed with 4429) if not. */
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
  connectController(ws: Socket, url: URL, token?: string | null): Promise<void>;
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
export { ChatHub, DOState, FRIEND_MAX_PAGES, FRIEND_RELABEL_MS, FriendRecord, HubOptions, IDENTITY_HEADERS, Identity, OWNER_THREAD, PAIR_COOLDOWN_MS, PAIR_MAX, PAIR_WINDOW_MS, RouteOptions, Socket, Storage, TOKEN_HEADER, chatHub, hashToken, isUserId, pageOriginAllowed, routeChat };
//# sourceMappingURL=hub.d.ts.map