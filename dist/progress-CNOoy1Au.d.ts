//#region src/progress-token.d.ts
/**
 * Progress write scopes. The hub's secret itself is the root grant. A
 * scoped token is
 *
 *   base64url(JSON {node, agent, exp, via?}) + "." + base64url(HMAC-SHA256(secret, that payload))
 *
 * and lets `agent` write `node` and its descendants until `exp`. Only the
 * hub holds the root, so only the hub mints (a scoped token delegates by
 * asking it: POST <progress path>/grant). Web Crypto only, so a Worker and
 * Bun share it. Stateless: nothing is stored per token.
 */
type ProgressGrant = {
  node: string;
  agent: string; /** Expiry, ms since the epoch. */
  exp: number; /** The node of the token that asked for this one ("root" for the root token). */
  via?: string;
};
type ProgressAuth = {
  root: true;
} | ({
  root: false;
} & ProgressGrant);
/** A scoped token for `grant`, signed with the root secret. */
declare function mintProgressToken(secret: string, grant: ProgressGrant): Promise<string>;
/**
 * Who a bearer token is: the root, a live scoped grant, or null (wrong
 * signature, malformed, or expired).
 */
declare function verifyProgressToken(secret: string, token: string, now?: number): Promise<ProgressAuth | null>;
//#endregion
//#region src/progress.d.ts
declare const PROGRESS_STATUSES: readonly ["doing", "blocked", "waiting", "waiting-owner", "review", "done"];
type ProgressStatus = (typeof PROGRESS_STATUSES)[number];
/**
 * "decision" / "approval": pending decisions and authorisations (a repo, a
 * merge, a grant, a secret). "feedback": work that came from a user's or the
 * owner's feedback (a bug report). "person": a human's own node. "group": a
 * plain grouping node, auto-created for a path's missing ancestors.
 */
declare const PROGRESS_KINDS: readonly ["task", "decision", "approval", "feedback", "person", "group"];
type ProgressKind = (typeof PROGRESS_KINDS)[number];
declare const ASSIGNEE_TYPES: readonly ["agent", "human"];
type ProgressAssignee = {
  type: (typeof ASSIGNEE_TYPES)[number];
  name: string;
};
declare const PROGRESS_LIMITS: {
  readonly name: 40;
  readonly task: 120;
  readonly note: 280;
  readonly eta: 40;
  readonly needs: 120;
  readonly id: 120;
  readonly parent: 120;
  readonly ref: 120;
  readonly action: 300;
  readonly link: 300;
};
/** Nodes the hub keeps at most; past it the oldest done ones go first. */
declare const PROGRESS_MAX_ENTRIES = 200;
/** Events the hub's append-only log keeps (the newest). */
declare const PROGRESS_LOG_MAX = 200;
/** Notes kept per node (the newest); a note appends, never overwrites. */
declare const PROGRESS_NOTES_MAX = 20;
/** A done node is pruned this long after its last write. */
declare const PROGRESS_DONE_TTL_MS: number;
/** The creator of an auto-created node: the first real write claims it. */
declare const PROGRESS_AUTO = "_auto";
/**
 * The owner, as a node (kind "person", a human assignee). His to-do items
 * are its children, each with a `ref` to the node it unblocks. The data holds
 * only this id and the name OWNER_NAME (a host may show its own name for it).
 */
declare const OWNER_NODE = "/@owner";
declare const OWNER_ASSIGNEE: ProgressAssignee;
declare const isOwnerTodo: (id: string) => boolean;
/**
 * What a writer posts. `id` is stable (default: a slug of assignee and
 * task); `parent` another node's id (derived for a path id); `assignee` is
 * who works on it (`agent: "<name>"` is the alias for an agent assignee) and
 * also names the writer; `needs` is what the owner must do ("" clears it);
 * `ref` (an owner to-do) the node it unblocks; `action` the exact command or
 * URL that does it; `note` is appended to the node's notes; `rev`, if given,
 * must be above the node's current rev (else 409).
 */
type ProgressReport = {
  id: string;
  parent?: string;
  assignee: ProgressAssignee;
  task: string;
  status: ProgressStatus;
  kind?: ProgressKind;
  pct?: number;
  eta?: string;
  pr?: number;
  needs?: string;
  ref?: string;
  action?: string; /** A page about it (a PR, a preview): https only. */
  link?: string;
  note?: string;
  rev?: number;
};
type ProgressNote = {
  at: number;
  by: string;
  text: string;
};
/**
 * A node as the hub keeps it. `creator` wrote it first (and so may change
 * its status, pct and eta), `by` wrote it last, `rev` is its revision,
 * `created` / `at` when it was first / last written.
 */
type ProgressEntry = Omit<ProgressReport, "note" | "rev" | "kind"> & {
  kind: ProgressKind;
  creator: string;
  by: string;
  rev: number;
  created: number;
  at: number;
  notes?: ProgressNote[];
};
/** One write as broadcast and logged: the node after it (without its notes) and the note it added. */
type ProgressEvent = {
  type: "progress";
  note?: string;
} & Omit<ProgressEntry, "notes">;
/**
 * What the hub sends a reader: the state and the log on connect (and after a
 * prune or an eviction), then each event as it happens.
 */
type ProgressMessage = {
  type: "snapshot";
  entries: ProgressEntry[];
  log: ProgressEvent[];
} | ProgressEvent;
declare const isProgressId: (id: unknown) => id is string;
declare const isPathId: (id: string) => boolean;
/** A path id's parent: its directory ("/words/prefetch" → "/words"; "/words" → none). */
declare const pathParent: (id: string) => string | undefined;
/** "/words/prefetch" → "/words › prefetch"; a slug stays as it is. */
declare function progressLabel(id: string): string;
/** The default id: a slug of the assignee and the task. */
declare function progressSlug(name: string, task: string): string;
/** The storage key of one node. */
declare const progressKey: (e: {
  id: string;
}) => string;
/** A report from a writer, checked field by field. An Error says what is wrong. */
declare function parseProgressReport(body: unknown): ProgressReport | Error;
/**
 * The node a report makes, given what was there (`prev`). The first real
 * write claims an auto-created node; the owner's subtree is always his,
 * assigned to him; a note is appended; `needs: ""` clears it.
 */
declare function mergeProgress(prev: ProgressEntry | undefined, r: ProgressReport, at: number): ProgressEntry;
/** A node created only because a descendant named it: a group (or the owner's person node). */
declare function autoNode(id: string, by: string, at: number): ProgressEntry;
/** The event a write broadcasts: the node without its notes, and the note it added. */
declare function progressEvent(entry: ProgressEntry, note?: string): ProgressEvent;
/** A reader's view of a hub message; anything else is null. */
declare function parseProgressMessage(raw: unknown): ProgressMessage | null;
/** What a reader shows: the latest node per id (newest first) and the log (oldest first). */
type ProgressView = {
  rows: ProgressEntry[];
  log: ProgressEvent[];
};
/** Apply a hub message to a reader's view. */
declare function applyProgressMessage(view: ProgressView, msg: ProgressMessage): ProgressView;
/** Open work in a subtree: all open nodes that are not groups or people, and the feedback among them. */
type ProgressCounts = {
  tasks: number;
  feedback: number;
};
type ProgressNode = ProgressEntry & {
  children: ProgressNode[];
  counts: ProgressCounts; /** This node waits on the owner (see waitsOnOwner). */
  waitingOwner: boolean; /** Nodes waiting on the owner in this subtree, this one included. */
  waitingOwnerCount: number;
};
/**
 * Does this node wait on the owner? An open decision or approval, or any
 * open node marked waiting-owner or with something in `needs` — or one an
 * open to-do under OWNER_NODE refs (`todoRefs`).
 */
declare const waitsOnOwner: (e: ProgressEntry, todoRefs?: ReadonlySet<string>) => boolean;
/** The ids open owner to-dos point at. */
declare function openTodoRefs(entries: Iterable<ProgressEntry>): Set<string>;
/**
 * Fold nodes or events (in the order they happened) into the tree: the latest
 * per id, children grouped under their parent, and per node its open counts
 * and owner-waiting count over its subtree. Siblings are ordered by rank,
 * then newest first. A node whose parent is unknown — or whose parent chain
 * loops back to it — is a root.
 */
declare function foldProgress(events: Iterable<ProgressEntry | ProgressEvent>): ProgressNode[];
/** Keep only nodes waiting on the owner and their ancestors (the "Needs me" filter). */
declare function filterWaiting(tree: ProgressNode[]): ProgressNode[];
/** The owner's to-do list: the open nodes of his subtree, oldest first. */
declare function progressTodo(entries: Iterable<ProgressEntry>): ProgressEntry[];
/** "8h", "30m", "2d", "90s" → milliseconds; an Error otherwise. */
declare function parseTtl(s: string): number | Error;
//#endregion
export { mergeProgress as A, progressTodo as B, applyProgressMessage as C, isOwnerTodo as D, foldProgress as E, pathParent as F, verifyProgressToken as G, ProgressAuth as H, progressEvent as I, progressKey as L, parseProgressMessage as M, parseProgressReport as N, isPathId as O, parseTtl as P, progressLabel as R, ProgressView as S, filterWaiting as T, ProgressGrant as U, waitsOnOwner as V, mintProgressToken as W, ProgressMessage as _, PROGRESS_DONE_TTL_MS as a, ProgressReport as b, PROGRESS_LOG_MAX as c, PROGRESS_STATUSES as d, ProgressAssignee as f, ProgressKind as g, ProgressEvent as h, PROGRESS_AUTO as i, openTodoRefs as j, isProgressId as k, PROGRESS_MAX_ENTRIES as l, ProgressEntry as m, OWNER_ASSIGNEE as n, PROGRESS_KINDS as o, ProgressCounts as p, OWNER_NODE as r, PROGRESS_LIMITS as s, ASSIGNEE_TYPES as t, PROGRESS_NOTES_MAX as u, ProgressNode as v, autoNode as w, ProgressStatus as x, ProgressNote as y, progressSlug as z };
//# sourceMappingURL=progress-CNOoy1Au.d.ts.map