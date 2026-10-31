#!/usr/bin/env bun
import { PENDING_MS, ROOT_NODE, agentIdOf, nodePath, routeTo } from "./protocol.js";
import { C as parseTtl, S as parseProgressReport, d as PROGRESS_STATUSES, o as PROGRESS_KINDS, v as isProgressId } from "./progress-CJs08bXb.js";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

//#region src/deliver.ts
/**
* `ay send` refuses more than 1024 chars per send, and a long paste into a
* live CLI gets mangled anyway: past this, the agent gets a preview and the
* path of a file with the whole message.
*/
const SEND_MAX = 900;
/** The text one chat message is delivered as: a header with the reply command, then the body. */
function deliveryText(hub, m, spill) {
	const who = m.from === "friend" ? `friend ${m.email || m.thread}` : "the user";
	const replyTo = m.from === "friend" ? ` --to ${m.email || m.thread}` : "";
	const page = m.label.split(" ")[0] || "?";
	const header = `[liagent ${m.id}] ${who} wrote in the chat box (${page}) — reply: liagent say ${hub}${replyTo} "..."\n`;
	if (header.length + m.text.length <= SEND_MAX) return header + m.text;
	const path = spill(m.id, m.text);
	const room = Math.max(0, SEND_MAX - header.length - path.length - 40);
	return `${header}${m.text.slice(0, room)}… (${m.text.length} chars; the whole message: ${path})`;
}

//#endregion
//#region src/grants.ts
/**
* Create `dir` (and parents) 0700. An existing directory is left alone
* unless `tighten` (the CLI's own ~/.config/liagent, which older versions
* created 0755): a custom $LIAGENT_GRANTS may sit in $HOME or /tmp, whose
* mode is not ours to change.
*/
function privateDir(dir, tighten = false) {
	if (mkdirSync(dir, {
		recursive: true,
		mode: 448
	}) !== void 0 || tighten) chmodSync(dir, 448);
}
/**
* Write `text` to `path` as 0600. A file that already exists (left 0644 by an
* older version) is tightened before the write, so the new content is never
* readable by others, even for a moment.
*/
function privateWrite(path, text) {
	try {
		chmodSync(path, 384);
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	writeFileSync(path, text, { mode: 384 });
}
/**
* Append `text` to `path` (the `listen --out` log, which holds what the user
* and friends wrote) as a 0600 file: created that way, or tightened first if
* it already exists.
*/
function privateAppend(path, text) {
	try {
		chmodSync(path, 384);
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	appendFileSync(path, text, { mode: 384 });
}
/** One grant per hub and scope: chat keys are the hub URL alone (as before), eval ones "<hub> eval". */
const grantKey = (hub, scope) => scope === "chat" ? hub : `${hub} eval`;
/** `ownDir`: the directory is the CLI's own (the default path), so tighten it even if it exists. */
function grantStore(file, ownDir = false) {
	const read = () => {
		try {
			return JSON.parse(readFileSync(file, "utf8"));
		} catch {
			return {};
		}
	};
	const write = (g) => {
		privateDir(dirname(file), ownDir);
		privateWrite(file, JSON.stringify(g, null, 2));
	};
	return {
		load: (hub, scope) => read()[grantKey(hub, scope)]?.token,
		save(hub, scope, token, until) {
			write({
				...read(),
				[grantKey(hub, scope)]: {
					token,
					until: new Date(until).toISOString()
				}
			});
		},
		forget(hub, scope) {
			const g = read();
			const k = grantKey(hub, scope);
			if (!(k in g)) return;
			delete g[k];
			write(g);
		}
	};
}
/** Save a long message to `<dir>/<id>.txt` (0600 in a 0700 dir) and return the path. */
function spillTo(dir, id, text, ownDir = false) {
	privateDir(dir, ownDir);
	const path = join(dir, `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`);
	privateWrite(path, text);
	return path;
}

//#endregion
//#region src/place.ts
/** The node and assignee from the flags, else the environment; an error for a bad one. */
function placeOf(flags, env) {
	const rawPath = flags.taskPath ?? env.LIAGENT_TASK_PATH;
	const rawAgent = flags.agent ?? env.LIAGENT_AGENT;
	const node = rawPath?.trim() ? nodePath(rawPath) : void 0;
	if (rawPath?.trim() && !node) return { error: `not a node path: ${rawPath} (letters, digits, ._~- segments, ≤ 80 chars)` };
	const agent = rawAgent?.trim() ? agentIdOf(rawAgent) : void 0;
	if (rawAgent?.trim() && !agent) return { error: `not an agent id: ${rawAgent} (≤ 40 chars of letters, digits, ._@:+- )` };
	const out = {};
	if (node && node !== ROOT_NODE) out.node = node;
	if (agent) out.agent = agent;
	return out;
}
/**
* Whether `listen` prints a chat line: the user's and friends' lines (all
* the hub routed here), and agent lines addressed to a node — never its own,
* nor the agents' replies to the main thread (as before node paths).
* `observed`: the hub's mark, or (for history) worked out from the routes.
*/
function listenLine(m, self, observed) {
	if (m.from === "agent") {
		if (typeof m.to !== "string") return null;
		if ((m.taskPath ?? ROOT_NODE) === (self.node ?? ROOT_NODE) && m.agentId === self.agent) return null;
	}
	const seen = observed ?? routeTo(self.node, m.to) === "observed";
	return {
		type: "chat",
		...m,
		...seen ? { observed: true } : {}
	};
}

//#endregion
//#region src/progress-args.ts
const PROGRESS_USAGE = `liagent progress — report to the live state tree (a progress hub, src/progress-hub.ts).

  liagent progress [hub] --agent <name> --task "<text>" --status <${PROGRESS_STATUSES.join("|")}>
      [--path /words/prefetch | --id <slug> [--parent <id>]] [--done] [--pct 40] [--eta 15m]
      [--pr 299] [--note "..."] [--needs "approve PR #299"] [--kind <${PROGRESS_KINDS.join("|")}>]
      [--ref <id>] [--action "<command or URL>"] [--link https://…] [--rev N] [--human]
  liagent progress grant   [hub] --node <id> --agent <name> [--ttl 8h]
      Mint a token for <name> scoped to <id> and its subtree (inside your own
      scope, never outliving your token); prints it.
  liagent progress resolve [hub] --id <id> [--note "the answer"]
      Check a node off as the owner (the root token only).
  liagent progress show    [hub]
      The whole tree and the log, as JSON.

  --agent defaults to $LIAGENT_AGENT and --path to $LIAGENT_TASK_PATH.
  [hub] is the hub's URL, e.g. https://example.com/api/progress (or --hub;
  default $LIAGENT_PROGRESS_HUB). The token is --token, else
  $LIAGENT_PROGRESS_TOKEN: the hub's secret (the root) or a scoped token.
  --repo owner/name (or $LIAGENT_REPO) prints --pr as a link.`;
const STRINGS = [
	"agent",
	"task",
	"status",
	"eta",
	"note",
	"id",
	"parent",
	"path",
	"needs",
	"kind",
	"ref",
	"action",
	"link",
	"token",
	"node",
	"ttl",
	"hub",
	"repo"
];
const NUMBERS = [
	"pct",
	"pr",
	"rev"
];
const SWITCHES = ["done", "human"];
const SUBS = [
	"grant",
	"resolve",
	"show"
];
/**
* argv (after `progress`) → the command, or an Error naming what is wrong.
* A first (or post-subcommand) argument that is a URL is the hub.
*/
function parseProgressArgs(argv, env = {}) {
	const sub = SUBS.includes(argv[0] ?? "") ? argv[0] : "report";
	const raw = {};
	let i = sub === "report" ? 0 : 1;
	if (argv[i] && /^(https?|wss?):\/\//.test(argv[i])) raw.hub = argv[i++];
	for (; i < argv.length; i++) {
		const arg = argv[i];
		const m = /^--([a-z]+)(?:=(.*))?$/s.exec(arg);
		if (!m) return /* @__PURE__ */ new Error(`unexpected argument: ${arg}`);
		const name = m[1];
		if (SWITCHES.includes(name)) {
			raw[name] = true;
			continue;
		}
		const value = m[2] ?? argv[++i];
		if (value === void 0) return /* @__PURE__ */ new Error(`--${name} needs a value`);
		if (STRINGS.includes(name)) raw[name] = value;
		else if (NUMBERS.includes(name)) {
			const n = Number(value.replace(/^#|%$/g, ""));
			if (value.trim() === "" || !Number.isFinite(n)) return /* @__PURE__ */ new Error(`--${name} must be a number`);
			raw[name] = n;
		} else return /* @__PURE__ */ new Error(`unknown flag: --${name}`);
	}
	const str = (v) => typeof v === "string" && v.trim() ? v.trim() : void 0;
	const common = {};
	const token = str(raw.token) ?? str(env.LIAGENT_PROGRESS_TOKEN);
	const hub = (str(raw.hub) ?? str(env.LIAGENT_PROGRESS_HUB))?.replace(/\/+$/, "");
	const repo = str(raw.repo) ?? str(env.LIAGENT_REPO);
	if (token) common.token = token;
	if (hub) common.hub = hub;
	if (repo) {
		if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return /* @__PURE__ */ new Error("--repo must be owner/name");
		common.repo = repo;
	}
	if (sub === "show") return {
		cmd: "show",
		...common
	};
	const agent = str(raw.agent) ?? str(env.LIAGENT_AGENT);
	if (sub === "grant") {
		if (!isProgressId(raw.node)) return /* @__PURE__ */ new Error("grant needs --node <id>");
		if (typeof raw.agent !== "string" || !raw.agent) return /* @__PURE__ */ new Error("grant needs --agent <name>");
		const ttl = typeof raw.ttl === "string" ? raw.ttl : "8h";
		const ms = parseTtl(ttl);
		if (ms instanceof Error) return /* @__PURE__ */ new Error(`--ttl: ${ms.message}`);
		return {
			cmd: "grant",
			node: raw.node,
			agent: raw.agent,
			ttl,
			...common
		};
	}
	if (sub === "resolve") {
		if (!isProgressId(raw.id)) return /* @__PURE__ */ new Error("resolve needs --id <id>");
		return {
			cmd: "resolve",
			id: raw.id,
			...typeof raw.note === "string" ? { note: raw.note } : {},
			...common
		};
	}
	if (raw.done) raw.status = "done";
	if (raw.path === void 0 && raw.id === void 0 && str(env.LIAGENT_TASK_PATH)) raw.path = str(env.LIAGENT_TASK_PATH);
	if (raw.path !== void 0) {
		if (raw.id !== void 0 && raw.id !== raw.path) return /* @__PURE__ */ new Error("--path and --id differ");
		raw.id = raw.path;
	}
	if (agent) raw.agent = agent;
	if (raw.human) {
		raw.assignee = {
			type: "human",
			name: raw.agent
		};
		delete raw.agent;
	}
	for (const k of [
		"path",
		"done",
		"human",
		"token",
		"hub",
		"repo"
	]) delete raw[k];
	const report = parseProgressReport(raw);
	return report instanceof Error ? report : {
		cmd: "report",
		report,
		...common
	};
}
/** The request a command makes: a path below the hub URL and a body (none: GET). */
function progressRequest(c) {
	if (c.cmd === "report") return {
		path: "",
		body: c.report
	};
	if (c.cmd === "grant") return {
		path: "/grant",
		body: {
			node: c.node,
			agent: c.agent,
			ttl: c.ttl
		}
	};
	if (c.cmd === "resolve") return {
		path: "/resolve",
		body: c.note ? {
			id: c.id,
			note: c.note
		} : { id: c.id }
	};
	return { path: "" };
}

//#endregion
//#region src/progress-cli.ts
/** POST `body` (or GET without one) to `<hub><path>`; the JSON answer, or an Error. */
async function callProgress(hub, token, path, body, fetchImpl = fetch) {
	try {
		const res = await fetchImpl(`${hub}${path}`, {
			method: body === void 0 ? "GET" : "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json"
			},
			body: body === void 0 ? void 0 : JSON.stringify(body),
			signal: AbortSignal.timeout(1e4)
		});
		const text = await res.text();
		if (!res.ok) return /* @__PURE__ */ new Error(`${res.status} ${text.slice(0, 300)}`);
		return JSON.parse(text);
	} catch (e) {
		return e instanceof Error ? e : new Error(String(e));
	}
}
/** Run `liagent progress <argv>`; the exit code. */
async function runProgress(argv, env = process.env, out = console, fetchImpl = fetch) {
	if (argv.includes("--help") || argv.includes("-h")) {
		out.log(PROGRESS_USAGE);
		return 0;
	}
	const cmd = parseProgressArgs(argv, env);
	if (cmd instanceof Error) {
		out.error(`liagent progress: ${cmd.message}\n\n${PROGRESS_USAGE}`);
		return 2;
	}
	if (!cmd.hub) {
		out.error("liagent progress: no hub — pass its URL, --hub, or set LIAGENT_PROGRESS_HUB");
		return 2;
	}
	if (!cmd.token) {
		out.error("liagent progress: no token — pass --token or set LIAGENT_PROGRESS_TOKEN");
		return 2;
	}
	const { path, body } = progressRequest(cmd);
	const res = await callProgress(cmd.hub, cmd.token, path, body, fetchImpl);
	if (res instanceof Error) {
		out.error(`liagent progress: ${res.message}`);
		return 1;
	}
	if (cmd.cmd === "grant") out.log(String(res.token));
	else if (cmd.cmd === "show") out.log(JSON.stringify(res, null, 2));
	else if (cmd.cmd === "resolve") {
		const ids = res.resolved ?? [];
		out.log(`progress: resolved ${ids.join(", ") || "nothing (already done)"}`);
	} else {
		const e = res.entry;
		const pr = e.pr && cmd.repo ? ` https://github.com/${cmd.repo}/pull/${e.pr}` : "";
		out.log(`progress: ${e.id} ${e.status} (rev ${e.rev}, ${res.readers ?? 0} watching)${pr}`);
	}
	return 0;
}

//#endregion
//#region src/cli.ts
const USAGE = `liagent — the agent's side of the user ⇄ agent chat (src/hub.ts).

  liagent pair   [hub] [--eval] [--label "…"]
      Ask the user to approve this agent: prints a short code, which the
      box shows too. Chat (the default) lasts 30 days on all of the user's
      pages; --eval asks to run code (and chat) for 8 hours on the pages
      the user ticks. Either way the grant token is saved, so later
      commands resume it without asking.

  liagent listen [hub] [--to <agent>] [--out <file>] [--label "…"]
      Hold the chat. Each new message from the user (or a friend) is one
      JSON line on stdout {type:"chat", id, from, label, text, at, thread?},
      and so is each {type:"page-changed", label, thread, at} when one of
      the user's pages navigates (all also appended to --out). With --to,
      each message is also delivered into that agent-yes agent with
      \`ay send\`, with the reply command in it, and while the agent works
      (its \`ay ls\` status is "active") the box shows a spinner. It resumes
      the saved grant and reconnects on network drops (backing off from 1 s
      to a minute) without ever asking the user again; see "Pairing".

  liagent say    [hub] "text" | -   [--to <email|user id>] [--quiet | --loud]
      Reply in the box (the user's thread, or a friend's), then exit.
      --quiet: shown, never read aloud (FYI, progress, notices: anything
      the user did not ask for). --loud: read aloud even in the user's
      quiet hours (default 23:00–08:00 on their device); keep it for what
      is urgent or needs them now. A hidden page never reads either.

  liagent say    [hub] "text" --to /words/audio
      Address a state-tree node instead (a --to starting with "/"): its
      agent gets it, its ancestors observe it. Allowed into your own
      subtree and upward; anything else needs a grant (below), else
      {type:"error", reason:"out of scope: needs a grant from /words"}.

  liagent edit   [hub] (<msgId> | --last) "polished text" | -
      Polish the user's latest line when it came from the box's mic (it
      carries "source":"stt" in listen's output): STT gets words wrong and
      has no context. The hub keeps the first STT text as raw, marks the
      line edited, and updates it in place in the box (never read aloud
      again). Only the user's LATEST line, only stt, at most 3 times;
      friends' lines never. --last targets the user's latest line. Prints
      {type:"edited", id, thread, text, raw, edited}, or the rule it broke.

  liagent grant   [hub] --from /words/prefetch --to /words/audio [--hours 8]
  liagent ungrant [hub] --from /words/prefetch --to /words/audio
      Let senders within one node address another (or take it back): only
      from an agent whose node holds both — the main one ("/") always may.

  --task-path /words/prefetch   (or $LIAGENT_TASK_PATH)
  --agent <name>                (or $LIAGENT_AGENT)
      Where this agent sits in the state tree. Messages are addressed to
      state-tree nodes; a node's assignee (agent or human) receives them.
      listen hears the lines addressed to that node (and, marked
      "observed": true, to the nodes below it) instead of the main thread;
      say lines carry it as taskPath and the name as agentId, which the box
      shows under the avatar as "/words › prefetch". A sub-agent sets the
      env vars once.

  liagent busy   [hub] [--to <email|user id>] [--every <seconds>]
      One heartbeat: the box shows a spinner for 12 s, or until you reply.
      With --every (e.g. 4, run it in the background), it keeps beating
      until your next reply in that thread, and then exits (30 min at most).

  liagent eval   [hub] [--target <text>] '<code>' | -
      Run code on the pages the user allowed (a hub with eval only),
      resuming the saved eval grant, and print each page's result.

Pairing prompts the user, so it is rationed:
  - A command resumes the saved grant for its scope (x-liagent-token).
  - It pairs at most once per process, and never from a reconnect loop.
  - A saved grant the hub rejects (4498) is forgotten, and the command
    pairs once; if that fails too, it stops (listen stays idle).
  - A pairing that fails is never retried: denied, expired (4408),
    another request waiting (4429), no page open (4404), or no answer.
    Only a network failure before the user was shown anything is retried
    (listen backs off and tries again): no prompt was spent.
  - --no-pair (any command): only ever resume; never ask.

  liagent progress [hub] --agent <name> --path /words/prefetch --task "…" --status doing --pct 40
  liagent progress [hub] … --done --pr 12
  liagent progress grant|resolve|show [hub] …
      Report to the live state tree (a progress hub, not the chat hub):
      one HTTP request with a bearer token ($LIAGENT_PROGRESS_TOKEN), hub
      $LIAGENT_PROGRESS_HUB. "liagent progress --help" has every flag.

[hub] is the hub's page-socket URL, e.g. https://dev.example.com/api/chat
(its agent socket is <hub>/control). Default: $LIAGENT_HUB. Grants are kept
in ~/.config/liagent/grants.json (mode 600; $LIAGENT_GRANTS overrides), one
per hub and scope. "End" in the box revokes a grant; the CLI then forgets it.`;
const GRANTS = process.env.LIAGENT_GRANTS ?? join(homedir(), ".config", "liagent", "grants.json");
const RESULT_MS = 2e4;
/** How often `listen --to` checks the agent's status and beats (pages time a beat out after 12 s). */
const BEAT_MS = 5e3;
function usage(code = 0) {
	(code ? console.error : console.log)(USAGE);
	process.exit(code);
}
const args = process.argv.slice(2);
const cmd = args.shift();
if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") usage();
if (cmd === "progress") process.exit(await runProgress(args));
const flag = (name) => {
	const i = args.indexOf(name);
	if (i === -1) return void 0;
	const v = args[i + 1];
	args.splice(i, 2);
	return v;
};
/** A flag with no value (--quiet): true if given, and taken out of args. */
const takeSwitch = (name) => {
	const i = args.indexOf(name);
	if (i !== -1) args.splice(i, 1);
	return i !== -1;
};
const labelFlag = flag("--label");
const label = labelFlag ?? `agent on ${hostname()}`;
const placed = placeOf({
	taskPath: flag("--task-path"),
	agent: flag("--agent")
}, process.env);
if ("error" in placed) {
	console.error(`liagent: ${placed.error}`);
	process.exit(2);
}
const place = placed;
/** The hub: the first argument if it is a URL, else $LIAGENT_HUB. */
function takeHub() {
	if (args[0] && /^(https?|wss?):\/\//.test(args[0])) return args.shift().replace(/\/+$/, "");
	const env = process.env.LIAGENT_HUB?.replace(/\/+$/, "");
	if (!env) {
		console.error("liagent: no hub — pass its URL or set LIAGENT_HUB");
		process.exit(2);
	}
	return env;
}
/** The default location is ours to tighten; a custom $LIAGENT_GRANTS's folder is not. */
const ownGrantsDir = !process.env.LIAGENT_GRANTS;
const grants = grantStore(GRANTS, ownGrantsDir);
const loadToken = grants.load;
const saveToken = grants.save;
const forgetToken = grants.forget;
function controlUrl(hub, extra = {}) {
	const u = new URL(`${hub}/control`);
	if (u.protocol === "http:") u.protocol = "ws:";
	if (u.protocol === "https:") u.protocol = "wss:";
	const l = extra.token ? labelFlag ?? "" : label;
	if (l) u.searchParams.set("label", l);
	for (const [k, v] of Object.entries(extra)) if (k !== "token") u.searchParams.set(k, v);
	if (place.node) u.searchParams.set("node", place.node);
	if (place.agent) u.searchParams.set("agent", place.agent);
	return u.toString();
}
/**
* Bun's WebSocket takes headers, so the grant goes in one, never in the URL.
* Without a grant, the knock says what it asks for: chat (30 days) or eval (8 hours).
*/
function open(hub, scope, token) {
	return token ? new WebSocket(controlUrl(hub, { token }), { headers: { "x-liagent-token": token } }) : new WebSocket(controlUrl(hub, { scope }));
}
/**
* Why a connection attempt failed. `code` is the close code (or 0); `fatal`
* means asking again would only prompt the user again: stop instead.
*/
var ConnectError = class extends Error {
	constructor(message, code, fatal, prompted = false) {
		super(message);
		this.code = code;
		this.fatal = fatal;
		this.prompted = prompted;
	}
};
/** --no-pair: only ever resume a saved grant; never ask the user. */
const noPair = args.includes("--no-pair");
if (noPair) args.splice(args.indexOf("--no-pair"), 1);
/** Pairing prompts the user, so a process asks at most once — never from a reconnect loop. */
let pairedOnce = false;
/** The history each approved socket was sent right after its approval (for `edit --last`). */
const histories = /* @__PURE__ */ new WeakMap();
/** One socket: resume with `token`, or knock without one. Resolves once approved. */
function attempt(hub, scope, token) {
	return new Promise((resolve, reject) => {
		const ws = open(hub, scope, token);
		let settled = false;
		let reason = "";
		let prompted = false;
		const done = (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(give);
			if (err) {
				ws.close();
				reject(err);
			} else resolve(ws);
		};
		const give = setTimeout(() => done(new ConnectError("no answer in the box within 2 minutes", 0, true, prompted)), PENDING_MS + 5e3);
		ws.onmessage = (e) => {
			const m = JSON.parse(String(e.data));
			if (m.type === "pending") {
				prompted = true;
				console.error(`Pairing as "${label}" (${scope === "eval" ? "run code and chat, 8 hours" : "chat, 30 days"}). In the box, allow code  ${m.code}`);
			} else if (m.type === "approved") {
				if (typeof m.token === "string") saveToken(hub, scope, m.token, Number(m.until));
				if (!m.resumed) console.error(`Approved (${m.scope}${m.pages === "all" ? ", all pages" : Array.isArray(m.pages) ? `, ${m.pages.length} page(s)` : ""}) until ${new Date(Number(m.until)).toLocaleString()}.`);
				histories.set(ws, new Promise((resolve) => {
					const t = setTimeout(() => resolve([]), 5e3);
					ws.onmessage = (h) => {
						const x = JSON.parse(String(h.data));
						if (x.type !== "history") return;
						clearTimeout(t);
						ws.onmessage = null;
						resolve(Array.isArray(x.messages) ? x.messages : []);
					};
				}));
				ws.onclose = null;
				done();
			} else if (m.type === "error" || m.type === "denied" || m.type === "expired") reason = String(m.error ?? m.type);
		};
		ws.onclose = (e) => done(new ConnectError(reason || `socket closed (${e.code}${e.reason ? ` ${e.reason}` : ""})`, e.code, false, prompted));
	});
}
/**
* An approved socket for `scope`: resume the saved grant, or — once per
* process, and never with --no-pair — pair, which prompts the user. A
* rejected token (4498) is forgotten and leads to that one pairing. Any
* failure of the pairing itself (denied, 4408 expired, 4429 another request
* waiting, 4404 no page open, no answer) is fatal: it is not retried.
* A network failure while resuming is not fatal: the caller retries later.
*/
async function connect(hub, scope = "chat") {
	const token = loadToken(hub, scope);
	if (token) try {
		return await attempt(hub, scope, token);
	} catch (e) {
		const err = e;
		if (err.code !== 4498) throw err;
		forgetToken(hub, scope);
		console.error(`liagent: the saved ${scope} grant is no longer valid (${err.message}).`);
	}
	if (noPair) throw new ConnectError(`no valid ${scope} grant, and --no-pair was given`, 0, true);
	if (pairedOnce) throw new ConnectError("already asked the user once in this process; not asking again", 0, true);
	pairedOnce = true;
	try {
		return await attempt(hub, scope);
	} catch (e) {
		const err = e;
		if (!err.prompted && err.code < 4e3) {
			pairedOnce = false;
			throw new ConnectError(`could not reach the hub to pair: ${err.message}`, err.code, false);
		}
		throw new ConnectError(`pairing failed: ${err.message}`, err.code, true, err.prompted);
	}
}
/** One-shot commands: an approved socket, or the error and exit 1. */
async function connectOrExit(hub, scope = "chat") {
	try {
		return await connect(hub, scope);
	} catch (e) {
		console.error(`liagent: ${e.message}`);
		process.exit(1);
	}
}
/** Send one message and wait for the reply of `type` (or an error). */
function request(ws, msg, type, ms = RESULT_MS) {
	return new Promise((resolve, reject) => {
		const give = setTimeout(() => reject(/* @__PURE__ */ new Error(`no ${type} within ${ms / 1e3}s`)), ms);
		const on = (e) => {
			const m = JSON.parse(String(e.data));
			if (m.type === type) {
				clearTimeout(give);
				ws.removeEventListener("message", on);
				resolve(m);
			} else if (m.type === "error" || m.type === "revoked" || m.type === "expired") {
				clearTimeout(give);
				ws.removeEventListener("message", on);
				reject(new Error(String(m.reason ?? m.error ?? m.type)));
			}
		};
		ws.addEventListener("message", on);
		ws.send(JSON.stringify(msg));
	});
}
async function readText() {
	const rest = args.join(" ");
	if (rest !== "-") return rest;
	return (await new Response(Bun.stdin.stream()).text()).trim();
}
/** The agent-yes status of `to` (pid, agent id or its prefix), or undefined. */
function agentStatus(to) {
	const r = Bun.spawnSync([
		"ay",
		"ls",
		"--json"
	], { stderr: "ignore" });
	if (!r.success) return void 0;
	try {
		return JSON.parse(r.stdout.toString()).find((a) => String(a.pid) === to || a.agent_id && a.agent_id.startsWith(to))?.status;
	} catch {
		return;
	}
}
const INBOX = join(dirname(GRANTS), "inbox");
const spillToInbox = (id, text) => spillTo(INBOX, id, text, ownGrantsDir);
/**
* Deliver one message into an agent-yes agent. --force: the owner named the
* agent with --to, and an agent idle for a minute is the normal case here.
* --raw: our own header carries the reply route. Exit 4 (queued for the
* agent's input box) counts as delivered; anything else is retried.
*/
function deliver(to, text) {
	const r = Bun.spawnSync([
		"ay",
		"send",
		to,
		text,
		"--force",
		"--raw"
	], {
		stdout: "ignore",
		stderr: "pipe"
	});
	if (r.exitCode === 0 || r.exitCode === 4) return true;
	console.error(`liagent: ay send ${to} failed (${r.exitCode}): ${r.stderr.toString().trim()}`);
	return false;
}
/** Stay up without reconnecting or prompting: a supervisor restarting us would only ask again. */
function idle() {
	console.error("liagent: idle. Fix the grant (or restart with `liagent pair`) and run listen again.");
	setInterval(() => {}, 1 << 30);
	return new Promise(() => {});
}
async function cmdListen(hub) {
	const to = flag("--to");
	const out = flag("--out");
	let backoff = 1e3;
	let beat;
	/** Messages `ay send` refused (agent unreachable…), retried on every beat, in order. */
	const undelivered = [];
	const flush = () => {
		while (to && undelivered.length && deliver(to, undelivered[0])) undelivered.shift();
	};
	for (;;) {
		let ws;
		try {
			ws = await connect(hub);
		} catch (e) {
			const err = e;
			console.error(`liagent: ${err.message}`);
			if (err.fatal) return idle();
			await Bun.sleep(backoff);
			backoff = Math.min(backoff * 2, 6e4);
			continue;
		}
		backoff = 1e3;
		console.error(`Listening on ${hub}${to ? `, delivering to ${to}` : ""}.`);
		if (to) beat = setInterval(() => {
			flush();
			if (agentStatus(to) === "active") ws.send(JSON.stringify({ type: "busy" }));
		}, BEAT_MS);
		const code = await new Promise((resolve) => {
			ws.onmessage = (e) => {
				const m = JSON.parse(String(e.data));
				if (m.type === "chat") {
					const c = m.message;
					const shown = listenLine(c, place, m.observed === true);
					if (!shown) return;
					const line = JSON.stringify(shown);
					console.log(line);
					if (out) privateAppend(out, `${line}\n`);
					if (to) {
						undelivered.push(deliveryText(hub, c, spillToInbox));
						flush();
						ws.send(JSON.stringify(c.from === "friend" ? {
							type: "busy",
							to: c.thread
						} : { type: "busy" }));
					}
				} else if (m.type === "friend-new" || m.type === "page-changed" || m.type === "edited") {
					const line = JSON.stringify(m);
					console.log(line);
					if (out) privateAppend(out, `${line}\n`);
				} else if (m.type === "error") console.error(`liagent: ${m.error}`);
				else if (m.type === "revoked") {
					console.error("liagent: the user ended this session.");
					forgetToken(hub, "chat");
					process.exit(0);
				}
			};
			ws.onclose = (e) => resolve(e.code);
		});
		clearInterval(beat);
		if (code === 4401) {
			forgetToken(hub, "chat");
			console.error("liagent: the user ended this session.");
			process.exit(0);
		}
		console.error(`liagent: socket closed (${code}); reconnecting in ${backoff / 1e3}s`);
		await Bun.sleep(backoff);
		backoff = Math.min(backoff * 2, 6e4);
	}
}
async function main() {
	const hub = takeHub();
	if (cmd === "pair") {
		(await connectOrExit(hub, args.includes("--eval") ? "eval" : "chat")).close();
		return;
	}
	if (cmd === "listen") return cmdListen(hub);
	if (cmd === "edit") {
		const last = args.includes("--last");
		if (last) args.splice(args.indexOf("--last"), 1);
		const id = last ? void 0 : args.shift();
		const text = await readText();
		if (!text || !last && !id) usage(2);
		const ws = await connectOrExit(hub);
		let target = id;
		if (last) {
			target = (await histories.get(ws) ?? []).filter((x) => x.from === "owner" && (x.thread ?? "owner") === "owner").at(-1)?.id;
			if (!target) {
				console.error("liagent: the user has no line to polish");
				process.exit(1);
			}
		}
		try {
			const r = await request(ws, {
				type: "edit",
				id: target,
				text
			}, "edited");
			console.log(JSON.stringify(r));
		} catch (e) {
			console.error(`liagent: ${e.message}`);
			process.exit(1);
		}
		ws.close();
		return;
	}
	if (cmd === "say") {
		const to = flag("--to");
		const quiet = takeSwitch("--quiet");
		const loud = takeSwitch("--loud");
		if (quiet && loud) {
			console.error("liagent: --quiet and --loud together make no sense; pick one");
			process.exit(2);
		}
		const text = await readText();
		if (!text) usage(2);
		const ws = await connectOrExit(hub);
		const r = await request(ws, {
			type: "say",
			text,
			...to ? { to } : {},
			...place.node ? { taskPath: place.node } : {},
			...place.agent ? { agentId: place.agent } : {},
			...quiet ? { quiet: true } : {},
			...loud ? { loud: true } : {}
		}, "said");
		console.error(`said ${r.id}`);
		ws.close();
		return;
	}
	if (cmd === "grant" || cmd === "ungrant") {
		const from = flag("--from");
		const to = flag("--to");
		const hours = Number(flag("--hours") ?? 0);
		if (!from || !to) usage(2);
		const ws = await connectOrExit(hub);
		const r = await request(ws, {
			type: cmd,
			from,
			to,
			...hours > 0 ? { ms: Math.round(hours * 36e5) } : {}
		}, cmd === "grant" ? "granted" : "ungranted");
		console.log(JSON.stringify(r));
		ws.close();
		return;
	}
	if (cmd === "busy") {
		const to = flag("--to");
		const every = Number(flag("--every") ?? 0);
		const ws = await connectOrExit(hub);
		const beat = () => ws.send(JSON.stringify(to ? {
			type: "busy",
			to
		} : { type: "busy" }));
		beat();
		if (every > 0) {
			const timer = setInterval(beat, Math.max(1, every) * 1e3);
			await new Promise((resolve) => {
				const stop = setTimeout(resolve, 30 * 6e4);
				ws.onmessage = (e) => {
					const m = JSON.parse(String(e.data));
					if (m.type === "chat" && m.message.from === "agent") {
						clearTimeout(stop);
						resolve();
					}
				};
				ws.onclose = () => resolve();
			});
			clearInterval(timer);
		}
		await Bun.sleep(200);
		ws.close();
		return;
	}
	if (cmd === "eval") {
		const target = flag("--target");
		const code = await readText();
		if (!code) usage(2);
		const ws = await connectOrExit(hub, "eval");
		const results = [];
		await new Promise((resolve, reject) => {
			let id = "";
			let expected = Infinity;
			const give = setTimeout(resolve, RESULT_MS);
			ws.onmessage = (e) => {
				const m = JSON.parse(String(e.data));
				if (m.type === "sent") {
					id = String(m.id);
					expected = Number(m.delivered);
					console.error(`eval ${id}: delivered to ${expected} page(s)`);
				} else if (m.type === "result" && m.id === id) results.push(m);
				else if (m.type === "error") {
					clearTimeout(give);
					return reject(new Error(String(m.error)));
				}
				if (results.length >= expected) {
					clearTimeout(give);
					resolve();
				}
			};
			ws.send(JSON.stringify(target ? {
				type: "eval",
				code,
				target
			} : {
				type: "eval",
				code
			}));
		});
		console.log(JSON.stringify(results, null, 2));
		ws.close();
		return;
	}
	usage(2);
}
main().catch((e) => {
	console.error(`liagent: ${e.message}`);
	process.exit(1);
});

//#endregion
//# sourceMappingURL=cli.js.map