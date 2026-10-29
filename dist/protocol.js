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
		const to = str(m.to, 320);
		return {
			ok: true,
			value: to ? {
				type: "say",
				text,
				to
			} : {
				type: "say",
				text
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
		error: "expected {\"type\":\"say\",\"text\":\"…\"} or {\"type\":\"eval\",\"code\":\"…\"}"
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
		return id && text ? {
			type: "chat",
			id,
			text
		} : null;
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

//#endregion
export { APPROVAL_MS, BUSY_AFTER_REPLY_MS, BUSY_MS, CHAT_HISTORY, CHAT_MS, EVAL_GRANT_MS, MAX_CHAT, MAX_CODE, MAX_LABEL, MAX_RESULT, PAGES_GONE_MS, PAGE_DEBOUNCE_MS, PENDING_MS, chatText, cleanLabel, compile, isPageId, matchesTarget, parseControllerMessage, parsePageMessage, pickLang, pickVoice, shortCode, summarize, trimHistory };
//# sourceMappingURL=protocol.js.map