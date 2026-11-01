import { a as filterNeedsOwner, i as crumbs, o as findLinks, r as countOpen, s as frontier, u as parseTreeDoc } from "./state-tree-BZCmAknI.js";
import { A as waitsOnOwner, _ as isPathId, b as openTodoRefs, f as applyProgressMessage, x as parseProgressMessage } from "./progress-CJs08bXb.js";

//#region src/progress-tree.ts
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
const STATUS = {
	doing: "doing",
	review: "doing",
	blocked: "blocked",
	waiting: "open",
	"waiting-owner": "open",
	done: "done"
};
/** How an outline title answers to a path segment: its first word, or the whole title, as a slug. */
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9@/_]+/g, "-").replace(/^-+|-+$/g, "");
const bare = (s) => s.replace(/^\//, "");
const matches = (title, seg) => {
	return bare(slug(title.trim().split(/\s+/)[0] ?? "")) === seg || bare(slug(title)) === seg;
};
/** The live part of a node's note: "40% · ETA 15m · needs: … · <latest note>". */
function liveNote(e) {
	return [
		e.pct != null ? `${e.pct}%` : "",
		e.eta ? `ETA ${e.eta}` : "",
		e.needs ? `needs: ${e.needs}` : "",
		e.notes?.at(-1)?.text ?? ""
	].filter(Boolean).join(" · ");
}
function apply(n, e, waiting, opts) {
	n.status = STATUS[e.status];
	n.done = e.status === "done";
	if (waiting) n.needsOwner = true;
	else delete n.needsOwner;
	n.assignee = {
		type: e.assignee.type,
		name: e.assignee.name
	};
	if (e.action) n.action = e.action;
	const live = liveNote(e);
	if (live) n.note = n.note ? `${live}\n${n.note}` : live;
	const extra = [
		...e.pr ? findLinks(`#${e.pr}`, opts) : [],
		...e.link ? [{
			text: e.link,
			url: e.link
		}] : [],
		...e.action ? findLinks(e.action, opts) : []
	];
	for (const l of extra) if (!n.links.some((x) => x.url === l.url)) n.links.push(l);
}
const clone = (n) => ({
	...n,
	links: [...n.links],
	children: n.children.map(clone)
});
/**
* Lay the hub's nodes over the outline (parseTreeDoc's root). Path ids walk
* the outline segment by segment ("/words" is the heading whose first word
* is /words; deeper segments match an item's first word or its whole title
* as a slug), adding what is missing; a slug id goes under a "Live" heading.
* Groups and people are structure only. `opts.repo` makes `pr` a link. The
* input is not changed.
*/
function overlayProgress(base, entries, opts = {}) {
	const { liveTitle = "Live", ...parse } = opts;
	const root = clone(base);
	const byId = new Map(entries.map((e) => [e.id, e]));
	const refs = openTodoRefs(entries);
	const place = (segs, at, title) => {
		let n = at;
		segs.forEach((seg, i) => {
			let hit = n.children.find((c) => matches(c.title, seg));
			if (!hit) {
				hit = {
					title: title(i),
					links: [],
					children: []
				};
				n.children.push(hit);
			}
			n = hit;
		});
		return n;
	};
	/** A new node's title: the hub's task for it, else the segment ("/words" at the top). */
	const titleOf = (segs, i) => {
		const e = byId.get(`/${segs.slice(0, i + 1).join("/")}`);
		if (e && e.kind !== "person" && e.kind !== "group") return e.task;
		return i === 0 && !segs[0].startsWith("@") ? `/${segs[0]}` : segs[i];
	};
	const ordered = [...entries].sort((a, b) => a.id.split("/").length - b.id.split("/").length);
	for (const e of ordered) {
		if (e.kind === "group" || e.kind === "person") continue;
		let target;
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
/** Reconnect delays: 1 s doubling to 60 s; after GIVE_UP failures in a row, wait for a wake. */
const FEED_MAX_DELAY_MS = 6e4;
const GIVE_UP = 10;
/** ws(s):// for an http(s):// URL; a relative path resolves against the page. */
function progressSocketUrl(url, base) {
	const u = new URL(url, base ?? globalThis.location?.href);
	if (u.protocol === "https:") u.protocol = "wss:";
	if (u.protocol === "http:") u.protocol = "ws:";
	return u.toString();
}
/** Wake on `online` and on the tab becoming visible (a no-op outside a browser). */
const browserWake = (fn) => {
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
function progressFeed(opts) {
	const open = opts.socket ?? ((u) => new WebSocket(u));
	const later = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
	const cancel = opts.clearTimeout ?? ((t) => clearTimeout(t));
	const wake = opts.onWake ?? browserWake;
	const ready = /* @__PURE__ */ new Set();
	return {
		resolve(id, note) {
			const ws = ready.values().next().value;
			if (!ws) return false;
			try {
				ws.send?.(JSON.stringify(note ? {
					type: "resolve",
					id,
					note
				} : {
					type: "resolve",
					id
				}));
				return true;
			} catch {
				return false;
			}
		},
		subscribe(onView) {
			let view = {
				rows: [],
				log: []
			};
			let live = false;
			let ws = null;
			let retry;
			let failures = 0;
			let stopped = false;
			const connect = () => {
				if (retry !== void 0) cancel(retry);
				retry = void 0;
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
					retry = later(connect, Math.min(FEED_MAX_DELAY_MS, 1e3 * 2 ** (failures - 1)));
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
				if (retry !== void 0) cancel(retry);
				off();
				if (ws) ready.delete(ws);
				ws?.close();
			};
		}
	};
}

//#endregion
//#region src/tree.ts
const TREE_STRINGS_EN = {
	tree: "Tree",
	back: "Back to the chat",
	needsMe: "Needs me",
	needsYou: "needs you",
	openCount: "{n} open",
	needsYouCount: "{n} need you",
	copy: "Copy",
	copied: "Copied",
	loading: "Loading…",
	failed: "Could not load the tree",
	empty: "The tree is empty.",
	nothingNeedsYou: "Nothing waits on you.",
	you: "you",
	lastDone: "Last done",
	nowDoing: "In progress",
	upNext: "Up next",
	live: "Live"
};
const toRoot = (v, opts) => typeof v === "string" ? parseTreeDoc(v, opts) : Array.isArray(v) ? {
	title: "",
	links: [],
	children: v
} : v;
/** Load a URL or function source once into its document root. */
async function loadTree(source, opts = {}) {
	let v;
	if (typeof source === "string") {
		const r = await fetch(source, {
			credentials: "same-origin",
			cache: "no-store"
		});
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		v = await r.text();
	} else v = await source();
	return toRoot(v, opts);
}
/**
* Watch any TreeSource: `onRoot` gets each version (a URL or function once, a
* feed on every push). Returns the stop function. Never polls.
*/
function watchTree(source, opts, onRoot, onError) {
	let alive = true;
	if (typeof source === "object") {
		const off = source.subscribe((v, meta) => alive && onRoot(toRoot(v, opts), !!meta?.live), (e) => alive && onError(e));
		return () => {
			alive = false;
			off();
		};
	}
	loadTree(source, opts).then((r) => alive && onRoot(r, false), (e) => alive && onError(e));
	return () => {
		alive = false;
	};
}
/**
* The outline with live progress laid over it: the base as it loads, then
* the overlay again on every hub message, with `meta.live` while the hub's
* socket is up. Without the hub (not deployed, not a reader) the outline
* shows as it is. Never polls.
*/
function liveTreeSource(opts) {
	const { base, progress, ...overlay } = opts;
	const feed = typeof progress === "string" ? progressFeed({ url: progress }) : "subscribe" in progress ? progress : progressFeed(progress);
	return { subscribe(onUpdate, onError) {
		let root = null;
		let rows = [];
		let live = false;
		const push = () => root && onUpdate(overlayProgress(root, rows, overlay), { live });
		const stopBase = watchTree(base, overlay, (r) => {
			root = r;
			push();
		}, (e) => onError?.(e));
		const stopFeed = feed.subscribe((view, isLive) => {
			rows = view.rows;
			live = isLive;
			push();
		});
		return () => {
			stopBase();
			stopFeed();
		};
	} };
}
const ACCENT = "oklch(0.58 0.21 33)";
const INK = {
	open: "oklch(0.62 0.03 260)",
	doing: "oklch(0.6 0.16 250)",
	blocked: "oklch(0.7 0.16 70)",
	done: "oklch(0.62 0.15 150)"
};
const LINK = "oklch(0.58 0.15 255)";
const GLYPH = {
	open: "☐",
	doing: "◧",
	blocked: "⊘",
	done: "☑"
};
/** localStorage: "1" while the Needs me filter is on (per device). */
const NEEDS_ME_KEY = "liagent:tree-needs-me";
const CSS = `
:host { display: block; font: 12px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--liagent-fg, CanvasText); --bg: var(--liagent-bg, Canvas);
  text-shadow: 0 0 3px var(--bg), 0 0 6px var(--bg); pointer-events: none; }
* { box-sizing: border-box; }
ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
ul ul { padding-inline-start: 12px; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; position: relative; }
/* Small controls: a 40px invisible hit area. */
button.hit::after { content: ""; position: absolute; inset: -10px; }
.head, .line, .act, .note { pointer-events: auto; }
.head { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.head .grow { flex: 1; display: flex; align-items: center; gap: 6px; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: ${INK.done}; }
.needs { font-size: 10px; font-weight: 600; color: ${ACCENT}; opacity: .7; }
.needs[aria-pressed="true"] { opacity: 1; text-decoration: underline; }
.line { display: flex; gap: 4px; align-items: flex-start; }
.line.branch { cursor: pointer; user-select: none; }
.chev { width: 10px; flex: none; display: inline-block; transition: transform .15s; }
.chev.open { transform: rotate(90deg); }
.text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.heading > .line .text { font-weight: 600; }
.done > .line .text { opacity: .6; }
.mark { font-weight: 700; margin-inline-end: 4px; }
.marked > .line .text { opacity: 1; font-weight: 500; }
.badge { font-size: 10px; font-weight: 600; color: ${ACCENT}; margin-inline-start: 6px; white-space: nowrap; }
.who, .count { font-size: 10px; opacity: .6; margin-inline-start: 6px; white-space: nowrap; }
a { color: ${LINK}; }
.note { padding-inline-start: 14px; opacity: .6; white-space: pre-line; }
.act { padding-inline-start: 14px; }
.act code { font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-all; opacity: .8; }
.act button { margin-inline-start: 4px; opacity: .6; }
.status { opacity: .6; margin: 0; }
`;
const Base = typeof HTMLElement === "undefined" ? class {} : HTMLElement;
const el = (tag, cls, text) => {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text !== void 0) e.textContent = text;
	return e;
};
const keyOf = (path, title) => [...path, title].join("\0");
const fill = (s, n) => s.replace("{n}", String(n));
const who = (a, t) => a ? `@${a.type === "human" ? t.you : a.name}` : "";
/** The title as text, with its links (PR refs, URLs) as anchors. */
function titleNodes(n) {
	const out = [];
	let rest = n.title;
	for (const l of n.links) {
		const at = rest.indexOf(l.text);
		if (at < 0) continue;
		out.push(document.createTextNode(rest.slice(0, at)));
		const a = el("a", void 0, l.text);
		a.href = l.url;
		a.target = "_blank";
		a.rel = "noreferrer";
		a.addEventListener("click", (e) => e.stopPropagation());
		out.push(a);
		rest = rest.slice(at + l.text.length);
	}
	out.push(document.createTextNode(rest));
	return out;
}
function marks(f, t) {
	const m = /* @__PURE__ */ new Map();
	const put = (e, mark) => e && m.set(keyOf(e.path, e.title), mark);
	put(f.done, {
		glyph: "✓",
		color: INK.done,
		label: t.lastDone
	});
	put(f.next, {
		glyph: "›",
		color: INK.open,
		label: t.upNext
	});
	put(f.doing, {
		glyph: "▶",
		color: f.doing?.node.needsOwner ? ACCENT : INK.doing,
		label: t.nowDoing
	});
	return m;
}
/** The read-only outline element. Properties in; `onBack` adds a back control. */
var StateTreeElement = class extends Base {
	static observedAttributes = ["src", "progress"];
	/** Set: a ‹ control in the header calls it (the chat box's tree view). */
	onBack;
	repo;
	locale;
	strings = {};
	storageKey = NEEDS_ME_KEY;
	_source;
	_progress;
	_root = null;
	live = false;
	error = "";
	stop;
	collapsed = /* @__PURE__ */ new Set();
	shadow;
	/** The data: a URL, a function returning markdown or nodes, or a feed. (Re)loads it. */
	set source(v) {
		this._source = v;
		this.reload();
	}
	get source() {
		return this._source;
	}
	/**
	* Live progress over the source: a progress hub's reader socket URL
	* (attribute `progress`) or a ProgressFeed. (Re)loads.
	*/
	set progress(v) {
		this._progress = v || void 0;
		this.reload();
	}
	get progress() {
		return this._progress;
	}
	/** Set the parsed tree directly (parseTreeDoc's root). */
	set root(v) {
		this._root = v;
		this.render();
	}
	get root() {
		return this._root;
	}
	attributeChangedCallback(n, _o, v) {
		if (n === "progress") this.progress = v ?? void 0;
		else if (v) this.source = v;
	}
	/** Load the source again (the chat box calls this each time its menu opens). */
	reload() {
		this.stop?.();
		this.stop = void 0;
		if (!this._source || !this.isConnected) return;
		this.stop = watchTree(this._progress ? liveTreeSource({
			base: this._source,
			progress: this._progress,
			repo: this.repo
		}) : this._source, { repo: this.repo }, (r, live) => {
			this._root = r;
			this.live = live;
			this.error = "";
			this.render();
		}, (e) => {
			this.error = e instanceof Error ? e.message : String(e);
			this.render();
		});
	}
	connectedCallback() {
		if (!this.shadow) {
			this.shadow = this.attachShadow({ mode: "open" });
			try {
				const sheet = new CSSStyleSheet();
				sheet.replaceSync(CSS);
				this.shadow.adoptedStyleSheets = [sheet];
			} catch {
				const s = el("style");
				s.textContent = CSS;
				this.shadow.append(s);
			}
		}
		this.reload();
		this.render();
	}
	disconnectedCallback() {
		this.stop?.();
		this.stop = void 0;
	}
	get t() {
		return {
			...TREE_STRINGS_EN,
			...this.strings
		};
	}
	get needsMe() {
		try {
			return localStorage.getItem(this.storageKey) === "1";
		} catch {
			return false;
		}
	}
	render() {
		const r = this.shadow;
		if (!r) return;
		const t = this.t;
		r.replaceChildren(...Array.from(r.querySelectorAll("style")));
		const head = el("div", "head");
		if (this.onBack) {
			const back = el("button", "hit", "‹");
			back.type = "button";
			back.setAttribute("aria-label", t.back);
			back.addEventListener("click", () => this.onBack?.());
			head.append(back);
		}
		const grow = el("span", "grow", t.tree);
		if (this.live) {
			const dot = el("span", "dot");
			dot.title = t.live;
			dot.setAttribute("role", "img");
			dot.setAttribute("aria-label", t.live);
			grow.append(dot);
		}
		const doc = this._root;
		const total = doc ? countOpen(doc).needsOwner : 0;
		const needs = el("button", "needs hit", `⚑ ${t.needsMe}${total ? ` · ${total}` : ""}`);
		needs.type = "button";
		needs.setAttribute("aria-pressed", String(this.needsMe));
		needs.addEventListener("click", () => {
			try {
				localStorage.setItem(this.storageKey, this.needsMe ? "0" : "1");
			} catch {}
			this.render();
		});
		head.append(grow, needs);
		r.append(head);
		if (this.error || !doc) {
			r.append(el("p", "status", this.error ? `${t.failed} (${this.error})` : t.loading));
			return;
		}
		const shown = this.needsMe ? filterNeedsOwner(doc.children) : doc.children;
		if (!shown.length) {
			r.append(el("p", "status", this.needsMe ? t.nothingNeedsYou : t.empty));
			return;
		}
		const m = marks(frontier(doc, { locale: this.locale }), t);
		r.append(this.list(shown, "", [], 0, m, void 0));
	}
	list(nodes, base, titles, depth, m, parentWho) {
		const t = this.t;
		const ul = el("ul");
		nodes.forEach((n, i) => {
			const path = base ? `${base}.${i}` : String(i);
			const branch = n.children.length > 0;
			const shut = branch && this.collapsed.has(path);
			const mark = m.get(keyOf(titles, n.title));
			const li = el("li");
			li.dataset.status = n.status ?? "";
			if (depth === 0 && !n.status && branch) li.classList.add("heading");
			if (n.status === "done") li.classList.add("done");
			if (mark) li.classList.add("marked");
			const line = el("div", `line${branch ? " branch" : ""}`);
			line.append(el("span", `chev${shut || !branch ? "" : " open"}`, branch ? "›" : ""));
			if (n.status) {
				const g = el("span", void 0, GLYPH[n.status]);
				g.style.color = INK[n.status];
				g.setAttribute("aria-label", n.status);
				line.append(g);
			}
			const text = el("span", "text");
			if (mark) {
				const s = el("span", "mark", mark.glyph);
				s.style.color = mark.color;
				s.title = mark.label;
				text.append(s);
			}
			text.append(...titleNodes(n));
			if (n.needsOwner && n.status !== "done") text.append(el("span", "badge", `⚑ ${t.needsYou}`));
			else if (n.assignee && n.assignee !== parentWho) text.append(el("span", "who", who(n.assignee, t)));
			if (shut) {
				const c = countOpen(n);
				if (c.open) text.append(el("span", "count", fill(t.openCount, c.open)));
				if (c.needsOwner) text.append(el("span", "badge", `⚑ ${fill(t.needsYouCount, c.needsOwner)}`));
			}
			line.append(text);
			if (branch) {
				line.setAttribute("role", "button");
				line.tabIndex = 0;
				line.setAttribute("aria-expanded", String(!shut));
				const toggle = () => {
					if (!this.collapsed.delete(path)) this.collapsed.add(path);
					this.render();
				};
				line.addEventListener("click", toggle);
				line.addEventListener("keydown", (e) => {
					if (e.key !== "Enter" && e.key !== " ") return;
					e.preventDefault();
					toggle();
				});
			}
			li.append(line);
			if (n.note) li.append(el("p", "note", n.note));
			for (const a of n.action?.split("\n") ?? []) {
				const row = el("div", "act");
				row.append(el("code", void 0, a));
				const copy = el("button", "hit", "⧉");
				copy.type = "button";
				copy.setAttribute("aria-label", `${t.copy}: ${a}`);
				copy.addEventListener("click", () => {
					navigator.clipboard?.writeText(a).then(() => {
						copy.textContent = "✓";
						copy.setAttribute("aria-label", t.copied);
						setTimeout(() => copy.textContent = "⧉", 1500);
					}, () => {});
				});
				row.append(copy);
				li.append(row);
			}
			if (branch && !shut) li.append(this.list(n.children, path, n.title ? [...titles, n.title] : titles, depth + 1, m, n.assignee));
			ul.append(li);
		});
		return ul;
	}
};
/**
* The frontier in three lines — ✓ the most recently done, ▶ in progress, ›
* next — each a ≈ summary (several items) or one item with its context. A
* group shows 〔N〕 and lists its items on tap. Plain DOM, text only.
*/
function frontierLines(root, opts = {}) {
	const t = {
		...TREE_STRINGS_EN,
		...opts.strings
	};
	const f = frontier(root, { locale: opts.locale });
	const box = el("div", "liagent-frontier");
	const rows = [
		[
			"done",
			"✓",
			INK.done,
			t.lastDone
		],
		[
			"doing",
			"▶",
			f.doing?.node.needsOwner ? ACCENT : INK.doing,
			t.nowDoing
		],
		[
			"next",
			"›",
			INK.open,
			t.upNext
		]
	];
	for (const [key, glyph, color, label] of rows) {
		const e = f[key];
		if (!e) continue;
		const group = e.count > 1 && !!e.summary;
		const line = el(group ? "button" : "div");
		line.dataset.frontier = key;
		line.title = group ? label : crumbs([...e.path, e.title]);
		line.style.cssText = "display:flex;gap:4px;align-items:center;width:100%;font:inherit;color:inherit;background:none;border:0;padding:0;text-align:start;pointer-events:auto";
		const g = el("span", void 0, glyph);
		g.style.color = color;
		g.style.fontWeight = "700";
		g.setAttribute("aria-label", label);
		const text = el("span", void 0, group ? e.summary : [...e.path.slice(-1), e.title].join(" › "));
		text.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
		line.append(g, text);
		if (group) line.append(el("span", void 0, `〔${e.count}〕`));
		else if (e.assignee) line.append(el("span", void 0, who(e.assignee, t)));
		box.append(line);
		if (group) {
			const list = el("ul");
			list.hidden = true;
			list.style.cssText = "list-style:none;margin:0;padding:0 0 0 16px";
			for (const it of e.items) {
				const li = el("li", void 0, `${it.title}${it.assignee ? ` ${who(it.assignee, t)}` : ""}`);
				li.title = crumbs(it.path);
				list.append(li);
			}
			line.setAttribute("aria-expanded", "false");
			line.addEventListener("click", () => {
				list.hidden = !list.hidden;
				line.setAttribute("aria-expanded", String(!list.hidden));
			});
			box.append(list);
		}
	}
	return box;
}
/** Register the element (once) under `tag`. Returns the class. */
function defineStateTree(tag = "liagent-state-tree") {
	if (typeof customElements !== "undefined" && !customElements.get(tag)) customElements.define(tag, StateTreeElement);
	return StateTreeElement;
}

//#endregion
export { frontierLines as a, watchTree as c, browserWake as d, liveNote as f, progressSocketUrl as h, defineStateTree as i, FEED_MAX_DELAY_MS as l, progressFeed as m, StateTreeElement as n, liveTreeSource as o, overlayProgress as p, TREE_STRINGS_EN as r, loadTree as s, NEEDS_ME_KEY as t, GIVE_UP as u };
//# sourceMappingURL=tree-BrR7NwMf.js.map