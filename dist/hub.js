import { APPROVAL_MS, CHAT_HISTORY, CHAT_MS, EVAL_GRANT_MS, MAX_LABEL, PAGES_GONE_MS, PENDING_MS, cleanLabel, isPageId, matchesTarget, parseControllerMessage, parsePageMessage, shortCode } from "./protocol.js";

//#region src/hub.ts
/** The owner's chat thread; every other thread is a friend's user id. */
const OWNER_THREAD = "owner";
/** A user id usable as a thread and a storage key: no separators, bounded. */
const isUserId = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) && v !== OWNER_THREAD;
/** Who a page is: set by routeChat() from the site's answer, never by the page. */
const IDENTITY_HEADERS = {
	user: "x-liagent-user",
	email: "x-liagent-email",
	owner: "x-liagent-owner"
};
/** The header an agent resumes its chat grant with. */
const TOKEN_HEADER = "x-liagent-token";
/** A sleeping eval grant's pair id in the pages' state: "g:" + the start of its hash. */
const DORMANT = "g:";
const dormantPair = (hash) => `${DORMANT}${hash.slice(0, 40)}`;
const att = (ws) => {
	try {
		return ws.deserializeAttachment() ?? null;
	} catch {
		return null;
	}
};
const send = (ws, msg) => {
	try {
		ws.send(JSON.stringify(msg));
	} catch {}
};
const close = (ws, code, reason) => {
	try {
		ws.close(code, reason);
	} catch {}
};
const info = ({ pair, code, label, at, until, scope, want, pages }) => until ? {
	pair,
	code,
	label,
	at,
	until,
	scope: scope ?? "eval",
	pages: pages ?? "all"
} : want ? {
	pair,
	code,
	label,
	at,
	scope: want
} : {
	pair,
	code,
	label,
	at
};
/** Whether a grant covers a page: "all" (or an older grant with no list), or by id. */
const covers = (pages, id) => pages === void 0 || pages === "all" || pages.includes(id);
const pageId = () => crypto.randomUUID().slice(0, 8);
const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const hashToken = async (token) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
const log = (o) => console.log(JSON.stringify(o));
/** Whose a socket is: a page's thread, or the audience a controller was paired for. */
const audience = (a) => a.role === "page" ? a.thread : a.forUser ?? OWNER_THREAD;
const threadKeys = (thread) => thread === OWNER_THREAD ? {
	seq: "seq",
	prefix: "msg:"
} : {
	seq: `t:${thread}:seq`,
	prefix: `t:${thread}:msg:`
};
const msgKey = (thread, seq) => `${threadKeys(thread).prefix}${String(seq).padStart(12, "0")}`;
const friendKey = (userId) => `friend:${userId}`;
/** After the user denies a pairing, that audience takes no new request for this long. */
const PAIR_COOLDOWN_MS = 6e4;
/**
* At most PAIR_MAX pairing requests per audience per PAIR_WINDOW_MS. A
* request waits up to PENDING_MS (2 min), so the window must be longer than
* PAIR_MAX of those, or re-knocking as each lapses would never hit the cap.
*/
const PAIR_MAX = 3;
const PAIR_WINDOW_MS = 15 * 6e4;
/** A friend's page may relabel at most once per this long; faster ones are dropped. */
const FRIEND_RELABEL_MS = 1e3;
/** A friend may hold at most this many page sockets at once. */
const FRIEND_MAX_PAGES = 8;
var ChatHub = class {
	opts = {
		eval: false,
		friendChatMax: 30,
		friendWindowMs: 10 * 6e4,
		logContent: false
	};
	/** `{head}` for a log line, only when the hub logs content. */
	head(text, n = 80) {
		return this.opts.logContent ? { head: text.slice(0, n) } : {};
	}
	constructor(ctx, _env, now = Date.now, opts = {}) {
		this.ctx = ctx;
		this.now = now;
		this.opts = {
			...this.opts,
			...stripUndefined(opts)
		};
	}
	/**
	* Every stored grant by hash: read once per instance (an evicted hub reads
	* it again), then kept in step with each write. Only the listing of
	* sleeping eval grants uses it; a resume always asks storage itself.
	*/
	grants;
	/**
	* Pairing requests per audience, to bound the prompts anyone can raise:
	* the window's start and count, and when the user last denied one. Kept in
	* memory (a hub woken from hibernation starts afresh): it only has to stop
	* a stream of prompts, and the knock stays synchronous.
	*/
	knocks = /* @__PURE__ */ new Map();
	/** Room for one more pairing request for `who`: false (and `ws` closed with 4429) if not. */
	knockAllowed(ws, who) {
		const t = this.now();
		let k = this.knocks.get(who) ?? {
			start: t,
			count: 0
		};
		if (k.deniedAt && t - k.deniedAt < PAIR_COOLDOWN_MS) {
			send(ws, {
				type: "error",
				error: "a pairing was just denied: try again in a minute"
			});
			close(ws, 4429, "pairing cooling down");
			return false;
		}
		if (t - k.start >= PAIR_WINDOW_MS) k = {
			start: t,
			count: 0,
			deniedAt: k.deniedAt
		};
		if (k.count >= PAIR_MAX) {
			send(ws, {
				type: "error",
				error: "too many pairing requests: try again later"
			});
			close(ws, 4429, "pairing rate limit");
			return false;
		}
		this.knocks.set(who, {
			...k,
			count: k.count + 1
		});
		return true;
	}
	loadingGrants;
	loadGrants() {
		if (this.grants) return Promise.resolve();
		this.loadingGrants ??= this.ctx.storage.list({ prefix: "grant:" }).then((m) => {
			this.grants = new Map([...m].map(([k, g]) => [k.slice(6), g]));
			this.loadingGrants = void 0;
		});
		return this.loadingGrants;
	}
	async putGrant(hash, g) {
		await this.loadGrants();
		await this.ctx.storage.put(`grant:${hash}`, g);
		this.grants?.set(hash, g);
	}
	async dropGrant(hash) {
		await this.loadGrants();
		await this.ctx.storage.delete(`grant:${hash}`);
		this.grants?.delete(hash);
	}
	/** Open sockets of one role, optionally leaving one out (the one closing). */
	sockets(role, except) {
		const out = [];
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === except || ws.readyState !== void 0 && ws.readyState > 1) continue;
			const a = att(ws);
			if (a?.role === role) out.push({
				ws,
				a
			});
		}
		return out;
	}
	pages(thread, except) {
		return this.sockets("page", except).filter((p) => p.a.thread === thread);
	}
	/**
	* Owner-approved agents still in time. They hear every thread and may `say`
	* to any. A pairing made for a friend is not one.
	*/
	listeners(except) {
		const t = this.now();
		return this.sockets("controller", except).filter((c) => !c.a.forUser && c.a.until && c.a.until > t);
	}
	/** What one audience's pages see: its pairings, how many agents listen, its pages. */
	state(who, except, self = "") {
		const t = this.now();
		let pending = null;
		const sessions = [];
		const held = /* @__PURE__ */ new Set();
		for (const { a } of this.sockets("controller", except)) {
			if (a.grant) held.add(a.grant);
			if (audience(a) !== who) continue;
			if (a.until) {
				if (a.until > t) sessions.push(info(a));
			} else if (t - a.at < PENDING_MS) pending = info(a);
		}
		if (who === OWNER_THREAD) {
			for (const [hash, g] of this.grants ?? []) if (g.scope === "eval" && g.until > t && !held.has(hash)) sessions.push({
				pair: dormantPair(hash),
				code: "idle",
				label: g.label,
				at: g.at ?? 0,
				until: g.until,
				scope: "eval",
				pages: g.pages ?? "all"
			});
		}
		const pages = this.pages(who, except).map(({ a }) => ({
			id: a.id,
			label: a.label,
			at: a.at
		}));
		return {
			type: "state",
			pending,
			sessions,
			listeners: this.listeners(except).length,
			pages,
			self
		};
	}
	/** Send every page its audience's state; `skip` is left out of the sending only. */
	broadcast(except, skip) {
		const by = /* @__PURE__ */ new Map();
		for (const { ws, a } of this.sockets("page", except)) {
			if (ws === skip) continue;
			let s = by.get(a.thread);
			if (!s) by.set(a.thread, s = this.state(a.thread, except));
			send(ws, {
				...s,
				self: a.id
			});
		}
	}
	controller(pair) {
		return this.sockets("controller").find((c) => c.a.pair === pair);
	}
	/** One thread's kept chat, oldest first. */
	async history(thread = OWNER_THREAD) {
		return [...(await this.ctx.storage.list({
			prefix: threadKeys(thread).prefix,
			reverse: true,
			limit: CHAT_HISTORY
		})).values()].reverse().map((x) => ({
			thread,
			...x
		}));
	}
	/**
	* Keep one message (dropping its thread's oldest past CHAT_HISTORY) and send
	* it on. An agent's reply in the owner's thread goes live only to the pages
	* of its grant (`only`); every page still gets it in its history.
	*/
	async post(m, only) {
		const { seq: seqKey } = threadKeys(m.thread);
		const seq = (await this.ctx.storage.get(seqKey) ?? 0) + 1;
		await this.ctx.storage.put(seqKey, seq);
		await this.ctx.storage.put(msgKey(m.thread, seq), m);
		if (seq > CHAT_HISTORY) await this.ctx.storage.delete(msgKey(m.thread, seq - CHAT_HISTORY));
		const out = {
			type: "chat",
			message: m
		};
		for (const { ws, a } of this.pages(m.thread)) if (covers(only, a.id)) send(ws, out);
		for (const { ws } of this.listeners()) send(ws, out);
	}
	/** Everyone who has used the chat, most recent first. */
	async friends() {
		return [...(await this.ctx.storage.list({ prefix: "friend:" })).entries()].map(([k, v]) => ({
			userId: k.slice(7),
			...v
		})).sort((a, b) => b.lastAt - a.lastAt);
	}
	/** A friend by user id or (any case) email. */
	async findFriend(key) {
		if (isUserId(key)) {
			const rec = await this.ctx.storage.get(friendKey(key));
			if (rec) return {
				userId: key,
				...rec
			};
		}
		const want = key.trim().toLowerCase();
		return (await this.friends()).find((f) => f.email.toLowerCase() === want);
	}
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname.startsWith("/internal/friends")) return this.friendsApi(req, url);
		const control = url.pathname.endsWith("/control");
		let who;
		if (!control) {
			const h = req.headers;
			const userId = h.get(IDENTITY_HEADERS.user) ?? "";
			const owner = h.get(IDENTITY_HEADERS.owner) === "1";
			if (!owner && !isUserId(userId)) return new Response("forbidden", { status: 403 });
			who = {
				userId,
				email: h.get(IDENTITY_HEADERS.email) ?? "",
				owner
			};
		}
		const pair = new WebSocketPair();
		const ws = pair[1];
		this.ctx.acceptWebSocket(ws);
		if (control) await this.connectController(ws, url, req.headers.get(TOKEN_HEADER));
		else await this.connectPage(ws, url, who);
		return new Response(null, {
			status: 101,
			webSocket: pair[0]
		});
	}
	/**
	* The owner's friends API — route it only from an owner-only path of your
	* own (routeChat never does):
	*   GET  /internal/friends                → {friends}
	*   GET  /internal/friends/thread?user=id → {messages}
	*   POST /internal/friends {userId, action: "block" | "unblock"}
	*/
	async friendsApi(req, url) {
		if (req.method === "GET" && url.pathname.endsWith("/thread")) {
			const user = url.searchParams.get("user");
			if (!isUserId(user)) return Response.json({ error: "bad user" }, { status: 400 });
			return Response.json({ messages: await this.history(user) });
		}
		if (req.method === "GET") return Response.json({ friends: await this.friends() });
		if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
		let body;
		try {
			body = await req.json();
		} catch {
			return Response.json({ error: "bad json" }, { status: 400 });
		}
		if (!isUserId(body.userId) || body.action !== "block" && body.action !== "unblock") return Response.json({ error: "expected {userId, action: block|unblock}" }, { status: 400 });
		const rec = await this.block(body.userId, body.action === "block");
		if (!rec) return Response.json({ error: "no such chat user" }, { status: 404 });
		return Response.json({
			ok: true,
			friend: {
				userId: body.userId,
				...rec
			}
		});
	}
	/** Block (or unblock) a friend: blocking closes their pages and every pairing made for them. */
	async block(userId, blocked) {
		const rec = await this.ctx.storage.get(friendKey(userId));
		if (!rec) return null;
		const next = blocked ? {
			...rec,
			blocked: true,
			blockedAt: this.now()
		} : {
			...rec,
			blocked: false
		};
		await this.ctx.storage.put(friendKey(userId), next);
		log({
			msg: blocked ? "chat.block" : "chat.unblock",
			userId
		});
		if (!blocked) return next;
		for (const p of this.pages(userId)) {
			send(p.ws, {
				type: "friend-status",
				status: "blocked"
			});
			close(p.ws, 4403, "blocked");
		}
		for (const c of this.sockets("controller")) if (c.a.forUser === userId) {
			send(c.ws, { type: "revoked" });
			close(c.ws, 4401, "revoke");
		}
		this.broadcast();
		return next;
	}
	/**
	* A page joins: it gets its own thread's history and its audience's state.
	* A blocked friend is told and closed. With no identity (tests) it is the owner's.
	*/
	async connectPage(ws, url, who) {
		const label = cleanLabel(url.searchParams.get("label"), MAX_LABEL);
		const asked = url.searchParams.get("page");
		const id = isPageId(asked) && !this.sockets("page", ws).some((p) => p.a.id === asked) ? asked : pageId();
		if (who && !who.owner) {
			if (!isUserId(who.userId)) return close(ws, 4403, "no identity");
			if ((await this.ctx.storage.get(friendKey(who.userId)))?.blocked) {
				send(ws, {
					type: "friend-status",
					status: "blocked"
				});
				return close(ws, 4403, "blocked");
			}
			if (this.pages(who.userId, ws).length >= FRIEND_MAX_PAGES) {
				send(ws, {
					type: "error",
					error: "too many open pages"
				});
				return close(ws, 4429, "too many pages");
			}
			ws.serializeAttachment({
				role: "page",
				id,
				label,
				at: this.now(),
				thread: who.userId,
				email: cleanLabel(who.email, 320)
			});
			send(ws, {
				type: "friend-status",
				status: "open"
			});
		} else ws.serializeAttachment({
			role: "page",
			id,
			label,
			at: this.now(),
			thread: OWNER_THREAD
		});
		const a = att(ws);
		if (a.thread === OWNER_THREAD && !this.grants) this.loadGrants().then(() => this.grants?.size && this.broadcast());
		this.sweep();
		this.broadcast(void 0, ws);
		send(ws, this.state(a.thread, void 0, a.id));
		send(ws, {
			type: "history",
			messages: await this.history(a.thread)
		});
	}
	/**
	* An agent knocks. `?for=<email>` asks a friend's pages for an eval pairing
	* (owner grant and an eval hub only). With just a grant token it is back
	* in chat scope at once. Otherwise it waits for the owner: one pending
	* pairing per audience, and only with a page to ask.
	*/
	async connectController(ws, url, token) {
		const forKey = url.searchParams.get("for")?.trim();
		if (forKey) return this.pairForFriend(ws, url, forKey, token);
		if (token) return this.resume(ws, url, token);
		const label = cleanLabel(url.searchParams.get("label"), 80) || "unnamed agent";
		const sc = url.searchParams.get("scope");
		const want = sc === "chat" || sc === "eval" ? sc : void 0;
		if (want === "eval" && !this.opts.eval) {
			send(ws, {
				type: "error",
				error: "eval is not enabled on this hub"
			});
			return close(ws, 4403, "no eval");
		}
		if (!this.clearPending(ws, OWNER_THREAD)) return;
		if (this.pages(OWNER_THREAD, ws).length === 0) {
			send(ws, {
				type: "error",
				error: "no owner page is open to approve this"
			});
			return close(ws, 4404, "no page");
		}
		if (!this.knockAllowed(ws, OWNER_THREAD)) return;
		this.knock(ws, want ? {
			label,
			want
		} : { label });
	}
	/** Make room for one audience's pairing: false (and `ws` closed) if one is still waiting. */
	clearPending(ws, who) {
		const t = this.now();
		for (const c of this.sockets("controller", ws)) {
			if (c.a.until || audience(c.a) !== who) continue;
			if (t - c.a.at < PENDING_MS) {
				send(ws, {
					type: "error",
					error: "another pairing request is waiting for an answer"
				});
				close(ws, 4429, "pairing busy");
				return false;
			}
			send(c.ws, { type: "expired" });
			close(c.ws, 4408, "pairing expired");
		}
		return true;
	}
	knock(ws, extra) {
		const a = {
			role: "controller",
			pair: crypto.randomUUID(),
			code: shortCode(crypto.getRandomValues(new Uint8Array(2))),
			at: this.now(),
			...extra
		};
		ws.serializeAttachment(a);
		send(ws, {
			type: "pending",
			code: a.code,
			expiresIn: PENDING_MS,
			for: a.forEmail
		});
		log({
			msg: "chat.pair",
			pair: a.pair,
			code: a.code,
			label: a.label,
			for: a.forUser
		});
		this.broadcast();
	}
	/** The owner's live grant behind a token, or null (and a lapsed one deleted). */
	async liveGrant(token) {
		const hash = await hashToken(token.slice(0, 256));
		const g = await this.ctx.storage.get(`grant:${hash}`);
		if (g && g.until > this.now()) return {
			hash,
			g
		};
		if (g) await this.dropGrant(hash);
		return null;
	}
	/** An eval pairing on one friend's pages: the owner's agent asks, the friend answers. */
	async pairForFriend(ws, url, key, token) {
		if (!this.opts.eval) {
			send(ws, {
				type: "error",
				error: "eval is not enabled on this hub"
			});
			return close(ws, 4403, "no eval");
		}
		const live = token ? await this.liveGrant(token) : null;
		if (!live) {
			send(ws, {
				type: "error",
				error: "pairing with a friend needs the owner's chat grant"
			});
			return close(ws, 4498, "grant invalid");
		}
		const f = await this.findFriend(key);
		if (!f || f.blocked) {
			send(ws, {
				type: "error",
				error: `no chat user ${key} (or blocked)`
			});
			return close(ws, 4404, "no such friend");
		}
		if (!this.clearPending(ws, f.userId)) return;
		if (this.pages(f.userId, ws).length === 0) {
			send(ws, {
				type: "error",
				error: `no page of ${f.email} is open`
			});
			return close(ws, 4404, "no page");
		}
		if (!this.knockAllowed(ws, f.userId)) return;
		this.knock(ws, {
			label: cleanLabel(url.searchParams.get("label"), 80) || live.g.label,
			forUser: f.userId,
			forEmail: f.email,
			want: "eval"
		});
	}
	/** Reconnecting with a grant token: chat scope again, no prompt — or 4498 if it is not live. */
	async resume(ws, url, token) {
		const live = await this.liveGrant(token);
		if (!live) {
			send(ws, {
				type: "error",
				error: "grant is not valid (expired or ended)"
			});
			return close(ws, 4498, "grant invalid");
		}
		const { hash, g } = live;
		const scope = g.scope === "eval" && this.opts.eval ? "eval" : "chat";
		const pages = scope === "eval" ? g.pages ?? "all" : "all";
		const a = {
			role: "controller",
			pair: crypto.randomUUID(),
			code: shortCode(crypto.getRandomValues(new Uint8Array(2))),
			label: cleanLabel(url.searchParams.get("label"), 80) || g.label,
			at: this.now(),
			until: g.until,
			scope,
			grant: hash,
			pages
		};
		ws.serializeAttachment(a);
		send(ws, {
			type: "approved",
			until: g.until,
			scope,
			pages,
			resumed: true
		});
		send(ws, {
			type: "history",
			messages: await this.history()
		});
		log({
			msg: "chat.resume",
			pair: a.pair,
			label: a.label,
			scope
		});
		this.broadcast();
	}
	webSocketMessage(ws, raw) {
		this.sweep();
		const a = att(ws);
		if (a?.role === "page") return this.fromPage(ws, a, raw);
		if (a?.role === "controller") return this.fromController(ws, a, raw);
	}
	fromPage(ws, page, raw) {
		const m = parsePageMessage(raw);
		if (!m) return;
		const t = this.now();
		if (m.type === "chat") {
			log({
				msg: "chat.owner",
				page: page.label,
				thread: page.thread,
				len: m.text.length,
				...this.head(m.text)
			});
			if (page.thread !== OWNER_THREAD) return this.friendChat(ws, page, m.id, m.text);
			return this.post({
				id: m.id,
				from: "owner",
				label: page.label,
				text: m.text,
				at: t,
				thread: OWNER_THREAD
			});
		}
		if (m.type === "page") return this.relabel(ws, page, m.label);
		if (m.type === "end-page") {
			const target = this.pages(page.thread).find((p) => p.a.id === m.id);
			if (!target) return send(ws, this.state(page.thread, void 0, page.id));
			log({
				msg: "chat.end-page",
				id: m.id,
				label: target.a.label
			});
			close(target.ws, 4410, "page ended");
			return this.pageClosed(target.ws, target.a);
		}
		if ((m.type === "revoke" || m.type === "allow") && m.pair.startsWith(DORMANT)) {
			if (page.thread !== OWNER_THREAD) return send(ws, this.state(page.thread, void 0, page.id));
			return this.dormant(ws, page, m);
		}
		const c = this.controller(m.type === "result" ? m.to : m.pair);
		const mine = () => send(ws, this.state(page.thread, void 0, page.id));
		if (!c || audience(c.a) !== page.thread) return mine();
		if (m.type === "allow") {
			const pages = this.choosePages(page, m.pages);
			if (c.a.until) return c.a.until > t ? this.addPages(c.ws, c.a, pages) : mine();
			if (t - c.a.at >= PENDING_MS) return mine();
			if (c.a.forUser) return this.allowHour(c.ws, c.a, pages);
			return (c.a.want ? c.a.want === "chat" : m.scope === "chat") ? this.allowChat(c.ws, c.a, "all") : this.allowHour(c.ws, c.a, pages);
		}
		if (m.type === "deny" || m.type === "revoke") return this.end(m.type, c.ws, c.a);
		if (m.type !== "result" || !c.a.until || c.a.until <= t) return;
		const { type: _t, to: _to, ...rest } = m;
		send(c.ws, {
			type: "result",
			...rest,
			page: page.label
		});
	}
	/**
	* A friend's message: no approval needed, but a blocked friend is closed
	* and more than friendChatMax in a window is dropped (and the page told).
	* Their first ever message tells the agents ({type:"friend-new"}).
	*/
	async friendChat(ws, page, id, text) {
		const t = this.now();
		const userId = page.thread;
		const rec = await this.ctx.storage.get(friendKey(userId));
		if (rec?.blocked) {
			send(ws, {
				type: "friend-status",
				status: "blocked"
			});
			return close(ws, 4403, "blocked");
		}
		const rateKey = `rate:${userId}`;
		let rate = await this.ctx.storage.get(rateKey) ?? {
			start: t,
			count: 0
		};
		if (t - rate.start >= this.opts.friendWindowMs) rate = {
			start: t,
			count: 0
		};
		if (rate.count >= this.opts.friendChatMax) return send(ws, {
			type: "rate-limited",
			id,
			retryIn: rate.start + this.opts.friendWindowMs - t
		});
		await this.ctx.storage.put(rateKey, {
			start: rate.start,
			count: rate.count + 1
		});
		const email = rec?.email || page.email || "";
		await this.ctx.storage.put(friendKey(userId), {
			...rec ?? { firstSeen: t },
			email,
			lastAt: t,
			count: (rec?.count ?? 0) + 1
		});
		if (!rec) {
			log({
				msg: "chat.friend-new",
				userId
			});
			for (const l of this.listeners()) send(l.ws, {
				type: "friend-new",
				userId,
				email,
				at: t
			});
		}
		return this.post({
			id,
			from: "friend",
			label: page.label,
			text,
			at: t,
			thread: userId,
			email
		});
	}
	/** The pages an Allow names: live ones of the answering page's audience; by default that page. */
	choosePages(page, asked) {
		if (asked === "all") return "all";
		const live = new Set(this.pages(page.thread).map((p) => p.a.id));
		const ids = (asked ?? []).filter((id) => live.has(id));
		return ids.length ? [...new Set(ids)] : [page.id];
	}
	/** Whether any live page of `thread` is covered by `pages`. */
	anyCovered(thread, pages, except) {
		if (pages === void 0 || pages === "all") return true;
		return this.pages(thread, except).some((p) => covers(pages, p.a.id));
	}
	/** Add pages to an approved agent's grant: every socket of it, and the stored grant. */
	async addPages(ws, a, more) {
		const merged = (cur) => more === "all" || cur === void 0 || cur === "all" ? "all" : [...new Set([...cur, ...more])];
		const pages = merged(a.pages);
		for (const o of this.sockets("controller")) if (o.ws === ws || a.grant !== void 0 && o.a.grant === a.grant) {
			o.ws.serializeAttachment({
				...o.a,
				pages
			});
			send(o.ws, {
				type: "approved",
				until: o.a.until,
				scope: o.a.scope,
				pages,
				added: true
			});
		}
		if (a.grant) {
			const g = await this.ctx.storage.get(`grant:${a.grant}`);
			if (g) await this.putGrant(a.grant, {
				...g,
				pages
			});
		}
		log({
			msg: "chat.add-pages",
			pair: a.pair,
			pages
		});
		this.broadcast();
	}
	/** A page reports client-side navigation: relabel it, update the lists, tell the agents. */
	relabel(ws, page, raw) {
		const label = cleanLabel(raw, MAX_LABEL);
		if (!label || label === page.label) return;
		const t = this.now();
		const friend = page.thread !== OWNER_THREAD;
		if (friend && page.relabelAt !== void 0 && t - page.relabelAt < FRIEND_RELABEL_MS) return;
		ws.serializeAttachment({
			...page,
			label,
			...friend ? { relabelAt: t } : {}
		});
		const ev = {
			type: "page-changed",
			label,
			thread: page.thread,
			at: t
		};
		for (const l of this.listeners()) send(l.ws, ev);
		for (const c of this.sockets("controller")) if (c.a.forUser === page.thread && c.a.until) send(c.ws, ev);
		this.broadcast();
	}
	/** A page went away: update the lists, and start the clock on grants it was the last page of. */
	pageClosed(ws, _page) {
		const done = this.sweep(ws);
		this.broadcast(ws);
		return done;
	}
	/**
	* Grants whose pages are all closed: note when that began, forget it when
	* a page of theirs is back, and after PAGES_GONE_MS tell the agent to pair
	* again (4409) and drop the grant. Run on every event (no timers).
	*/
	sweep(except) {
		const t = this.now();
		for (const c of this.sockets("controller", except)) {
			const { pages } = c.a;
			if (!c.a.until || c.a.until <= t || pages === void 0 || pages === "all") continue;
			if (this.anyCovered(audience(c.a), pages, except)) {
				if (c.a.goneSince) c.ws.serializeAttachment({
					...c.a,
					goneSince: void 0
				});
				continue;
			}
			if (!c.a.goneSince) {
				c.ws.serializeAttachment({
					...c.a,
					goneSince: t
				});
				continue;
			}
			if (t - c.a.goneSince < PAGES_GONE_MS) continue;
			send(c.ws, {
				type: "error",
				error: c.a.grant ? "the pages this agent was allowed on are gone: this socket closes, but the grant stays; reconnect with its token when a page is back" : "the pages this agent was allowed on are gone: pair again"
			});
			close(c.ws, 4409, "pages gone");
		}
	}
	/** End (revoke) a sleeping eval grant, or add the answering page to it. */
	async dormant(ws, page, m) {
		await this.loadGrants();
		const prefix = m.pair.slice(2);
		const found = prefix.length === 40 ? [...this.grants ?? []].find(([h]) => h.startsWith(prefix)) : null;
		if (!found || found[1].scope !== "eval") return send(ws, this.state(page.thread, void 0, page.id));
		const [hash, g] = found;
		if (m.type === "revoke") {
			await this.dropGrant(hash);
			for (const c of this.sockets("controller")) if (c.a.grant === hash) {
				send(c.ws, { type: "revoked" });
				close(c.ws, 4401, "revoke");
			}
			log({
				msg: "chat.revoke",
				grant: "idle",
				label: g.label
			});
			return this.broadcast();
		}
		const more = this.choosePages(page, m.pages);
		const cur = g.pages ?? "all";
		const pages = more === "all" || cur === "all" ? "all" : [...new Set([...cur, ...more])];
		await this.putGrant(hash, {
			...g,
			pages
		});
		log({
			msg: "chat.add-pages",
			grant: "idle",
			pages
		});
		this.broadcast();
	}
	/**
	* Allow for code. The user's: eval and chat for EVAL_GRANT_MS, with a grant
	* token the agent resumes with (pages and all). A friend's preview: eval
	* only, for APPROVAL_MS, on this socket only — no token. On a hub without
	* eval, an older agent's "8h" answer is an hour of chat on this socket.
	*/
	async allowHour(ws, a, pages) {
		const t = this.now();
		if (a.forUser || !this.opts.eval) {
			const until = t + APPROVAL_MS;
			const scope = this.opts.eval ? "eval" : "chat";
			ws.serializeAttachment({
				...a,
				until,
				scope,
				pages
			});
			send(ws, {
				type: "approved",
				until,
				scope,
				pages,
				for: a.forEmail
			});
			log({
				msg: "chat.allow",
				pair: a.pair,
				label: a.label,
				until,
				scope,
				for: a.forUser
			});
			this.broadcast();
			if (a.forUser) return;
			return send(ws, {
				type: "history",
				messages: await this.history()
			});
		}
		const until = t + EVAL_GRANT_MS;
		const token = hex(crypto.getRandomValues(new Uint8Array(32)));
		const grant = await hashToken(token);
		await this.putGrant(grant, {
			label: a.label,
			until,
			scope: "eval",
			pages,
			at: t
		});
		ws.serializeAttachment({
			...a,
			until,
			scope: "eval",
			pages,
			grant
		});
		send(ws, {
			type: "approved",
			until,
			scope: "eval",
			pages,
			token
		});
		log({
			msg: "chat.allow",
			pair: a.pair,
			label: a.label,
			until,
			scope: "eval"
		});
		this.broadcast();
		send(ws, {
			type: "history",
			messages: await this.history()
		});
	}
	/** "Allow chat for 30 days": chat only, with a grant token the agent can resume with. */
	async allowChat(ws, a, pages) {
		const until = this.now() + CHAT_MS;
		const token = hex(crypto.getRandomValues(new Uint8Array(32)));
		const grant = await hashToken(token);
		await this.putGrant(grant, {
			label: a.label,
			until,
			pages,
			scope: "chat",
			at: this.now()
		});
		ws.serializeAttachment({
			...a,
			until,
			scope: "chat",
			grant,
			pages
		});
		send(ws, {
			type: "approved",
			until,
			scope: "chat",
			pages,
			token
		});
		log({
			msg: "chat.allow",
			pair: a.pair,
			label: a.label,
			until,
			scope: "chat"
		});
		this.broadcast();
		send(ws, {
			type: "history",
			messages: await this.history()
		});
	}
	/** Deny a pairing, or End a session — and with it the grant behind it, on every socket using it. */
	end(kind, ws, a) {
		if (kind === "deny") {
			const who = audience(a);
			const t = this.now();
			this.knocks.set(who, {
				...this.knocks.get(who) ?? {
					start: t,
					count: 0
				},
				deniedAt: t
			});
		}
		const targets = a.grant ? this.sockets("controller").filter((c) => c.a.grant === a.grant) : [{
			ws,
			a
		}];
		for (const c of targets) {
			send(c.ws, { type: kind === "deny" ? "denied" : "revoked" });
			close(c.ws, kind === "deny" ? 4403 : 4401, kind);
		}
		log({
			msg: `chat.${kind}`,
			pair: a.pair,
			label: a.label
		});
		if (!a.grant) return this.broadcast(ws);
		return this.dropGrant(a.grant).then(() => this.broadcast(ws));
	}
	/** Where an agent's `say` goes: the owner's thread, or a friend's by user id or email. */
	async sayTarget(to) {
		if (!to || to === OWNER_THREAD) return { thread: OWNER_THREAD };
		const f = await this.findFriend(to);
		if (!f) return { error: `no chat thread for ${to}` };
		if (f.blocked) return { error: `${f.email} is blocked` };
		return {
			thread: f.userId,
			email: f.email
		};
	}
	fromController(ws, c, raw) {
		const t = this.now();
		if (!c.until) return send(ws, {
			type: "error",
			error: "not approved yet"
		});
		if (c.until <= t) {
			send(ws, { type: "expired" });
			close(ws, 4408, "approval expired");
			return this.broadcast(ws);
		}
		const m = parseControllerMessage(raw);
		if (!m.ok) return send(ws, {
			type: "error",
			error: m.error
		});
		if (m.value.type === "busy") {
			if (c.forUser || m.value.on === false) return;
			return this.sayTarget(m.value.to).then((dest) => {
				if ("error" in dest) return send(ws, {
					type: "error",
					error: dest.error
				});
				const beat = {
					type: "busy",
					label: c.label,
					at: t
				};
				for (const p of this.pages(dest.thread)) if (dest.thread !== OWNER_THREAD || covers(c.pages, p.a.id)) send(p.ws, beat);
			});
		}
		if (m.value.type === "say") {
			if (c.forUser) return send(ws, {
				type: "error",
				error: "a pairing for a friend cannot chat"
			});
			const { text, to } = m.value;
			return this.sayTarget(to).then(async (dest) => {
				if ("error" in dest) return send(ws, {
					type: "error",
					error: dest.error
				});
				const said = {
					id: crypto.randomUUID().slice(0, 8),
					from: "agent",
					label: c.label,
					text,
					at: t,
					...dest
				};
				log({
					msg: "chat.say",
					pair: c.pair,
					agent: c.label,
					thread: said.thread,
					len: text.length,
					...this.head(text)
				});
				await this.post(said, said.thread === OWNER_THREAD ? c.pages : void 0);
				send(ws, {
					type: "said",
					id: said.id,
					thread: said.thread
				});
			});
		}
		if (c.scope === "chat") return send(ws, {
			type: "error",
			error: "this session is chat-only: it cannot eval"
		});
		if (!this.opts.eval) return send(ws, {
			type: "error",
			error: "eval is not enabled on this hub"
		});
		const id = crypto.randomUUID().slice(0, 8);
		const labels = [];
		for (const p of this.pages(audience(c))) {
			if (!covers(c.pages, p.a.id) || !matchesTarget(p.a.label, m.value.target)) continue;
			send(p.ws, {
				type: "eval",
				id,
				code: m.value.code,
				to: c.pair
			});
			labels.push(p.a.label);
		}
		log({
			msg: "chat.eval",
			id,
			pair: c.pair,
			agent: c.label,
			for: c.forUser,
			len: m.value.code.length,
			target: m.value.target,
			...this.head(m.value.code, 200),
			delivered: labels.length
		});
		send(ws, {
			type: "sent",
			id,
			delivered: labels.length,
			labels
		});
	}
	webSocketClose(ws, code) {
		close(ws, code === 1005 ? 1e3 : code, "");
		const a = att(ws);
		if (a?.role === "controller") return this.broadcast(ws);
		if (a?.role === "page") return this.pageClosed(ws, a);
	}
};
function stripUndefined(o) {
	return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== void 0));
}
/**
* A ChatHub class with these options baked in, to export from your Worker as
* the Durable Object: `export const ChatHub = chatHub({ eval: true })`.
*/
function chatHub(opts = {}) {
	return class extends ChatHub {
		constructor(ctx, env) {
			super(ctx, env, Date.now, opts);
		}
	};
}
/**
* Whether a page socket's Origin may connect: the request's own origin, or
* one listed in `allowed`. A request with no Origin is not from a browser
* page (browsers always send one on a WebSocket), so it can only use
* credentials it already holds: it goes on to `identify` like any other.
*/
function pageOriginAllowed(req, allowed = []) {
	const origin = req.headers.get("origin");
	if (origin === null) return true;
	return origin === new URL(req.url).origin || allowed.includes(origin);
}
/**
* Route a request to the hub if it is one of its two sockets; null otherwise
* (so the site's own routes go on). Pages are identified by the site and
* their identity is passed in IDENTITY_HEADERS (any the client sent are
* dropped). A page socket from a foreign Origin is refused (see
* `allowedOrigins`); an agent socket is refused if it carries any Origin
* (a web page).
*/
async function routeChat(req, ns, opts) {
	const url = new URL(req.url);
	const pagePath = opts.pagePath ?? "/api/chat";
	const controlPath = opts.controlPath ?? `${pagePath}/control`;
	if (url.pathname !== pagePath && url.pathname !== controlPath) return null;
	if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket only", { status: 426 });
	const headers = new Headers(req.headers);
	for (const h of Object.values(IDENTITY_HEADERS)) headers.delete(h);
	const hub = ns.get(ns.idFromName(opts.name ?? "chat"));
	const inner = new URL(url);
	if (url.pathname === controlPath) {
		if (req.headers.get("origin")) return new Response("forbidden", { status: 403 });
		inner.pathname = "/control";
		return hub.fetch(new Request(inner, { headers }));
	}
	if (!pageOriginAllowed(req, opts.allowedOrigins)) return new Response("forbidden origin", { status: 403 });
	let who = null;
	try {
		who = await opts.identify(req);
	} catch {
		who = null;
	}
	if (!who || !who.owner && !isUserId(who.userId)) return new Response("forbidden", { status: 403 });
	headers.set(IDENTITY_HEADERS.user, who.owner ? OWNER_THREAD : who.userId);
	headers.set(IDENTITY_HEADERS.email, who.email ?? "");
	headers.set(IDENTITY_HEADERS.owner, who.owner ? "1" : "0");
	inner.pathname = "/page";
	return hub.fetch(new Request(inner, { headers }));
}

//#endregion
export { ChatHub, FRIEND_MAX_PAGES, FRIEND_RELABEL_MS, IDENTITY_HEADERS, OWNER_THREAD, PAIR_COOLDOWN_MS, PAIR_MAX, PAIR_WINDOW_MS, TOKEN_HEADER, chatHub, hashToken, isUserId, pageOriginAllowed, routeChat };
//# sourceMappingURL=hub.js.map