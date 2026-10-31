//#region src/protocol.ts
/** Largest `code` accepted, in characters. */
const MAX_CODE = 16 * 1024;
/** Largest result summary a page sends back, in characters. */
const MAX_RESULT = 4e3;
/** Largest page or controller label, in characters. */
const MAX_LABEL = 300;
/** How long the owner has to answer a pairing prompt. */
const PENDING_MS = 2 * 6e4;
/** How long a friend's preview approval (eval on their pages, one socket) lasts. */
const APPROVAL_MS = 60 * 6e4;
/**
* How long the user's eval approval lasts — and its resumable grant token: the
* agent reconnects with it (x-liagent-token) without a new prompt until then,
* or until End revokes it.
*/
const EVAL_GRANT_MS = 480 * 6e4;
/** How long "Allow chat" lasts — and its resumable grant token. */
const CHAT_MS = 720 * 60 * 6e4;
/** Largest chat message (owner's or agent's), in characters. */
const MAX_CHAT = 4e3;
/** Chat messages the hub keeps (and sends a page on connect). */
const CHAT_HISTORY = 200;
/** A page shows the spinner while the agent's last busy beat is younger than this. */
const BUSY_MS = 12e3;
/** A beat this soon after a reply is the tail of the work just answered: ignored. */
const BUSY_AFTER_REPLY_MS = 1500;
/**
* How long an eval grant outlives its pages: if every page it covers stays
* closed this long, the agent is told to pair again (4409). Shorter gaps —
* a phone app switch, a reload — keep the grant, since a tab keeps its page id.
*/
const PAGES_GONE_MS = 5 * 6e4;
/** A page id: the tab's own, kept in sessionStorage and sent on reconnect (?page=). */
const isPageId = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(v);
/** How long a page waits after client-side navigation before reporting it. */
const PAGE_DEBOUNCE_MS = 300;
/** How many times the agent may polish one voice line. */
const MAX_EDITS = 3;
/** A message updated by an EditedEvent; any other message is returned as is. */
function applyEdit(m, e) {
	if (m.id !== e.id || (m.thread ?? "owner") !== e.thread) return m;
	return {
		...m,
		text: e.text,
		raw: e.raw,
		edited: e.edited
	};
}
/**
* The draft after a transcript landed in it, if the whole draft is still
* dictation (the draft was empty, or is exactly what dictation left there);
* null once anything typed is in it.
*/
function dictatedDraft(prev, pure, next) {
	return !prev.trim() || prev === pure ? next : null;
}
/**
* A line's source as it is sent: "stt" when the draft is exactly what the
* mic left there (sent as heard, or unchanged); undefined when anything was
* typed or edited in it.
*/
function draftSource(draft, pure) {
	return pure !== null && draft === pure && !!draft.trim() ? "stt" : void 0;
}
const str = (v, max) => typeof v === "string" ? v.slice(0, max) : void 0;
function parse(raw) {
	if (typeof raw !== "string" || raw.length > MAX_CODE + 2048) return null;
	try {
		const v = JSON.parse(raw);
		return v && typeof v === "object" && !Array.isArray(v) ? v : null;
	} catch {
		return null;
	}
}
/** A chat message's text: trimmed, non-empty, at most MAX_CHAT characters; else undefined. */
function chatText(raw) {
	if (typeof raw !== "string") return void 0;
	const t = raw.trim();
	return t && t.length <= MAX_CHAT ? t : void 0;
}
/** Validate an agent's message; anything else is an error sent back to it. */
function parseControllerMessage(raw) {
	const m = parse(raw);
	if (m?.type === "say") {
		const text = chatText(m.text);
		if (!text) return {
			ok: false,
			error: `say needs text of 1–${MAX_CHAT} chars`
		};
		let to = str(m.to, 320)?.trim();
		let node;
		if (to?.startsWith("/") || typeof m.node === "string") {
			node = nodePath(typeof m.node === "string" ? m.node : to);
			if (!node) return {
				ok: false,
				error: `not a node path: ${String(m.node ?? to)}`
			};
			if (to?.startsWith("/")) to = void 0;
			if (node === ROOT_NODE) node = void 0;
		}
		const taskPath = m.taskPath === void 0 ? void 0 : nodePath(m.taskPath);
		if (m.taskPath !== void 0 && !taskPath) return {
			ok: false,
			error: `not a node path: ${String(m.taskPath)}`
		};
		const agentId = agentIdOf(m.agentId);
		const value = {
			type: "say",
			text
		};
		if (to) value.to = to;
		if (node) value.node = node;
		if (taskPath && taskPath !== ROOT_NODE) value.taskPath = taskPath;
		if (agentId) value.agentId = agentId;
		if (m.loud === true) value.loud = true;
		else if (m.quiet === true) value.quiet = true;
		return {
			ok: true,
			value
		};
	}
	if (m?.type === "edit") {
		const id = str(m.id, 64)?.trim();
		if (!id) return {
			ok: false,
			error: "edit needs the id of the message to polish"
		};
		const text = chatText(m.text);
		if (!text) return {
			ok: false,
			error: `edit needs text of 1–${MAX_CHAT} chars`
		};
		return {
			ok: true,
			value: {
				type: "edit",
				id,
				text
			}
		};
	}
	if (m?.type === "grant" || m?.type === "ungrant") {
		const from = nodePath(m.from);
		const to = nodePath(m.to);
		if (!from || !to) return {
			ok: false,
			error: `${m.type} needs node paths "from" and "to"`
		};
		if (m.type === "ungrant") return {
			ok: true,
			value: {
				type: "ungrant",
				from,
				to
			}
		};
		const ms = typeof m.ms === "number" && m.ms > 0 ? Math.min(m.ms, CHAT_MS) : void 0;
		return {
			ok: true,
			value: ms ? {
				type: "grant",
				from,
				to,
				ms
			} : {
				type: "grant",
				from,
				to
			}
		};
	}
	if (m?.type === "busy") {
		const to = str(m.to, 320);
		const value = { type: "busy" };
		if (to) value.to = to;
		if (m.on === false) value.on = false;
		return {
			ok: true,
			value
		};
	}
	if (!m || m.type !== "eval") return {
		ok: false,
		error: "expected {\"type\":\"say\",\"text\":\"…\"}, {\"type\":\"eval\",\"code\":\"…\"}, {\"type\":\"edit\",\"id\",\"text\"} or {\"type\":\"grant\",\"from\",\"to\"}"
	};
	if (typeof m.code !== "string" || !m.code.trim()) return {
		ok: false,
		error: "empty code"
	};
	if (m.code.length > MAX_CODE) return {
		ok: false,
		error: `code over ${MAX_CODE} chars`
	};
	const target = str(m.target, MAX_LABEL);
	return {
		ok: true,
		value: target ? {
			type: "eval",
			code: m.code,
			target
		} : {
			type: "eval",
			code: m.code
		}
	};
}
/** Validate a page's message; anything else is dropped. */
function parsePageMessage(raw) {
	const m = parse(raw);
	if (!m) return null;
	if (m.type === "allow") {
		const pair = str(m.pair, 64);
		if (!pair) return null;
		const out = {
			type: "allow",
			pair
		};
		if (m.pages === "all") out.pages = "all";
		else if (Array.isArray(m.pages)) out.pages = m.pages.filter((x) => typeof x === "string" && x.length > 0 && x.length <= 64).slice(0, 64);
		if (m.scope === "chat") out.scope = "chat";
		return out;
	}
	if (m.type === "page") {
		const label = typeof m.label === "string" ? m.label.slice(0, MAX_LABEL) : void 0;
		return label ? {
			type: "page",
			label
		} : null;
	}
	if (m.type === "end-page") {
		const id = str(m.id, 64);
		return id ? {
			type: "end-page",
			id
		} : null;
	}
	if (m.type === "deny" || m.type === "revoke") {
		const pair = str(m.pair, 64);
		return pair ? {
			type: m.type,
			pair
		} : null;
	}
	if (m.type === "chat") {
		const id = str(m.id, 64);
		const text = chatText(m.text);
		if (!id || !text) return null;
		const to = nodePath(m.to);
		const out = {
			type: "chat",
			id,
			text
		};
		if (to && to !== ROOT_NODE) out.to = to;
		if (m.source === "stt") out.source = "stt";
		return out;
	}
	if (m.type === "result") {
		const id = str(m.id, 64);
		const to = str(m.to, 64);
		if (!id || !to) return null;
		return {
			type: "result",
			id,
			to,
			ok: m.ok === true,
			value: str(m.value, MAX_RESULT + 64),
			error: str(m.error, 1e3),
			stack: str(m.stack, 2e3),
			ms: typeof m.ms === "number" ? m.ms : void 0
		};
	}
	return null;
}
/** The newest `max` messages, oldest first. */
function trimHistory(list, max = CHAT_HISTORY) {
	return list.length > max ? list.slice(list.length - max) : list;
}
/**
* The language to read a reply in, from its script alone: any kana is
* Japanese, Hangul Korean, other Han Chinese (zh-CN), and everything else
* English.
*/
function pickLang(text) {
	if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return "ja-JP";
	if (/\p{Script=Hangul}/u.test(text)) return "ko-KR";
	if (/\p{Script=Han}/u.test(text)) return "zh-CN";
	return "en-US";
}
/** An installed voice for `lang`: the exact locale first, then the same language. */
function pickVoice(voices, lang) {
	const norm = (l) => l.replace(/_/g, "-").toLowerCase();
	const want = norm(lang);
	const base = want.split("-")[0];
	const exact = voices.filter((v) => norm(v.lang) === want);
	const same = voices.filter((v) => norm(v.lang).split("-")[0] === base);
	const pool = exact.length ? exact : same;
	return pool.find((v) => v.default) ?? pool[0];
}
/** A label shown to the user: one line, printable, bounded. */
function cleanLabel(raw, max = MAX_LABEL) {
	return (raw ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}
/** The short code the CLI prints and the prompt shows, so the owner can match them. */
function shortCode(bytes) {
	return Array.from(bytes.slice(0, 2), (b) => b.toString(16).padStart(2, "0")).join("");
}
/** A page's label matches when there is no target, or it contains the target (any case). */
function matchesTarget(label, target) {
	if (!target) return true;
	return label.toLowerCase().includes(target.toLowerCase());
}
/**
* A JSON-serialisable summary of whatever the code returned, at most `max`
* characters: cycles, functions, DOM nodes, errors, Maps, Sets and BigInts
* become readable strings instead of throwing.
*/
function summarize(value, max = MAX_RESULT) {
	const seen = /* @__PURE__ */ new WeakSet();
	let out;
	try {
		out = JSON.stringify(value, (_key, v) => {
			if (typeof v === "bigint") return `${v}n`;
			if (typeof v === "function") return `[function ${v.name || "anonymous"}]`;
			if (typeof v === "symbol") return v.toString();
			if (v === void 0) return "[undefined]";
			if (v instanceof Error) return {
				name: v.name,
				message: v.message,
				stack: v.stack
			};
			if (typeof v === "object" && v !== null) {
				const node = v;
				if (typeof node.nodeType === "number") return typeof node.outerHTML === "string" ? node.outerHTML.slice(0, 500) : `[node ${String(node.nodeName)}]`;
				if (seen.has(v)) return "[circular]";
				seen.add(v);
				if (v instanceof Map) return { "[Map]": [...v.entries()] };
				if (v instanceof Set) return { "[Set]": [...v.values()] };
			}
			return v;
		});
	} catch (e) {
		out = `[unserialisable: ${e instanceof Error ? e.message : String(e)}]`;
	}
	out ??= "[undefined]";
	return out.length > max ? `${out.slice(0, max)}…[${out.length - max} more]` : out;
}
/**
* Compile `code` as an async function. An expression (`document.title`) is
* returned as is; anything else is a function body, so `return x` works and
* `await` is allowed in both.
*/
function compile(code) {
	try {
		return new Function(`return (async () => (\n${code}\n))();`);
	} catch (e) {
		if (!(e instanceof SyntaxError)) throw e;
		return new Function(`return (async () => {\n${code}\n})();`);
	}
}
/** Longest node path kept, in characters ("/words/prefetch"). */
const MAX_NODE_PATH = 80;
/** Longest assignee id kept (`agentId`), in characters. */
const MAX_AGENT_ID = 40;
/** The main thread's node: the root of the tree. */
const ROOT_NODE = "/";
/** One path segment: URL-safe characters only. */
const SEG = /^[A-Za-z0-9._~-]+$/;
/**
* A node path, normalised: trimmed, a leading "/", segments split on "/" or
* "›" (so "/words › prefetch" and "words/prefetch" are "/words/prefetch"),
* no empty, "." or ".." segment, at most MAX_NODE_PATH characters, path
* characters only. Anything else is undefined (never truncated: a cut path
* would name another node).
*/
function nodePath(raw) {
	if (typeof raw !== "string") return void 0;
	const s = raw.trim();
	if (!s || s.length > MAX_NODE_PATH * 2) return void 0;
	const segs = s.split(/\s*[/›]\s*/).filter(Boolean);
	if (segs.some((x) => !SEG.test(x) || x === "." || x === "..")) return void 0;
	const out = `/${segs.join("/")}`;
	return out.length <= MAX_NODE_PATH ? out : void 0;
}
/** An assignee id: trimmed, cut to MAX_AGENT_ID, letters, digits and ._@:+- or spaces only. */
function agentIdOf(raw) {
	if (typeof raw !== "string") return void 0;
	const s = raw.trim().slice(0, MAX_AGENT_ID).trim();
	return /^[\w.@:+ -]+$/.test(s) ? s : void 0;
}
/** `p` is `root` or below it. Both are normalised node paths. */
function isWithin(p, root) {
	return root === ROOT_NODE || p === root || p.startsWith(`${root}/`);
}
/** The deepest node both paths are within. */
function commonAncestor(a, b) {
	const x = a.split("/").filter(Boolean);
	const y = b.split("/").filter(Boolean);
	const out = [];
	for (let i = 0; i < Math.min(x.length, y.length) && x[i] === y[i]; i++) out.push(x[i] ?? "");
	return `/${out.join("/")}`;
}
/** How a node path reads in the chat: "/words › prefetch" ("/" stays "/"). */
function pathLabel(p) {
	const segs = p.split("/").filter(Boolean);
	return segs.length ? `/${segs.join(" › ")}` : ROOT_NODE;
}
/**
* Whether a listener at node `listener` gets a message addressed to `to`
* (both absent = the root, the main thread, as before node paths):
* "direct" when it is that node, "observed" when it is an ancestor (the
* root observes everything), null otherwise (a sibling or a descendant).
*/
function routeTo(listener, to) {
	const l = listener ?? ROOT_NODE;
	const p = to ?? ROOT_NODE;
	if (l === p) return "direct";
	return isWithin(p, l) ? "observed" : null;
}
/**
* May a sender at node `from` address node `to`? Always into its own
* subtree, always upward (its parent, any ancestor, the root), else only
* under a live grant covering both. The error names the common ancestor,
* whose listener (or the root's) may grant it.
*/
function mayAddress(from, to, grants = [], now = Date.now()) {
	if (isWithin(to, from)) return {
		ok: true,
		via: "subtree"
	};
	if (isWithin(from, to)) return {
		ok: true,
		via: "upward"
	};
	if (grants.some((g) => g.until > now && isWithin(from, g.from) && isWithin(to, g.to))) return {
		ok: true,
		via: "grant"
	};
	return {
		ok: false,
		error: `out of scope: needs a grant from ${commonAncestor(from, to)}`
	};
}
/** A leading "@<node path> " in a draft: the node it addresses and the text after it. */
const ADDRESS = /^@(\/?(?:[A-Za-z0-9._~-]+(?:(?:\/|\s*›\s*)[A-Za-z0-9._~-]+)*)?\/?)(?:\s+([\s\S]*))?$/;
/**
* A draft that starts with "@/words › prefetch " (or "@/words/prefetch ")
* addresses that node: `to` and the rest of the text. `complete` is false
* while the address is still being typed (no space after it yet). Null when
* the draft is not an address.
*/
function parseAddress(draft) {
	if (!draft.startsWith("@/")) return null;
	const m = ADDRESS.exec(draft);
	if (!m) return null;
	const to = nodePath(m[1] || ROOT_NODE);
	if (!to) return null;
	if (m[2] === void 0 || m[2].startsWith("›")) return {
		to,
		text: "",
		complete: false
	};
	return {
		to,
		text: m[2].trim(),
		complete: true
	};
}
/** The node paths offered while typing "@/…": those starting with what is typed, shortest first. */
function completeNode(partial, nodes) {
	const typed = partial.replace(/^@/, "").replace(/\s*›\s*/g, "/").trim().toLowerCase();
	return [...new Set(nodes)].filter((n) => n !== ROOT_NODE && n.toLowerCase().startsWith(typed || "/")).sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, 8);
}
/** A node's hue (0–359), from its path: the log line's left border. */
function nodeHue(p) {
	let h = 2166136261;
	const s = `node:${p}`;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0) % 360;
}
/**
* What a log line shows about nodes: the node it belongs to (an agent's
* `taskPath`, else the owner's target `to`), the muted subtitle ("/words ›
* prefetch", "→ /words › prefetch", or "/a › b → /c" for agent→agent), and
* its left-border colour. Nothing for a main-thread line without a node.
*/
function lineNode(m) {
	const from = m.from === "agent" && m.taskPath && m.taskPath !== ROOT_NODE ? m.taskPath : "";
	const to = m.to && m.to !== ROOT_NODE ? m.to : "";
	if (!from && !to) return null;
	const subtitle = from ? to ? `${pathLabel(from)} → ${pathLabel(to)}` : pathLabel(from) : `→ ${pathLabel(to)}`;
	const node = from || to;
	return {
		node,
		subtitle,
		border: `oklch(0.7 0.09 ${nodeHue(node)})`
	};
}

//#endregion
export { APPROVAL_MS, BUSY_AFTER_REPLY_MS, BUSY_MS, CHAT_HISTORY, CHAT_MS, EVAL_GRANT_MS, MAX_AGENT_ID, MAX_CHAT, MAX_CODE, MAX_EDITS, MAX_LABEL, MAX_NODE_PATH, MAX_RESULT, PAGES_GONE_MS, PAGE_DEBOUNCE_MS, PENDING_MS, ROOT_NODE, agentIdOf, applyEdit, chatText, cleanLabel, commonAncestor, compile, completeNode, dictatedDraft, draftSource, isPageId, isWithin, lineNode, matchesTarget, mayAddress, nodeHue, nodePath, parseAddress, parseControllerMessage, parsePageMessage, pathLabel, pickLang, pickVoice, routeTo, shortCode, summarize, trimHistory };
//# sourceMappingURL=protocol.js.map