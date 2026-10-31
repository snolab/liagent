import { t as OWNER_NAME } from "./state-tree-BZCmAknI.js";

//#region src/progress-token.ts
const enc = new TextEncoder();
function b64url(bytes) {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s) {
	if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
	try {
		const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	} catch {
		return null;
	}
}
const key = (secret) => crypto.subtle.importKey("raw", enc.encode(secret), {
	name: "HMAC",
	hash: "SHA-256"
}, false, ["sign", "verify"]);
/** A scoped token for `grant`, signed with the root secret. */
async function mintProgressToken(secret, grant) {
	const payload = b64url(enc.encode(JSON.stringify(grant)));
	return `${payload}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(payload))))}`;
}
/** Compare by digest, so the time taken says nothing about the secret. */
async function sameSecret(a, b) {
	const digest = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
	const [x, y] = await Promise.all([digest(a), digest(b)]);
	let diff = 0;
	for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
	return diff === 0;
}
/**
* Who a bearer token is: the root, a live scoped grant, or null (wrong
* signature, malformed, or expired).
*/
async function verifyProgressToken(secret, token, now = Date.now()) {
	if (!secret || !token) return null;
	if (await sameSecret(token, secret)) return { root: true };
	const [payload, sig, extra] = token.split(".");
	if (extra !== void 0 || !payload || !sig) return null;
	const sigBytes = unb64url(sig);
	if (!sigBytes) return null;
	if (!await crypto.subtle.verify("HMAC", await key(secret), sigBytes, enc.encode(payload))) return null;
	let g;
	try {
		g = JSON.parse(new TextDecoder().decode(unb64url(payload) ?? new Uint8Array()));
	} catch {
		return null;
	}
	if (typeof g.node !== "string" || typeof g.agent !== "string" || typeof g.exp !== "number") return null;
	if (g.exp <= now) return null;
	return {
		root: false,
		node: g.node,
		agent: g.agent,
		exp: g.exp,
		...typeof g.via === "string" ? { via: g.via } : {}
	};
}

//#endregion
//#region src/progress.ts
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
const PROGRESS_STATUSES = [
	"doing",
	"blocked",
	"waiting",
	"waiting-owner",
	"review",
	"done"
];
/**
* "decision" / "approval": pending decisions and authorisations (a repo, a
* merge, a grant, a secret). "feedback": work that came from a user's or the
* owner's feedback (a bug report). "person": a human's own node. "group": a
* plain grouping node, auto-created for a path's missing ancestors.
*/
const PROGRESS_KINDS = [
	"task",
	"decision",
	"approval",
	"feedback",
	"person",
	"group"
];
const ASSIGNEE_TYPES = ["agent", "human"];
const PROGRESS_LIMITS = {
	name: 40,
	task: 120,
	note: 280,
	eta: 40,
	needs: 120,
	id: 120,
	parent: 120,
	ref: 120,
	action: 300,
	link: 300
};
/** Nodes the hub keeps at most; past it the oldest done ones go first. */
const PROGRESS_MAX_ENTRIES = 200;
/** Events the hub's append-only log keeps (the newest). */
const PROGRESS_LOG_MAX = 200;
/** Notes kept per node (the newest); a note appends, never overwrites. */
const PROGRESS_NOTES_MAX = 20;
/** A done node is pruned this long after its last write. */
const PROGRESS_DONE_TTL_MS = 1440 * 60 * 1e3;
/** The creator of an auto-created node: the first real write claims it. */
const PROGRESS_AUTO = "_auto";
/**
* The owner, as a node (kind "person", a human assignee). His to-do items
* are its children, each with a `ref` to the node it unblocks. The data holds
* only this id and the name OWNER_NAME (a host may show its own name for it).
*/
const OWNER_NODE = "/@owner";
const OWNER_ASSIGNEE = {
	type: "human",
	name: OWNER_NAME
};
const isOwnerTodo = (id) => id.startsWith(`${OWNER_NODE}/`);
const isOwnerSubtree = (id) => id === OWNER_NODE || isOwnerTodo(id);
/** Slugs ("main-live-tree") and paths ("/words/prefetch", "/_infra", "/@owner/x"). */
const ID_RE = /^(?:[a-z0-9][a-z0-9._:-]*|(?:\/@?[a-z0-9_][a-z0-9._:-]*)+)$/;
const isProgressId = (id) => typeof id === "string" && id.length <= PROGRESS_LIMITS.id && ID_RE.test(id);
const isPathId = (id) => id.startsWith("/");
/** A path id's parent: its directory ("/words/prefetch" → "/words"; "/words" → none). */
const pathParent = (id) => isPathId(id) && id.lastIndexOf("/") > 0 ? id.slice(0, id.lastIndexOf("/")) : void 0;
/** "/words/prefetch" → "/words › prefetch"; a slug stays as it is. */
function progressLabel(id) {
	if (!isPathId(id)) return id;
	const [first, ...rest] = id.slice(1).split("/");
	return [`/${first}`, ...rest].join(" › ");
}
/** The default id: a slug of the assignee and the task. */
function progressSlug(name, task) {
	return `${name}-${task}`.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");
}
/** The storage key of one node. */
const progressKey = (e) => `e:${e.id}`;
const clean = (v) => v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
function text(v, field) {
	if (v === void 0 || v === null) return void 0;
	if (typeof v !== "string") return /* @__PURE__ */ new Error(`${field} must be a string`);
	const s = clean(v);
	if (s.length > PROGRESS_LIMITS[field]) return /* @__PURE__ */ new Error(`${field} is longer than ${PROGRESS_LIMITS[field]} characters`);
	return s;
}
/** `assignee: {type, name}`, or its alias `agent: "<name>"`. */
function parseAssignee(b) {
	if (b.assignee !== void 0 && b.assignee !== null) {
		const a = b.assignee;
		if (typeof a !== "object" || !ASSIGNEE_TYPES.includes(a.type)) return /* @__PURE__ */ new Error(`assignee must be {type: ${ASSIGNEE_TYPES.join("|")}, name}`);
		const name = text(a.name, "name");
		if (name instanceof Error) return /* @__PURE__ */ new Error(`assignee.${name.message}`);
		if (!name) return /* @__PURE__ */ new Error("assignee.name is required");
		return {
			type: a.type,
			name
		};
	}
	const name = text(b.agent, "name");
	if (name instanceof Error) return /* @__PURE__ */ new Error(`agent: ${name.message}`);
	if (!name) return /* @__PURE__ */ new Error("assignee (or agent) is required");
	return {
		type: "agent",
		name
	};
}
/** A report from a writer, checked field by field. An Error says what is wrong. */
function parseProgressReport(body) {
	if (!body || typeof body !== "object" || Array.isArray(body)) return /* @__PURE__ */ new Error("body must be a JSON object");
	const b = body;
	const f = {};
	for (const field of Object.keys(PROGRESS_LIMITS)) {
		if (field === "name") continue;
		const v = text(b[field], field);
		if (v instanceof Error) return v;
		if (v !== void 0) f[field] = v;
	}
	const assignee = parseAssignee(b);
	if (assignee instanceof Error) return assignee;
	if (!f.task) return /* @__PURE__ */ new Error("task is required");
	if (!PROGRESS_STATUSES.includes(b.status)) return /* @__PURE__ */ new Error(`status must be one of ${PROGRESS_STATUSES.join(", ")}`);
	if (b.kind !== void 0 && !PROGRESS_KINDS.includes(b.kind)) return /* @__PURE__ */ new Error(`kind must be one of ${PROGRESS_KINDS.join(", ")}`);
	for (const k of [
		"id",
		"parent",
		"ref"
	]) if (f[k] && !isProgressId(f[k])) return /* @__PURE__ */ new Error(`${k} must be a slug or a /path (a-z, 0-9, . _ : -)`);
	const id = f.id || progressSlug(assignee.name, f.task);
	if (!id) return /* @__PURE__ */ new Error("id is required when the name and task have no letters or digits");
	let parent = f.parent || void 0;
	if (isPathId(id)) {
		const dir = pathParent(id);
		if (parent !== void 0 && parent !== dir) return /* @__PURE__ */ new Error(`a path's parent is its directory (${dir ?? "none"}), not ${parent}`);
		parent = dir;
	}
	if (parent === id) return /* @__PURE__ */ new Error("parent must not be the node itself");
	const out = {
		id,
		assignee,
		task: f.task,
		status: b.status
	};
	if (parent) out.parent = parent;
	if (b.kind !== void 0) out.kind = b.kind;
	if (b.pct !== void 0 && b.pct !== null) {
		if (typeof b.pct !== "number" || !Number.isFinite(b.pct) || b.pct < 0 || b.pct > 100) return /* @__PURE__ */ new Error("pct must be a number from 0 to 100");
		out.pct = Math.round(b.pct);
	}
	for (const k of ["pr", "rev"]) if (b[k] !== void 0 && b[k] !== null) {
		const n = b[k];
		if (typeof n !== "number" || !Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) return /* @__PURE__ */ new Error(`${k} must be a positive integer`);
		out[k] = n;
	}
	if (f.link) {
		if (!/^https:\/\/\S+$/.test(f.link)) return /* @__PURE__ */ new Error("link must be an https:// URL");
		out.link = f.link;
	}
	if (f.needs !== void 0) out.needs = f.needs;
	for (const k of [
		"eta",
		"ref",
		"action",
		"note"
	]) if (f[k]) out[k] = f[k];
	return out;
}
/**
* The node a report makes, given what was there (`prev`). The first real
* write claims an auto-created node; the owner's subtree is always his,
* assigned to him; a note is appended; `needs: ""` clears it.
*/
function mergeProgress(prev, r, at) {
	const claim = !prev || prev.creator === PROGRESS_AUTO;
	const pick = (k) => r[k] ?? prev?.[k];
	const needs = r.needs === void 0 ? prev?.needs : r.needs || void 0;
	const notes = [...prev?.notes ?? []];
	if (r.note) notes.push({
		at,
		by: r.assignee.name,
		text: r.note
	});
	const entry = {
		id: r.id,
		assignee: isOwnerSubtree(r.id) ? OWNER_ASSIGNEE : claim ? r.assignee : prev.assignee,
		task: r.task,
		status: r.status,
		kind: r.id === OWNER_NODE ? "person" : r.kind ?? (claim || !prev ? "task" : prev.kind),
		creator: claim ? r.assignee.name : prev.creator,
		by: r.assignee.name,
		rev: r.rev ?? (prev?.rev ?? 0) + 1,
		created: prev?.created ?? at,
		at
	};
	const parent = r.parent ?? prev?.parent;
	if (parent) entry.parent = parent;
	for (const k of [
		"pct",
		"eta",
		"pr",
		"ref",
		"action",
		"link"
	]) {
		const v = pick(k);
		if (v !== void 0) entry[k] = v;
	}
	if (needs) entry.needs = needs;
	if (notes.length) entry.notes = notes.slice(-PROGRESS_NOTES_MAX);
	return entry;
}
/** A node created only because a descendant named it: a group (or the owner's person node). */
function autoNode(id, by, at) {
	const owner = id === OWNER_NODE;
	const entry = {
		id,
		assignee: owner ? OWNER_ASSIGNEE : {
			type: "agent",
			name: by
		},
		task: owner ? OWNER_NAME : id.slice(id.lastIndexOf("/") + 1),
		status: "doing",
		kind: owner ? "person" : "group",
		creator: PROGRESS_AUTO,
		by,
		rev: 1,
		created: at,
		at
	};
	const parent = pathParent(id);
	if (parent) entry.parent = parent;
	return entry;
}
/** The event a write broadcasts: the node without its notes, and the note it added. */
function progressEvent(entry, note) {
	const { notes: _notes, ...rest } = entry;
	return {
		type: "progress",
		...rest,
		...note ? { note } : {}
	};
}
const isEntry = (e) => {
	if (!e || typeof e !== "object") return false;
	const x = e;
	const a = x.assignee;
	return typeof x.id === "string" && !!a && typeof a.name === "string" && ASSIGNEE_TYPES.includes(a.type) && typeof x.task === "string" && PROGRESS_STATUSES.includes(x.status) && PROGRESS_KINDS.includes(x.kind) && typeof x.at === "number";
};
/** A reader's view of a hub message; anything else is null. */
function parseProgressMessage(raw) {
	let m;
	try {
		m = typeof raw === "string" ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
	if (!m || typeof m !== "object") return null;
	const msg = m;
	if (msg.type === "snapshot" && Array.isArray(msg.entries)) return {
		type: "snapshot",
		entries: msg.entries.filter(isEntry),
		log: (Array.isArray(msg.log) ? msg.log : []).filter(isEntry)
	};
	if (msg.type === "progress" && isEntry(msg)) return msg;
	return null;
}
/** Apply a hub message to a reader's view. */
function applyProgressMessage(view, msg) {
	if (msg.type === "snapshot") return {
		rows: [...msg.entries].sort((a, b) => b.at - a.at),
		log: msg.log
	};
	const { type: _type, note, ...rest } = msg;
	const notes = [...view.rows.find((r) => r.id === msg.id)?.notes ?? []];
	if (note) notes.push({
		at: msg.at,
		by: msg.by,
		text: note
	});
	return {
		rows: [{
			...rest,
			...notes.length ? { notes: notes.slice(-PROGRESS_NOTES_MAX) } : {}
		}, ...view.rows.filter((r) => r.id !== msg.id)].sort((a, b) => b.at - a.at),
		log: [...view.log, msg].slice(-PROGRESS_LOG_MAX)
	};
}
const isOpen = (e) => e.status !== "done";
const isWork = (e) => isOpen(e) && e.kind !== "group" && e.kind !== "person";
/**
* Does this node wait on the owner? An open decision or approval, or any
* open node marked waiting-owner or with something in `needs` — or one an
* open to-do under OWNER_NODE refs (`todoRefs`).
*/
const waitsOnOwner = (e, todoRefs = /* @__PURE__ */ new Set()) => isOpen(e) && (e.kind === "decision" || e.kind === "approval" || e.status === "waiting-owner" || !!e.needs?.trim() || todoRefs.has(e.id));
/** The ids open owner to-dos point at. */
function openTodoRefs(entries) {
	const refs = /* @__PURE__ */ new Set();
	for (const e of entries) if (isOwnerTodo(e.id) && isOpen(e) && e.ref) refs.add(e.ref);
	return refs;
}
/** Siblings: waiting on the owner first, then those with a waiting descendant, then newest first. */
const rank = (n) => n.waitingOwner ? 2 : n.waitingOwnerCount > 0 ? 1 : 0;
/**
* Fold nodes or events (in the order they happened) into the tree: the latest
* per id, children grouped under their parent, and per node its open counts
* and owner-waiting count over its subtree. Siblings are ordered by rank,
* then newest first. A node whose parent is unknown — or whose parent chain
* loops back to it — is a root.
*/
function foldProgress(events) {
	const nodes = /* @__PURE__ */ new Map();
	for (const e of events) {
		const { type: _type, note: _note, ...entry } = e;
		nodes.set(entry.id, {
			...entry,
			children: [],
			counts: {
				tasks: 0,
				feedback: 0
			},
			waitingOwner: false,
			waitingOwnerCount: 0
		});
	}
	const refs = openTodoRefs(nodes.values());
	const loops = (id) => {
		const seen = new Set([id]);
		for (let p = nodes.get(id)?.parent; p !== void 0; p = nodes.get(p)?.parent) {
			if (seen.has(p)) return true;
			if (!nodes.has(p)) return false;
			seen.add(p);
		}
		return false;
	};
	const roots = [];
	for (const node of nodes.values()) {
		const parent = node.parent === void 0 ? void 0 : nodes.get(node.parent);
		if (parent && !loops(node.id)) parent.children.push(node);
		else roots.push(node);
	}
	const finish = (list) => {
		const sum = {
			tasks: 0,
			feedback: 0,
			waiting: 0
		};
		for (const n of list) {
			const below = finish(n.children);
			const self = isWork(n) ? 1 : 0;
			n.counts = {
				tasks: below.tasks + self,
				feedback: below.feedback + (self && n.kind === "feedback" ? 1 : 0)
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
function filterWaiting(tree) {
	return tree.filter((n) => n.waitingOwnerCount > 0).map((n) => ({
		...n,
		children: filterWaiting(n.children)
	}));
}
/** The owner's to-do list: the open nodes of his subtree, oldest first. */
function progressTodo(entries) {
	return [...entries].filter((e) => isOwnerTodo(e.id) && isOpen(e)).sort((a, b) => a.created - b.created);
}
/** "8h", "30m", "2d", "90s" → milliseconds; an Error otherwise. */
function parseTtl(s) {
	const m = /^(\d+(?:\.\d+)?)\s*([smhd])$/.exec(s.trim());
	if (!m) return /* @__PURE__ */ new Error(`ttl must look like 30m, 8h or 2d, not ${s}`);
	const unit = {
		s: 1e3,
		m: 6e4,
		h: 36e5,
		d: 864e5
	}[m[2]];
	return Math.round(Number(m[1]) * unit);
}

//#endregion
export { waitsOnOwner as A, parseTtl as C, progressLabel as D, progressKey as E, verifyProgressToken as M, progressSlug as O, parseProgressReport as S, progressEvent as T, isPathId as _, PROGRESS_DONE_TTL_MS as a, openTodoRefs as b, PROGRESS_LOG_MAX as c, PROGRESS_STATUSES as d, applyProgressMessage as f, isOwnerTodo as g, foldProgress as h, PROGRESS_AUTO as i, mintProgressToken as j, progressTodo as k, PROGRESS_MAX_ENTRIES as l, filterWaiting as m, OWNER_ASSIGNEE as n, PROGRESS_KINDS as o, autoNode as p, OWNER_NODE as r, PROGRESS_LIMITS as s, ASSIGNEE_TYPES as t, PROGRESS_NOTES_MAX as u, isProgressId as v, pathParent as w, parseProgressMessage as x, mergeProgress as y };
//# sourceMappingURL=progress-CJs08bXb.js.map