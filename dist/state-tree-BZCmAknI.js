//#region src/state-tree.ts
/** Name of the human owner as an assignee token: `@owner`. */
const OWNER_NAME = "owner";
const TAB = "  ";
const ITEM = /^(\s*)[-*+]\s+(.*)$/;
const HEADING = /^##\s+(.*)$/;
const ACTION = /^(?:→|->)\s*(.*)$/;
const SUMMARY = /^≈([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)?)?\s+(.*)$/;
const BOX = /^\[([ xX~!])\]\s*/;
const OWNER = /\(!\)/g;
const ANY_ORDER = /\(any order\)/gi;
const DONE_AT = /\(done\s+(\d{4}-\d{2}-\d{2}(?:[T ][\d:]+)?)\)/i;
const ASSIGNEE = /(?:^|\s)@([A-Za-z0-9][\w.-]*)(?:#(\S*))?$/;
/** An agent's opaque id: nothing that could be a host, a pid with a colon, or a token. */
const AGENT_ID = /^[A-Za-z0-9_-]{1,40}$/;
const STATUS = {
	" ": "open",
	"~": "doing",
	"!": "blocked",
	x: "done",
	X: "done"
};
/** PR refs and URLs in `text`, in order, each once. */
function findLinks(text, opts = {}) {
	const host = (opts.host ?? "https://github.com").replace(/\/$/, "");
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	const add = (l) => {
		if (seen.has(l.url)) return;
		seen.add(l.url);
		out.push(l);
	};
	for (const m of text.matchAll(/(https?:\/\/[^\s)>\]]+)|(?<![\w/#])([A-Za-z0-9][\w.-]*\/[\w.-]+)#(\d+)\b|(?<![\w/&#])#(\d+)\b/g)) if (m[1]) {
		const url = m[1].replace(/[.,;:]+$/, "");
		add({
			text: url,
			url
		});
	} else if (m[2]) add({
		text: `${m[2]}#${m[3]}`,
		url: `${host}/${m[2]}/pull/${m[3]}`
	});
	else if (m[4] && opts.repo) add({
		text: `#${m[4]}`,
		url: `${host}/${opts.repo}/pull/${m[4]}`
	});
	return out;
}
const indentOf = (s) => s.replaceAll("	", TAB).length;
/** `@owner` is the human; anything else an agent. */
function assigneeOf(name, id) {
	if (name === OWNER_NAME) return {
		type: "human",
		name
	};
	return id && AGENT_ID.test(id) ? {
		type: "agent",
		name,
		id
	} : {
		type: "agent",
		name
	};
}
/** A node from an item's or a heading's text: box, markers, assignee, links. */
function node(raw, opts) {
	let text = raw.trim();
	let status;
	const box = BOX.exec(text);
	if (box) {
		status = STATUS[box[1]];
		text = text.slice(box[0].length);
	}
	const needsOwner = OWNER.test(text);
	OWNER.lastIndex = 0;
	if (needsOwner) text = text.replace(OWNER, " ");
	const unordered = ANY_ORDER.test(text);
	ANY_ORDER.lastIndex = 0;
	if (unordered) text = text.replace(ANY_ORDER, " ");
	const at = DONE_AT.exec(text);
	if (at) text = text.replace(at[0], " ");
	text = text.replace(/\s+/g, " ").trim();
	const who = ASSIGNEE.exec(text);
	if (who) text = text.slice(0, who.index).trim();
	const n = {
		title: text,
		links: findLinks(text, opts),
		children: []
	};
	if (status) {
		n.status = status;
		n.done = status === "done";
	}
	if (needsOwner) n.needsOwner = true;
	if (unordered) n.unordered = true;
	if (at) n.doneAt = at[1].replace(" ", "T");
	if (who) n.assignee = assigneeOf(who[1], who[2]);
	return n;
}
/** `done: 捷报频传 · doing: 多线并进 · next: 蓄势待发` */
function parseSummary(text) {
	const out = {};
	for (const part of text.split(/\s*[·|]\s*/)) {
		const m = /^(done|doing|next)\s*[:：]\s*(.+)$/i.exec(part.trim());
		if (m) out[m[1].toLowerCase()] = m[2].trim();
	}
	return out;
}
function addSummary(n, locale, text) {
	const s = parseSummary(text);
	if (!Object.keys(s).length) return;
	n.summaries ??= {};
	const key = (locale ?? "zh").toLowerCase();
	n.summaries[key] = {
		...n.summaries[key],
		...s
	};
}
/** Children without an assignee take the nearest ancestor's. */
function inherit(nodes, from) {
	for (const n of nodes) {
		if (!n.assignee && from) n.assignee = from;
		inherit(n.children, n.assignee);
	}
}
/**
* Parse the whole document into a root node (title "") whose children are the
* top-level nodes and whose summaries are the `≈` lines before the first `##`.
* Never throws: odd indentation nests under the nearest shallower item.
*/
function parseTreeDoc(md, opts = {}) {
	const root = {
		title: "",
		links: [],
		children: []
	};
	/** The open items, shallowest first, each with its indent. */
	let stack = [];
	/** The current `##` heading, if any: items at any indent go under it. */
	let heading = null;
	/** The item that continuation lines (→ actions, notes) belong to. */
	let last = null;
	const text = md.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?(?:-->|$)/g, "");
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const h = HEADING.exec(line);
		if (h) {
			heading = node(h[1], opts);
			root.children.push(heading);
			stack = [];
			last = {
				indent: -1,
				node: heading
			};
			continue;
		}
		if (/^#\s/.test(line)) {
			heading = null;
			stack = [];
			last = null;
			continue;
		}
		const it = ITEM.exec(line);
		if (it && !ACTION.test(it[2]) && !SUMMARY.test(it[2])) {
			const indent = indentOf(it[1]);
			const n = node(it[2], opts);
			while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
			(stack.length ? stack[stack.length - 1].node : heading ?? root).children.push(n);
			stack.push({
				indent,
				node: n
			});
			last = {
				indent,
				node: n
			};
			continue;
		}
		const indent = indentOf(/^\s*/.exec(line)[0]);
		const body = line.trim().replace(/^[-*+]\s+/, "");
		const sum = SUMMARY.exec(body);
		if (sum && !last && !root.children.length) {
			addSummary(root, sum[1], sum[2]);
			continue;
		}
		const a = ACTION.exec(body);
		const under = !!last && (last.indent < 0 || indent > last.indent);
		if (!under && (!heading || a)) continue;
		const target = under ? last.node : heading;
		if (sum) addSummary(target, sum[1], sum[2]);
		else if (a) {
			const act = a[1].trim();
			if (!act) continue;
			target.action = target.action ? `${target.action}\n${act}` : act;
			for (const l of findLinks(act, opts)) if (!target.links.some((x) => x.url === l.url)) target.links.push(l);
		} else target.note = target.note ? `${target.note} ${body}` : body;
	}
	inherit(root.children, root.assignee);
	return root;
}
/** The top-level nodes (parseTreeDoc's root children). */
function parseTree(md, opts = {}) {
	return parseTreeDoc(md, opts).children;
}
/** Open (not done) items below `n`, and those of them that wait on the owner. */
function countOpen(n) {
	let open = 0;
	let needsOwner = 0;
	for (const c of n.children) {
		if (c.done === false) {
			open++;
			if (c.needsOwner) needsOwner++;
		}
		const sub = countOpen(c);
		open += sub.open;
		needsOwner += sub.needsOwner;
	}
	return {
		open,
		needsOwner
	};
}
/**
* Only the open `(!)` items and their ancestors (the "Needs me" view). A
* matching item keeps only those of its children that match too.
*/
function filterNeedsOwner(nodes) {
	const out = [];
	for (const n of nodes) {
		const children = filterNeedsOwner(n.children);
		if (n.needsOwner && n.done !== true || children.length) out.push({
			...n,
			children
		});
	}
	return out;
}
/** `[~]` first, then not started, blocked, done: the order inside an `(any order)` parent. */
const RANK = {
	doing: 0,
	open: 1,
	blocked: 2,
	done: 3
};
const rank = (n) => n.status ? RANK[n.status] : 1;
/** Depth-first in work order, each with its breadcrumb and its ancestor nodes. */
function walk(root) {
	const out = [];
	const go = (n, chain) => {
		const kids = n.unordered ? n.children.map((c, i) => [c, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([c]) => c) : n.children;
		const next = [...chain, n];
		for (const c of kids) {
			if (c.status) {
				const path = next.map((x) => x.title).filter(Boolean);
				out.push({
					node: c,
					path,
					title: c.title,
					assignee: c.assignee,
					chain: next
				});
			}
			go(c, next);
		}
	};
	go(root, []);
	return out;
}
/** The summary list to try: the locale, its language, zh, en. */
function localeChain(locale) {
	const l = (locale ?? "").toLowerCase();
	return [...new Set([
		l,
		l.split("-")[0] ?? "",
		"zh",
		"en"
	].filter(Boolean))];
}
/** The deepest common ancestor of the group with a summary for `key`, in the first locale it has. */
function summaryFor(group, key, locales) {
	let common = group[0].chain;
	for (const g of group) {
		let i = 0;
		while (i < common.length && i < g.chain.length && common[i] === g.chain[i]) i++;
		common = common.slice(0, i);
	}
	for (let i = common.length - 1; i >= 0; i--) {
		const s = common[i].summaries;
		if (!s) continue;
		for (const l of locales) if (s[l]?.[key]) return s[l][key];
	}
}
/** The item without its ancestor nodes. */
function strip(w) {
	const it = {
		node: w.node,
		path: w.path,
		title: w.title
	};
	if (w.assignee) it.assignee = w.assignee;
	return it;
}
function entry(group, pick, key, locales) {
	const e = {
		...strip(pick),
		count: group.length,
		items: group.map(strip)
	};
	if (group.length > 1) {
		const s = summaryFor(group, key, locales);
		if (s) e.summary = s;
	}
	return e;
}
/**
* The three lines: ✓ the most recently done, ▶ in progress (an open `(!)`
* item before any `[~]`), › the next not yet started. Blocked items are on
* none of them, unless they wait on the owner.
*/
function frontier(input, opts = {}) {
	let root = Array.isArray(input) ? {
		title: "",
		links: [],
		children: input
	} : input;
	for (const t of opts.scope ?? []) {
		const hit = root.children.find((c) => c.title === t);
		if (!hit) return {};
		root = hit;
	}
	const locales = localeChain(opts.locale);
	const all = walk(root);
	const out = {};
	const done = all.filter((w) => w.node.status === "done");
	if (done.length) {
		const dated = done.filter((w) => w.node.doneAt);
		out.done = entry(done, dated.length ? dated.reduce((a, b) => b.node.doneAt >= a.node.doneAt ? b : a) : done[done.length - 1], "done", locales);
	}
	const doing = [...all.filter((w) => w.node.needsOwner && w.node.status !== "done"), ...all.filter((w) => w.node.status === "doing" && !w.node.needsOwner)];
	if (doing.length) out.doing = entry(doing, doing[0], "doing", locales);
	const next = all.filter((w) => w.node.status === "open" && !w.node.needsOwner);
	if (next.length) {
		const now = out.doing && !out.doing.node.needsOwner ? all.indexOf(doing[0]) : -1;
		out.next = entry(next, next.find((w) => all.indexOf(w) > now) ?? next[0], "next", locales);
	}
	return out;
}
/** `/words › Learning Partner` */
const crumbs = (path) => path.join(" › ");

//#endregion
export { filterNeedsOwner as a, localeChain as c, crumbs as i, parseTree as l, assigneeOf as n, findLinks as o, countOpen as r, frontier as s, OWNER_NAME as t, parseTreeDoc as u };
//# sourceMappingURL=state-tree-BZCmAknI.js.map