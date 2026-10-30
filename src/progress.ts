/**
 * Live progress on the state tree: what a writer (an agent, through
 * `liagent progress`) posts, what the hub (progress-hub.ts, a Durable
 * Object) keeps, and what a reader (<liagent-state-tree> with a progress
 * feed, progress-tree.ts) shows — shared so the three agree on the shape and
 * the limits. Pure: no I/O, no app specifics.
 *
 * Everything is a node. A node may be a plain task, have an agent assigned,
 * or be a human (the owner, OWNER_NODE). Every write is an event; the state
 * is the fold of the events (latest per `id`), and `parent` links nodes into
 * a tree (foldProgress). Top-level nodes are usually page routes ("/words");
 * their children are paths under them ("/words/prefetch", shown
 * "/words › prefetch"); work that is not a page lives under roots such as
 * "/_infra". A path id's parent is its directory, always.
 */
import { OWNER_NAME } from "./state-tree.ts";

export const PROGRESS_STATUSES = [
  "doing",
  "blocked",
  "waiting",
  "waiting-owner",
  "review",
  "done",
] as const;
export type ProgressStatus = (typeof PROGRESS_STATUSES)[number];

/**
 * "decision" / "approval": pending decisions and authorisations (a repo, a
 * merge, a grant, a secret). "feedback": work that came from a user's or the
 * owner's feedback (a bug report). "person": a human's own node. "group": a
 * plain grouping node, auto-created for a path's missing ancestors.
 */
export const PROGRESS_KINDS = [
  "task",
  "decision",
  "approval",
  "feedback",
  "person",
  "group",
] as const;
export type ProgressKind = (typeof PROGRESS_KINDS)[number];

export const ASSIGNEE_TYPES = ["agent", "human"] as const;
export type ProgressAssignee = { type: (typeof ASSIGNEE_TYPES)[number]; name: string };

export const PROGRESS_LIMITS = {
  name: 40,
  task: 120,
  note: 280,
  eta: 40,
  needs: 120,
  id: 120,
  parent: 120,
  ref: 120,
  action: 300,
  link: 300,
} as const;
/** Nodes the hub keeps at most; past it the oldest done ones go first. */
export const PROGRESS_MAX_ENTRIES = 200;
/** Events the hub's append-only log keeps (the newest). */
export const PROGRESS_LOG_MAX = 200;
/** Notes kept per node (the newest); a note appends, never overwrites. */
export const PROGRESS_NOTES_MAX = 20;
/** A done node is pruned this long after its last write. */
export const PROGRESS_DONE_TTL_MS = 24 * 60 * 60 * 1000;
/** The creator of an auto-created node: the first real write claims it. */
export const PROGRESS_AUTO = "_auto";

/**
 * The owner, as a node (kind "person", a human assignee). His to-do items
 * are its children, each with a `ref` to the node it unblocks. The data holds
 * only this id and the name OWNER_NAME (a host may show its own name for it).
 */
export const OWNER_NODE = "/@owner";
export const OWNER_ASSIGNEE: ProgressAssignee = { type: "human", name: OWNER_NAME };
export const isOwnerTodo = (id: string) => id.startsWith(`${OWNER_NODE}/`);
const isOwnerSubtree = (id: string) => id === OWNER_NODE || isOwnerTodo(id);

/**
 * What a writer posts. `id` is stable (default: a slug of assignee and
 * task); `parent` another node's id (derived for a path id); `assignee` is
 * who works on it (`agent: "<name>"` is the alias for an agent assignee) and
 * also names the writer; `needs` is what the owner must do ("" clears it);
 * `ref` (an owner to-do) the node it unblocks; `action` the exact command or
 * URL that does it; `note` is appended to the node's notes; `rev`, if given,
 * must be above the node's current rev (else 409).
 */
export type ProgressReport = {
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
  action?: string;
  /** A page about it (a PR, a preview): https only. */
  link?: string;
  note?: string;
  rev?: number;
};
export type ProgressNote = { at: number; by: string; text: string };
/**
 * A node as the hub keeps it. `creator` wrote it first (and so may change
 * its status, pct and eta), `by` wrote it last, `rev` is its revision,
 * `created` / `at` when it was first / last written.
 */
export type ProgressEntry = Omit<ProgressReport, "note" | "rev" | "kind"> & {
  kind: ProgressKind;
  creator: string;
  by: string;
  rev: number;
  created: number;
  at: number;
  notes?: ProgressNote[];
};
/** One write as broadcast and logged: the node after it (without its notes) and the note it added. */
export type ProgressEvent = { type: "progress"; note?: string } & Omit<ProgressEntry, "notes">;

/**
 * What the hub sends a reader: the state and the log on connect (and after a
 * prune or an eviction), then each event as it happens.
 */
export type ProgressMessage =
  | { type: "snapshot"; entries: ProgressEntry[]; log: ProgressEvent[] }
  | ProgressEvent;

/** Slugs ("main-live-tree") and paths ("/words/prefetch", "/_infra", "/@owner/x"). */
const ID_RE = /^(?:[a-z0-9][a-z0-9._:-]*|(?:\/@?[a-z0-9_][a-z0-9._:-]*)+)$/;
export const isProgressId = (id: unknown): id is string =>
  typeof id === "string" && id.length <= PROGRESS_LIMITS.id && ID_RE.test(id);

export const isPathId = (id: string) => id.startsWith("/");
/** A path id's parent: its directory ("/words/prefetch" → "/words"; "/words" → none). */
export const pathParent = (id: string) =>
  isPathId(id) && id.lastIndexOf("/") > 0 ? id.slice(0, id.lastIndexOf("/")) : undefined;

/** "/words/prefetch" → "/words › prefetch"; a slug stays as it is. */
export function progressLabel(id: string): string {
  if (!isPathId(id)) return id;
  const [first, ...rest] = id.slice(1).split("/");
  return [`/${first}`, ...rest].join(" › ");
}

/** The default id: a slug of the assignee and the task. */
export function progressSlug(name: string, task: string): string {
  return `${name}-${task}`
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
}

/** The storage key of one node. */
export const progressKey = (e: { id: string }) => `e:${e.id}`;

// Control characters (newlines included) collapse to a space.
// oxlint-disable-next-line no-control-regex
const clean = (v: string) => v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();

type Field = keyof typeof PROGRESS_LIMITS;
function text(v: unknown, field: Field): string | undefined | Error {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") return new Error(`${field} must be a string`);
  const s = clean(v);
  if (s.length > PROGRESS_LIMITS[field])
    return new Error(`${field} is longer than ${PROGRESS_LIMITS[field]} characters`);
  return s;
}

/** `assignee: {type, name}`, or its alias `agent: "<name>"`. */
function parseAssignee(b: Record<string, unknown>): ProgressAssignee | Error {
  if (b.assignee !== undefined && b.assignee !== null) {
    const a = b.assignee as Record<string, unknown>;
    if (typeof a !== "object" || !ASSIGNEE_TYPES.includes(a.type as ProgressAssignee["type"]))
      return new Error(`assignee must be {type: ${ASSIGNEE_TYPES.join("|")}, name}`);
    const name = text(a.name, "name");
    if (name instanceof Error) return new Error(`assignee.${name.message}`);
    if (!name) return new Error("assignee.name is required");
    return { type: a.type as ProgressAssignee["type"], name };
  }
  const name = text(b.agent, "name");
  if (name instanceof Error) return new Error(`agent: ${name.message}`);
  if (!name) return new Error("assignee (or agent) is required");
  return { type: "agent", name };
}

/** A report from a writer, checked field by field. An Error says what is wrong. */
export function parseProgressReport(body: unknown): ProgressReport | Error {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return new Error("body must be a JSON object");
  const b = body as Record<string, unknown>;
  const f: Partial<Record<Field, string>> = {};
  for (const field of Object.keys(PROGRESS_LIMITS) as Field[]) {
    if (field === "name") continue;
    const v = text(b[field], field);
    if (v instanceof Error) return v;
    if (v !== undefined) f[field] = v;
  }
  const assignee = parseAssignee(b);
  if (assignee instanceof Error) return assignee;
  if (!f.task) return new Error("task is required");
  if (!PROGRESS_STATUSES.includes(b.status as ProgressStatus))
    return new Error(`status must be one of ${PROGRESS_STATUSES.join(", ")}`);
  if (b.kind !== undefined && !PROGRESS_KINDS.includes(b.kind as ProgressKind))
    return new Error(`kind must be one of ${PROGRESS_KINDS.join(", ")}`);
  for (const k of ["id", "parent", "ref"] as const)
    if (f[k] && !isProgressId(f[k]))
      return new Error(`${k} must be a slug or a /path (a-z, 0-9, . _ : -)`);
  const id = f.id || progressSlug(assignee.name, f.task);
  if (!id) return new Error("id is required when the name and task have no letters or digits");
  let parent = f.parent || undefined;
  if (isPathId(id)) {
    const dir = pathParent(id);
    if (parent !== undefined && parent !== dir)
      return new Error(`a path's parent is its directory (${dir ?? "none"}), not ${parent}`);
    parent = dir;
  }
  if (parent === id) return new Error("parent must not be the node itself");

  const out: ProgressReport = { id, assignee, task: f.task, status: b.status as ProgressStatus };
  if (parent) out.parent = parent;
  if (b.kind !== undefined) out.kind = b.kind as ProgressKind;
  if (b.pct !== undefined && b.pct !== null) {
    if (typeof b.pct !== "number" || !Number.isFinite(b.pct) || b.pct < 0 || b.pct > 100)
      return new Error("pct must be a number from 0 to 100");
    out.pct = Math.round(b.pct);
  }
  for (const k of ["pr", "rev"] as const)
    if (b[k] !== undefined && b[k] !== null) {
      const n = b[k];
      if (typeof n !== "number" || !Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER)
        return new Error(`${k} must be a positive integer`);
      out[k] = n;
    }
  if (f.link) {
    if (!/^https:\/\/\S+$/.test(f.link)) return new Error("link must be an https:// URL");
    out.link = f.link;
  }
  if (f.needs !== undefined) out.needs = f.needs;
  for (const k of ["eta", "ref", "action", "note"] as const) if (f[k]) out[k] = f[k];
  return out;
}

/**
 * The node a report makes, given what was there (`prev`). The first real
 * write claims an auto-created node; the owner's subtree is always his,
 * assigned to him; a note is appended; `needs: ""` clears it.
 */
export function mergeProgress(
  prev: ProgressEntry | undefined,
  r: ProgressReport,
  at: number,
): ProgressEntry {
  const claim = !prev || prev.creator === PROGRESS_AUTO;
  const pick = <K extends "pct" | "eta" | "pr" | "ref" | "action" | "link">(k: K) =>
    r[k] ?? prev?.[k];
  const needs = r.needs === undefined ? prev?.needs : r.needs || undefined;
  const notes = [...(prev?.notes ?? [])];
  if (r.note) notes.push({ at, by: r.assignee.name, text: r.note });
  const entry: ProgressEntry = {
    id: r.id,
    assignee: isOwnerSubtree(r.id) ? OWNER_ASSIGNEE : claim ? r.assignee : prev.assignee,
    task: r.task,
    status: r.status,
    kind: r.id === OWNER_NODE ? "person" : (r.kind ?? (claim || !prev ? "task" : prev.kind)),
    creator: claim ? r.assignee.name : prev.creator,
    by: r.assignee.name,
    rev: r.rev ?? (prev?.rev ?? 0) + 1,
    created: prev?.created ?? at,
    at,
  };
  const parent = r.parent ?? prev?.parent;
  if (parent) entry.parent = parent;
  for (const k of ["pct", "eta", "pr", "ref", "action", "link"] as const) {
    const v = pick(k);
    if (v !== undefined) (entry as Record<string, unknown>)[k] = v;
  }
  if (needs) entry.needs = needs;
  if (notes.length) entry.notes = notes.slice(-PROGRESS_NOTES_MAX);
  return entry;
}

/** A node created only because a descendant named it: a group (or the owner's person node). */
export function autoNode(id: string, by: string, at: number): ProgressEntry {
  const owner = id === OWNER_NODE;
  const entry: ProgressEntry = {
    id,
    assignee: owner ? OWNER_ASSIGNEE : { type: "agent", name: by },
    task: owner ? OWNER_NAME : id.slice(id.lastIndexOf("/") + 1),
    status: "doing",
    kind: owner ? "person" : "group",
    creator: PROGRESS_AUTO,
    by,
    rev: 1,
    created: at,
    at,
  };
  const parent = pathParent(id);
  if (parent) entry.parent = parent;
  return entry;
}

/** The event a write broadcasts: the node without its notes, and the note it added. */
export function progressEvent(entry: ProgressEntry, note?: string): ProgressEvent {
  const { notes: _notes, ...rest } = entry;
  return { type: "progress", ...rest, ...(note ? { note } : {}) };
}

const isEntry = (e: unknown): e is ProgressEntry => {
  if (!e || typeof e !== "object") return false;
  const x = e as Record<string, unknown>;
  const a = x.assignee as Record<string, unknown> | undefined;
  return (
    typeof x.id === "string" &&
    !!a &&
    typeof a.name === "string" &&
    ASSIGNEE_TYPES.includes(a.type as ProgressAssignee["type"]) &&
    typeof x.task === "string" &&
    PROGRESS_STATUSES.includes(x.status as ProgressStatus) &&
    PROGRESS_KINDS.includes(x.kind as ProgressKind) &&
    typeof x.at === "number"
  );
};

/** A reader's view of a hub message; anything else is null. */
export function parseProgressMessage(raw: unknown): ProgressMessage | null {
  let m: unknown;
  try {
    m = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
  if (!m || typeof m !== "object") return null;
  const msg = m as Record<string, unknown>;
  if (msg.type === "snapshot" && Array.isArray(msg.entries))
    return {
      type: "snapshot",
      entries: msg.entries.filter(isEntry),
      log: (Array.isArray(msg.log) ? msg.log : []).filter(isEntry) as ProgressEvent[],
    };
  if (msg.type === "progress" && isEntry(msg)) return msg as unknown as ProgressEvent;
  return null;
}

/** What a reader shows: the latest node per id (newest first) and the log (oldest first). */
export type ProgressView = { rows: ProgressEntry[]; log: ProgressEvent[] };

/** Apply a hub message to a reader's view. */
export function applyProgressMessage(view: ProgressView, msg: ProgressMessage): ProgressView {
  if (msg.type === "snapshot")
    return { rows: [...msg.entries].sort((a, b) => b.at - a.at), log: msg.log };
  const { type: _type, note, ...rest } = msg;
  const prev = view.rows.find((r) => r.id === msg.id);
  const notes = [...(prev?.notes ?? [])];
  if (note) notes.push({ at: msg.at, by: msg.by, text: note });
  const entry: ProgressEntry = {
    ...rest,
    ...(notes.length ? { notes: notes.slice(-PROGRESS_NOTES_MAX) } : {}),
  };
  return {
    rows: [entry, ...view.rows.filter((r) => r.id !== msg.id)].sort((a, b) => b.at - a.at),
    log: [...view.log, msg].slice(-PROGRESS_LOG_MAX),
  };
}

/** Open work in a subtree: all open nodes that are not groups or people, and the feedback among them. */
export type ProgressCounts = { tasks: number; feedback: number };
export type ProgressNode = ProgressEntry & {
  children: ProgressNode[];
  counts: ProgressCounts;
  /** This node waits on the owner (see waitsOnOwner). */
  waitingOwner: boolean;
  /** Nodes waiting on the owner in this subtree, this one included. */
  waitingOwnerCount: number;
};

const isOpen = (e: ProgressEntry) => e.status !== "done";
const isWork = (e: ProgressEntry) => isOpen(e) && e.kind !== "group" && e.kind !== "person";

/**
 * Does this node wait on the owner? An open decision or approval, or any
 * open node marked waiting-owner or with something in `needs` — or one an
 * open to-do under OWNER_NODE refs (`todoRefs`).
 */
export const waitsOnOwner = (e: ProgressEntry, todoRefs: ReadonlySet<string> = new Set()) =>
  isOpen(e) &&
  (e.kind === "decision" ||
    e.kind === "approval" ||
    e.status === "waiting-owner" ||
    !!e.needs?.trim() ||
    todoRefs.has(e.id));

/** The ids open owner to-dos point at. */
export function openTodoRefs(entries: Iterable<ProgressEntry>): Set<string> {
  const refs = new Set<string>();
  for (const e of entries) if (isOwnerTodo(e.id) && isOpen(e) && e.ref) refs.add(e.ref);
  return refs;
}

/** Siblings: waiting on the owner first, then those with a waiting descendant, then newest first. */
const rank = (n: ProgressNode) => (n.waitingOwner ? 2 : n.waitingOwnerCount > 0 ? 1 : 0);

/**
 * Fold nodes or events (in the order they happened) into the tree: the latest
 * per id, children grouped under their parent, and per node its open counts
 * and owner-waiting count over its subtree. Siblings are ordered by rank,
 * then newest first. A node whose parent is unknown — or whose parent chain
 * loops back to it — is a root.
 */
export function foldProgress(events: Iterable<ProgressEntry | ProgressEvent>): ProgressNode[] {
  const nodes = new Map<string, ProgressNode>();
  for (const e of events) {
    const { type: _type, note: _note, ...entry } = e as ProgressEvent;
    nodes.set(entry.id, {
      ...(entry as ProgressEntry),
      children: [],
      counts: { tasks: 0, feedback: 0 },
      waitingOwner: false,
      waitingOwnerCount: 0,
    });
  }
  const refs = openTodoRefs(nodes.values());
  const loops = (id: string) => {
    const seen = new Set([id]);
    for (let p = nodes.get(id)?.parent; p !== undefined; p = nodes.get(p)?.parent) {
      if (seen.has(p)) return true;
      if (!nodes.has(p)) return false;
      seen.add(p);
    }
    return false;
  };
  const roots: ProgressNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parent === undefined ? undefined : nodes.get(node.parent);
    if (parent && !loops(node.id)) parent.children.push(node);
    else roots.push(node);
  }
  const finish = (list: ProgressNode[]) => {
    const sum = { tasks: 0, feedback: 0, waiting: 0 };
    for (const n of list) {
      const below = finish(n.children);
      const self = isWork(n) ? 1 : 0;
      n.counts = {
        tasks: below.tasks + self,
        feedback: below.feedback + (self && n.kind === "feedback" ? 1 : 0),
      };
      n.waitingOwner = waitsOnOwner(n, refs);
      n.waitingOwnerCount = below.waiting + (n.waitingOwner ? 1 : 0);
      sum.tasks += n.counts.tasks;
      sum.feedback += n.counts.feedback;
      sum.waiting += n.waitingOwnerCount;
    }
    list.sort((a, b) => rank(b) - rank(a) || b.at - a.at);
    return sum;
  };
  finish(roots);
  return roots;
}

/** Keep only nodes waiting on the owner and their ancestors (the "Needs me" filter). */
export function filterWaiting(tree: ProgressNode[]): ProgressNode[] {
  return tree
    .filter((n) => n.waitingOwnerCount > 0)
    .map((n) => ({ ...n, children: filterWaiting(n.children) }));
}

/** The owner's to-do list: the open nodes of his subtree, oldest first. */
export function progressTodo(entries: Iterable<ProgressEntry>): ProgressEntry[] {
  return [...entries]
    .filter((e) => isOwnerTodo(e.id) && isOpen(e))
    .sort((a, b) => a.created - b.created);
}

/** "8h", "30m", "2d", "90s" → milliseconds; an Error otherwise. */
export function parseTtl(s: string): number | Error {
  const m = /^(\d+(?:\.\d+)?)\s*([smhd])$/.exec(s.trim());
  if (!m) return new Error(`ttl must look like 30m, 8h or 2d, not ${s}`);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  return Math.round(Number(m[1]) * unit);
}
export * from "./progress-token.ts";
