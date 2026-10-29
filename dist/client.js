import { PAGE_DEBOUNCE_MS, compile, summarize, trimHistory } from "./protocol.js";

//#region src/client.ts
/** Hidden this long before the socket is dropped. */
const IDLE_MS = 3e4;
/** How long the eval icon pulses after code ran. */
const RAN_MS = 4e3;
/** This tab's page id, kept for the tab's life so a reconnect keeps its grants. */
const PAGE_KEY = "liagent:page";
const readPageId = () => {
	try {
		return sessionStorage.getItem(PAGE_KEY) ?? "";
	} catch {
		return "";
	}
};
const savePageId = (id) => {
	try {
		if (id) sessionStorage.setItem(PAGE_KEY, id);
	} catch {}
};
function socketUrl(url, label) {
	const u = new URL(url, location.href);
	if (u.protocol === "http:") u.protocol = "ws:";
	if (u.protocol === "https:") u.protocol = "wss:";
	u.searchParams.set("label", label);
	const page = readPageId();
	if (page) u.searchParams.set("page", page);
	return u.toString();
}
function connectHub(box, opts) {
	let ws = null;
	let idle;
	let ran;
	let nav;
	const pageLabel = () => {
		if (typeof opts.label === "function") return opts.label();
		if (opts.label) return opts.label;
		const standalone = matchMedia?.("(display-mode: standalone)").matches ? "pwa " : "";
		return `${location.pathname} ${standalone}${navigator.userAgent}`;
	};
	let sentLabel = "";
	let closed = false;
	const opened = /* @__PURE__ */ new WeakSet();
	const wanted = () => !closed && document.visibilityState === "visible" && (opts.wanted?.() ?? true);
	const send = (sock, msg) => {
		if (!sock || sock.readyState !== WebSocket.OPEN) return false;
		try {
			sock.send(JSON.stringify(msg));
			return true;
		} catch {
			return false;
		}
	};
	const run = async (sock, id, to, code) => {
		clearTimeout(ran);
		box.evalRan = true;
		ran = setTimeout(() => box.evalRan = false, RAN_MS);
		const t0 = performance.now();
		let result;
		try {
			const value = await compile(code)();
			result = {
				ok: true,
				ms: Math.round(performance.now() - t0),
				value: summarize(value)
			};
		} catch (e) {
			const err = e instanceof Error ? e : new Error(String(e));
			result = {
				ok: false,
				error: `${err.name}: ${err.message}`.slice(0, 1e3),
				stack: (err.stack ?? "").slice(0, 2e3)
			};
		}
		opts.onEval?.({
			id,
			...result
		});
		send(sock, {
			type: "result",
			id,
			to,
			...result
		});
	};
	const reset = () => {
		box.live = false;
		box.pending = null;
		box.sessions = [];
		box.pages = [];
		box.busy = false;
	};
	const connect = () => {
		if (ws) return;
		const label = sentLabel = pageLabel();
		const sock = new WebSocket(socketUrl(opts.url, label));
		ws = sock;
		sock.onopen = () => {
			opened.add(sock);
			box.live = true;
		};
		sock.onmessage = (e) => {
			let msg;
			try {
				msg = JSON.parse(String(e.data));
			} catch {
				return;
			}
			switch (msg.type) {
				case "friend-status":
					box.friend = true;
					box.notice = msg.status === "blocked" ? "Chat is not available for this account." : "";
					return;
				case "rate-limited":
					box.warning = `Too many messages: that one was not sent. Try again in ${Math.max(1, Math.ceil(Number(msg.retryIn) / 6e4) || 1)} min.`;
					return;
				case "state": {
					const s = msg;
					box.pending = s.pending ?? null;
					box.sessions = Array.isArray(s.sessions) ? s.sessions : [];
					box.listeners = s.listeners ?? box.sessions.length;
					box.pages = Array.isArray(s.pages) ? s.pages : [];
					const self = typeof s.self === "string" ? s.self : "";
					box.self = self;
					savePageId(self);
					return;
				}
				case "busy":
					box.beat();
					return;
				case "history":
					if (Array.isArray(msg.messages)) box.messages = trimHistory(msg.messages);
					return;
				case "chat": {
					const m = msg.message;
					if (!m || typeof m !== "object") return;
					box.push(m);
					if (m.from !== "agent") box.warning = "";
					return;
				}
				case "eval":
					if (!opts.evalCode) return;
					if (typeof msg.id !== "string" || typeof msg.to !== "string") return;
					if (typeof msg.code !== "string") return;
					run(sock, msg.id, msg.to, msg.code);
					return;
			}
		};
		sock.onclose = (e) => {
			if (ws !== sock) return;
			ws = null;
			reset();
			if (opened.has(sock) && e.code < 4e3 && wanted()) connect();
		};
	};
	const disconnect = () => {
		clearTimeout(idle);
		const sock = ws;
		ws = null;
		reset();
		sock?.close();
	};
	const update = () => {
		clearTimeout(idle);
		if (wanted()) connect();
		else if (closed || !(opts.wanted?.() ?? true)) disconnect();
		else if (ws) idle = setTimeout(disconnect, IDLE_MS);
	};
	box.onSend = (text) => send(ws, {
		type: "chat",
		id: crypto.randomUUID().slice(0, 12),
		text
	});
	box.onAnswer = (type, p, answer) => void send(ws, type === "deny" ? {
		type,
		pair: p.pair
	} : {
		type,
		pair: p.pair,
		...answer.pages ? { pages: answer.pages } : {},
		...answer.scope ? { scope: answer.scope } : {}
	});
	box.onEnd = (p) => void send(ws, {
		type: "revoke",
		pair: p.pair
	});
	box.onEndPage = (id) => void send(ws, {
		type: "end-page",
		id
	});
	const navigated = () => {
		clearTimeout(nav);
		nav = setTimeout(() => {
			const label = pageLabel();
			if (label === sentLabel) return;
			if (send(ws, {
				type: "page",
				label
			})) sentLabel = label;
		}, PAGE_DEBOUNCE_MS);
	};
	const unhook = [];
	if (opts.trackPages !== false) {
		for (const k of ["pushState", "replaceState"]) {
			const orig = history[k];
			history[k] = function(...a) {
				const r = orig.apply(this, a);
				navigated();
				return r;
			};
			unhook.push(() => history[k] = orig);
		}
		addEventListener("popstate", navigated);
		unhook.push(() => removeEventListener("popstate", navigated));
	}
	document.addEventListener("visibilitychange", update);
	update();
	return {
		update,
		close() {
			closed = true;
			document.removeEventListener("visibilitychange", update);
			clearTimeout(ran);
			clearTimeout(nav);
			for (const u of unhook) u();
			disconnect();
		}
	};
}

//#endregion
export { IDLE_MS, connectHub };
//# sourceMappingURL=client.js.map