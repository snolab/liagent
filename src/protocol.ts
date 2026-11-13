// The owner ⇄ agent chat: the wire shared by the box (src/box.ts), its hub
// client (src/client.ts), the hub a site hosts (src/hub.ts) and the agent's
// CLI (src/cli.ts). Pure and import-free, so a Worker, a browser bundle
// and the CLI can all take it as is.
//
// Wire (JSON text frames). An agent knocks on <hub>/control?scope=chat|eval
// (&label=…, &for=<friend email>); a grant token resumes with x-liagent-token.
//   page → hub        {type:"chat", id, text, to?, source?, context?, attachments?}
//                                                    (to: a state-tree node path;
//                                                     source "stt": from the mic, unchanged;
//                                                     context: what the user attached with
//                                                     the + menu, ChatContext, cleanContext;
//                                                     attachments: files the host stored,
//                                                     AttachmentRef[], cleanAttachments)
//                     {type:"allow", pair, pages?: string[] | "all"} | {type:"deny"|"revoke", pair}
//                     {type:"page", label}            (client-side navigation)
//                     {type:"end-page", id}           (close one of the owner's pages)
//                     {type:"result", id, to, ok, value?, error?, stack?, ms?}
//   hub → page        {type:"state", pending, sessions, listeners, pages, self}
//                     {type:"history", messages} | {type:"chat", message}
//                     {type:"busy", label, at} | {type:"eval", id, code, to}
//                     {type:"edited", id, thread, text, raw, edited}   (a voice line polished)
//   agent → hub       {type:"say", text, to?, taskPath?, agentId?, quiet?} | {type:"busy", to?}
//                     {type:"eval", code, target?} | {type:"grant"|"ungrant", from, to, ms?}
//                     {type:"edit", id, text}   (polish the owner's latest stt line)
//   hub → agent       {type:"pending", code} | {type:"approved", until, scope, pages, token?}
//                     {type:"history"|"chat", …} | {type:"page-changed", label, thread, at}
//                     {type:"said", id} | {type:"sent", id, delivered} | {type:"result", …}
//                     {type:"edited", id, thread, text, raw, edited}
//                     {type:"error", error, reason?} | {type:"denied"|"revoked"|"expired"}
//                     {type:"granted"|"ungranted", from, to, until?}
//
// Node paths. Messages are addressed to state-tree nodes ("/words/prefetch");
// a node's assignee (an agent or a human) receives them. An agent listens at
// a node with ?node=<path>&agent=<id> on /control (absent = "/", the main
// thread). A `to` that starts with "/" is a node, anything else a friend's
// thread. See "Node paths" in SKILL.md.

/** Largest `code` accepted, in characters. */
export const MAX_CODE = 16 * 1024;
/** Largest result summary a page sends back, in characters. */
export const MAX_RESULT = 4000;
/** Largest page or controller label, in characters. */
export const MAX_LABEL = 300;
/** How long the owner has to answer a pairing prompt. */
export const PENDING_MS = 2 * 60_000;
/** How long a friend's preview approval (eval on their pages, one socket) lasts. */
export const APPROVAL_MS = 60 * 60_000;
/**
 * How long the user's eval approval lasts — and its resumable grant token: the
 * agent reconnects with it (x-liagent-token) without a new prompt until then,
 * or until End revokes it.
 */
export const EVAL_GRANT_MS = 8 * 60 * 60_000;
/** How long "Allow chat" lasts — and its resumable grant token. */
export const CHAT_MS = 30 * 24 * 60 * 60_000;
/** Largest chat message (owner's or agent's), in characters. */
export const MAX_CHAT = 4000;
/** Chat messages the hub keeps (and sends a page on connect). */
export const CHAT_HISTORY = 200;
/** A page shows the spinner while the agent's last busy beat is younger than this. */
export const BUSY_MS = 12_000;
/** A beat this soon after a reply is the tail of the work just answered: ignored. */
export const BUSY_AFTER_REPLY_MS = 1_500;
/**
 * How long an eval grant outlives its pages: if every page it covers stays
 * closed this long, the agent is told to pair again (4409). Shorter gaps —
 * a phone app switch, a reload — keep the grant, since a tab keeps its page id.
 */
export const PAGES_GONE_MS = 5 * 60_000;
/** A page id: the tab's own, kept in sessionStorage and sent on reconnect (?page=). */
export const isPageId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(v);
/** How long a page waits after client-side navigation before reporting it. */
export const PAGE_DEBOUNCE_MS = 300;

/**
 * What an approval lets an agent do: "eval" (8 hours, resumable) runs code on
 * the owner's pages and chats; "chat" (Allow chat for 30 days) only chats.
 */
export type Scope = "eval" | "chat";

/** Picture URLs in fallback order: each that fails to load falls through to the next. */
export type AvatarSrc = string | readonly string[];

/**
 * Who sent a line, for the box's avatar. Optional everywhere: the bundled
 * hub does not set it, a host's hub may. `id` seeds the fallback colour:
 * a stable id or a hash of one, never an email.
 */
export type Sender = {
  id?: string;
  name?: string;
  /** In fallback order: the app's own avatar, then the sign-in provider's image. */
  avatar?: AvatarSrc;
};

/** One line of the chat, as the hub stores and sends it. */
export type ChatMessage = {
  id: string;
  from: "owner" | "agent" | "friend";
  label: string;
  text: string;
  at: number;
  thread?: string;
  /** Who sent it, for the avatar (absent: the box falls back, see src/avatar.ts). */
  sender?: Sender;
  /** The state-tree node an agent line comes from ("/words/prefetch"; absent = the main thread). */
  taskPath?: string;
  /** The node's assignee that wrote an agent line (≤ MAX_AGENT_ID). */
  agentId?: string;
  /** The node the line is addressed to (absent or "/" = the main thread). */
  to?: string;
  /**
   * "stt": the owner's line came from the box's own mic — an STT final sent
   * as heard, or sent unchanged. Absent = typed (or dictation edited before
   * sending). Only such a line may be polished by the agent (`edit`).
   */
  source?: MessageSource;
  /** The STT text as first heard, kept once the agent has polished the line. */
  raw?: string;
  /** An agent line never read aloud (`say --quiet`: FYI, progress). Only ever `true`. */
  quiet?: true;
  /**
   * The line's language, a BCP-47 tag ("fr-FR", "de"): read aloud in it,
   * ahead of any preferred language and the guess from the script, which
   * tells only ja/ko/zh from en (`say --lang`; langTag checks it).
   */
  lang?: string;
  /** Set when the agent polished the line: when, by which agent, and how many times. */
  edited?: EditMark;
  /** What the user attached to the line (the box's + menu): checked by cleanContext. */
  context?: ChatContext;
  /**
   * Files sent with the line (pasted, dropped, or picked in the + menu) and
   * stored by the host's `box.files` (src/files.ts): the host's id for each
   * and what it is, never the bytes. The host says where to fetch one
   * (`files.url(ref)`). Checked by cleanAttachments; owner lines only.
   */
  attachments?: AttachmentRef[];
};

/** Where an owner line came from: "stt" (the box's mic). Absent = typed. */
export type MessageSource = "stt";
/** An agent's polish of a voice line (ChatMessage.edited). */
export type EditMark = { at: number; by: string; count: number };
/** How many times the agent may polish one voice line. */
export const MAX_EDITS = 3;
/**
 * The hub's broadcast after an agent polished a voice line: the pages and
 * listeners update that line in place (never read aloud again).
 */
export type EditedEvent = {
  type: "edited";
  id: string;
  thread: string;
  text: string;
  raw: string;
  edited: EditMark;
};

/** A message updated by an EditedEvent; any other message is returned as is. */
export function applyEdit<M extends ChatMessage>(m: M, e: Omit<EditedEvent, "type">): M {
  if (m.id !== e.id || (m.thread ?? "owner") !== e.thread) return m;
  return { ...m, text: e.text, raw: e.raw, edited: e.edited };
}

/**
 * The draft after a transcript landed in it, if the whole draft is still
 * dictation (the draft was empty, or is exactly what dictation left there);
 * null once anything typed is in it.
 */
export function dictatedDraft(prev: string, pure: string | null, next: string): string | null {
  return !prev.trim() || prev === pure ? next : null;
}

/**
 * A line's source as it is sent: "stt" when the draft is exactly what the
 * mic left there (sent as heard, or unchanged); undefined when anything was
 * typed or edited in it.
 */
export function draftSource(draft: string, pure: string | null): MessageSource | undefined {
  return pure !== null && draft === pure && !!draft.trim() ? "stt" : undefined;
}

/**
 * A pairing: waiting for the owner's answer (no `until`), or approved.
 * `scope` is what the agent asked for (absent from an agent that did not
 * say: then the owner's answer decides). `pages`: the page ids it was
 * approved on, or "all" (every page of that audience, now and later).
 */
export type PairInfo = {
  pair: string;
  code: string;
  label: string;
  at: number;
  until?: number;
  scope?: Scope;
  pages?: string[] | "all";
};

/** One connected page of the viewer's own audience (the owner's pages, or a friend's own). */
export type PageInfo = { id: string; label: string; at: number };

export type HubState = {
  type: "state";
  pending: PairInfo | null;
  sessions: PairInfo[];
  /** Chat-capable agents connected now. */
  listeners: number;
  /** This audience's connected pages, and which of them the receiving page is. */
  pages: PageInfo[];
  self: string;
  /** The state-tree nodes agents listen at (never "/"), for the box's "@/…" completions. */
  nodes?: string[];
};

export type ControllerMessage =
  | { type: "eval"; code: string; target?: string }
  /** `to`: a friend's thread; `node`: a state-tree node (a `to` starting with "/"). */
  | {
      type: "say";
      text: string;
      to?: string;
      node?: string;
      taskPath?: string;
      agentId?: string;
      /** Never read aloud. Kept only as boolean true. */
      quiet?: true;
      /** The line's language (BCP-47); dropped unless langTag takes it. */
      lang?: string;
    }
  | { type: "busy"; to?: string; on?: boolean }
  /** Polish the owner's latest line, when it came from the box's mic (`source: "stt"`). */
  | { type: "edit"; id: string; text: string }
  /** Let senders within node `from` address nodes within `to` (only a listener holding both). */
  | { type: "grant"; from: string; to: string; ms?: number }
  | { type: "ungrant"; from: string; to: string };

export type PageMessage =
  | { type: "allow"; pair: string; pages?: string[] | "all"; scope?: "chat" }
  | { type: "deny" | "revoke"; pair: string }
  | { type: "page"; label: string }
  | { type: "end-page"; id: string }
  /** `source: "stt"`: sent from the box's mic, unchanged (absent = typed). */
  | {
      type: "chat";
      id: string;
      text: string;
      to?: string;
      source?: MessageSource;
      context?: ChatContext;
      attachments?: AttachmentRef[];
    }
  | {
      type: "result";
      id: string;
      to: string;
      ok: boolean;
      value?: string;
      error?: string;
      stack?: string;
      ms?: number;
    };

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);

function parse(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length > MAX_CODE + 2048) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A chat message's text: trimmed, non-empty, at most MAX_CHAT characters; else undefined. */
export function chatText(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  return t && t.length <= MAX_CHAT ? t : undefined;
}

/** Validate an agent's message; anything else is an error sent back to it. */
export function parseControllerMessage(
  raw: unknown,
): { ok: true; value: ControllerMessage } | { ok: false; error: string } {
  const m = parse(raw);
  if (m?.type === "say") {
    const text = chatText(m.text);
    if (!text) return { ok: false, error: `say needs text of 1–${MAX_CHAT} chars` };
    let to = str(m.to, 320)?.trim();
    // A `to` that is a path addresses a state-tree node; anything else is a thread.
    let node: string | undefined;
    if (to?.startsWith("/") || typeof m.node === "string") {
      node = nodePath(typeof m.node === "string" ? m.node : to);
      if (!node) return { ok: false, error: `not a node path: ${String(m.node ?? to)}` };
      if (to?.startsWith("/")) to = undefined;
      if (node === ROOT_NODE) node = undefined;
    }
    const taskPath = m.taskPath === undefined ? undefined : nodePath(m.taskPath);
    if (m.taskPath !== undefined && !taskPath)
      return { ok: false, error: `not a node path: ${String(m.taskPath)}` };
    const agentId = agentIdOf(m.agentId);
    const value: ControllerMessage = { type: "say", text };
    if (to) value.to = to;
    if (node) value.node = node;
    if (taskPath && taskPath !== ROOT_NODE) value.taskPath = taskPath;
    if (agentId) value.agentId = agentId;
    // Only boolean true counts. An old `loud` is dropped: it means nothing now.
    if (m.quiet === true) value.quiet = true;
    const lang = langTag(m.lang);
    if (lang) value.lang = lang;
    return { ok: true, value };
  }
  if (m?.type === "edit") {
    const id = str(m.id, 64)?.trim();
    if (!id) return { ok: false, error: "edit needs the id of the message to polish" };
    const text = chatText(m.text);
    if (!text) return { ok: false, error: `edit needs text of 1–${MAX_CHAT} chars` };
    return { ok: true, value: { type: "edit", id, text } };
  }
  if (m?.type === "grant" || m?.type === "ungrant") {
    const from = nodePath(m.from);
    const to = nodePath(m.to);
    if (!from || !to) return { ok: false, error: `${m.type} needs node paths "from" and "to"` };
    if (m.type === "ungrant") return { ok: true, value: { type: "ungrant", from, to } };
    const ms = typeof m.ms === "number" && m.ms > 0 ? Math.min(m.ms, CHAT_MS) : undefined;
    return { ok: true, value: ms ? { type: "grant", from, to, ms } : { type: "grant", from, to } };
  }
  if (m?.type === "busy") {
    const to = str(m.to, 320);
    const value: ControllerMessage = { type: "busy" };
    if (to) value.to = to;
    if (m.on === false) value.on = false;
    return { ok: true, value };
  }
  if (!m || m.type !== "eval")
    return {
      ok: false,
      error:
        'expected {"type":"say","text":"…"}, {"type":"eval","code":"…"}, {"type":"edit","id","text"} or {"type":"grant","from","to"}',
    };
  if (typeof m.code !== "string" || !m.code.trim()) return { ok: false, error: "empty code" };
  if (m.code.length > MAX_CODE) return { ok: false, error: `code over ${MAX_CODE} chars` };
  const target = str(m.target, MAX_LABEL);
  return {
    ok: true,
    value: target ? { type: "eval", code: m.code, target } : { type: "eval", code: m.code },
  };
}

/** Validate a page's message; anything else is dropped. */
export function parsePageMessage(raw: unknown): PageMessage | null {
  const m = parse(raw);
  if (!m) return null;
  if (m.type === "allow") {
    const pair = str(m.pair, 64);
    if (!pair) return null;
    const out: PageMessage = { type: "allow", pair };
    if (m.pages === "all") out.pages = "all";
    else if (Array.isArray(m.pages))
      out.pages = m.pages
        .filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 64)
        .slice(0, 64);
    if (m.scope === "chat") out.scope = "chat";
    return out;
  }
  if (m.type === "page") {
    const label = typeof m.label === "string" ? m.label.slice(0, MAX_LABEL) : undefined;
    return label ? { type: "page", label } : null;
  }
  if (m.type === "end-page") {
    const id = str(m.id, 64);
    return id ? { type: "end-page", id } : null;
  }
  if (m.type === "deny" || m.type === "revoke") {
    const pair = str(m.pair, 64);
    return pair ? { type: m.type, pair } : null;
  }
  if (m.type === "chat") {
    const id = str(m.id, 64);
    const text = chatText(m.text);
    if (!id || !text) return null;
    // An address that is not a node path is dropped: the line goes to the main thread.
    const to = nodePath(m.to);
    const out: PageMessage = { type: "chat", id, text };
    if (to && to !== ROOT_NODE) out.to = to;
    if (m.source === "stt") out.source = "stt";
    const context = cleanContext(m.context);
    if (context) out.context = context;
    const attachments = cleanAttachments(m.attachments);
    if (attachments) out.attachments = attachments;
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
      error: str(m.error, 1000),
      stack: str(m.stack, 2000),
      ms: typeof m.ms === "number" ? m.ms : undefined,
    };
  }
  return null;
}

/** The newest `max` messages, oldest first. */
export function trimHistory(list: ChatMessage[], max = CHAT_HISTORY): ChatMessage[] {
  return list.length > max ? list.slice(list.length - max) : list;
}

/** The longest language tag kept (BCP-47's own practical limit). */
export const MAX_LANG = 35;

/**
 * A message's `lang`, if it is shaped like a BCP-47 tag ("fr", "fr-FR",
 * "zh-Hant-TW", "es-419"): a 2–8 letter language, then 1–8 letter or digit
 * subtags. Anything else (not a string, empty, too long, spaces) is undefined.
 */
export function langTag(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length <= MAX_LANG && /^[a-z]{2,8}(-[a-z0-9]{1,8})*$/i.test(t) ? t : undefined;
}

/**
 * The language to read a reply in, from its script alone: any kana is
 * Japanese, Hangul Korean, other Han Chinese (zh-CN), and everything else
 * English.
 */
export function pickLang(text: string): "ja-JP" | "ko-KR" | "zh-CN" | "en-US" {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return "ja-JP";
  if (/\p{Script=Hangul}/u.test(text)) return "ko-KR";
  if (/\p{Script=Han}/u.test(text)) return "zh-CN";
  return "en-US";
}

/** An installed voice for `lang`: the exact locale first, then the same language. */
export function pickVoice<V extends { lang: string; default?: boolean }>(
  voices: readonly V[],
  lang: string,
): V | undefined {
  const norm = (l: string) => l.replace(/_/g, "-").toLowerCase();
  const want = norm(lang);
  const base = want.split("-")[0];
  const exact = voices.filter((v) => norm(v.lang) === want);
  const same = voices.filter((v) => norm(v.lang).split("-")[0] === base);
  const pool = exact.length ? exact : same;
  return pool.find((v) => v.default) ?? pool[0];
}

/** A label shown to the user: one line, printable, bounded. */
export function cleanLabel(raw: string | null | undefined, max = MAX_LABEL): string {
  return (
    (raw ?? "")
      // Control characters are exactly what this strips.
      // oxlint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim()
      .slice(0, max)
  );
}

/** The short code the CLI prints and the prompt shows, so the owner can match them. */
export function shortCode(bytes: Uint8Array): string {
  return Array.from(bytes.slice(0, 2), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A page's label matches when there is no target, or it contains the target (any case). */
export function matchesTarget(label: string, target: string | undefined): boolean {
  if (!target) return true;
  return label.toLowerCase().includes(target.toLowerCase());
}

/**
 * A JSON-serialisable summary of whatever the code returned, at most `max`
 * characters: cycles, functions, DOM nodes, errors, Maps, Sets and BigInts
 * become readable strings instead of throwing.
 */
export function summarize(value: unknown, max = MAX_RESULT): string {
  const seen = new WeakSet<object>();
  let out: string | undefined;
  try {
    out = JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v === "bigint") return `${v}n`;
      if (typeof v === "function") return `[function ${v.name || "anonymous"}]`;
      if (typeof v === "symbol") return v.toString();
      if (v === undefined) return "[undefined]";
      if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
      if (typeof v === "object" && v !== null) {
        const node = v as {
          nodeType?: unknown;
          outerHTML?: unknown;
          nodeName?: unknown;
        };
        if (typeof node.nodeType === "number")
          return typeof node.outerHTML === "string"
            ? node.outerHTML.slice(0, 500)
            : `[node ${String(node.nodeName)}]`;
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
export function compile(code: string): () => Promise<unknown> {
  try {
    return new Function(`return (async () => (\n${code}\n))();`) as () => Promise<unknown>;
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return new Function(`return (async () => {\n${code}\n})();`) as () => Promise<unknown>;
  }
}

// ── State-tree node paths ─────────────────────────────────────────────────
// Messages are addressed to state-tree nodes; a node's assignee (agent or
// human) receives them.

/** Longest node path kept, in characters ("/words/prefetch"). */
export const MAX_NODE_PATH = 80;
/** Longest assignee id kept (`agentId`), in characters. */
export const MAX_AGENT_ID = 40;
/** The main thread's node: the root of the tree. */
export const ROOT_NODE = "/";

/** One path segment: URL-safe characters only. */
const SEG = /^[A-Za-z0-9._~-]+$/;

/**
 * A node path, normalised: trimmed, a leading "/", segments split on "/" or
 * "›" (so "/words › prefetch" and "words/prefetch" are "/words/prefetch"),
 * no empty, "." or ".." segment, at most MAX_NODE_PATH characters, path
 * characters only. Anything else is undefined (never truncated: a cut path
 * would name another node).
 */
export function nodePath(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (!s || s.length > MAX_NODE_PATH * 2) return undefined;
  const segs = s.split(/\s*[/›]\s*/).filter(Boolean);
  if (segs.some((x) => !SEG.test(x) || x === "." || x === "..")) return undefined;
  const out = `/${segs.join("/")}`;
  return out.length <= MAX_NODE_PATH ? out : undefined;
}

/** An assignee id: trimmed, cut to MAX_AGENT_ID, letters, digits and ._@:+- or spaces only. */
export function agentIdOf(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().slice(0, MAX_AGENT_ID).trim();
  return /^[\w.@:+ -]+$/.test(s) ? s : undefined;
}

/** `p` is `root` or below it. Both are normalised node paths. */
export function isWithin(p: string, root: string): boolean {
  return root === ROOT_NODE || p === root || p.startsWith(`${root}/`);
}

/** The deepest node both paths are within. */
export function commonAncestor(a: string, b: string): string {
  const x = a.split("/").filter(Boolean);
  const y = b.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < Math.min(x.length, y.length) && x[i] === y[i]; i++) out.push(x[i] ?? "");
  return `/${out.join("/")}`;
}

/** How a node path reads in the chat: "/words › prefetch" ("/" stays "/"). */
export function pathLabel(p: string): string {
  const segs = p.split("/").filter(Boolean);
  return segs.length ? `/${segs.join(" › ")}` : ROOT_NODE;
}

/**
 * Whether a listener at node `listener` gets a message addressed to `to`
 * (both absent = the root, the main thread, as before node paths):
 * "direct" when it is that node, "observed" when it is an ancestor (the
 * root observes everything), null otherwise (a sibling or a descendant).
 */
export function routeTo(
  listener: string | undefined,
  to: string | undefined,
): "direct" | "observed" | null {
  const l = listener ?? ROOT_NODE;
  const p = to ?? ROOT_NODE;
  if (l === p) return "direct";
  return isWithin(p, l) ? "observed" : null;
}

/** An approval that lets senders within `from` address nodes within `to`. */
export type NodeGrant = { from: string; to: string; until: number };

/**
 * May a sender at node `from` address node `to`? Always into its own
 * subtree, always upward (its parent, any ancestor, the root), else only
 * under a live grant covering both. The error names the common ancestor,
 * whose listener (or the root's) may grant it.
 */
export function mayAddress(
  from: string,
  to: string,
  grants: readonly NodeGrant[] = [],
  now = Date.now(),
): { ok: true; via: "subtree" | "upward" | "grant" } | { ok: false; error: string } {
  if (isWithin(to, from)) return { ok: true, via: "subtree" };
  if (isWithin(from, to)) return { ok: true, via: "upward" };
  if (grants.some((g) => g.until > now && isWithin(from, g.from) && isWithin(to, g.to)))
    return { ok: true, via: "grant" };
  return { ok: false, error: `out of scope: needs a grant from ${commonAncestor(from, to)}` };
}

/** A leading "@<node path> " in a draft: the node it addresses and the text after it. */
const ADDRESS =
  /^@(\/?(?:[A-Za-z0-9._~-]+(?:(?:\/|\s*›\s*)[A-Za-z0-9._~-]+)*)?\/?)(?:\s+([\s\S]*))?$/;

/**
 * A draft that starts with "@/words › prefetch " (or "@/words/prefetch ")
 * addresses that node: `to` and the rest of the text. `complete` is false
 * while the address is still being typed (no space after it yet). Null when
 * the draft is not an address.
 */
export function parseAddress(
  draft: string,
): { to: string; text: string; complete: boolean } | null {
  if (!draft.startsWith("@/")) return null;
  const m = ADDRESS.exec(draft);
  if (!m) return null;
  const to = nodePath(m[1] || ROOT_NODE);
  if (!to) return null;
  // "@/words ›" is still being typed: the next segment follows.
  if (m[2] === undefined || m[2].startsWith("›")) return { to, text: "", complete: false };
  return { to, text: m[2].trim(), complete: true };
}

/** The node paths offered while typing "@/…": those starting with what is typed, shortest first. */
export function completeNode(partial: string, nodes: readonly string[]): string[] {
  const typed = partial
    .replace(/^@/, "")
    .replace(/\s*›\s*/g, "/")
    .trim()
    .toLowerCase();
  return [...new Set(nodes)]
    .filter((n) => n !== ROOT_NODE && n.toLowerCase().startsWith(typed || "/"))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, 8);
}

/** A node's hue (0–359), from its path: the log line's left border. */
export function nodeHue(p: string): number {
  let h = 0x811c9dc5;
  const s = `node:${p}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 360;
}

/**
 * What a log line shows about nodes: the node it belongs to (an agent's
 * `taskPath`, else the owner's target `to`), the muted subtitle ("/words ›
 * prefetch", "→ /words › prefetch", or "/a › b → /c" for agent→agent), and
 * its left-border colour. Nothing for a main-thread line without a node.
 */
export function lineNode(m: {
  from: string;
  taskPath?: string;
  to?: string;
}): { node: string; subtitle: string; border: string } | null {
  const from = m.from === "agent" && m.taskPath && m.taskPath !== ROOT_NODE ? m.taskPath : "";
  const to = m.to && m.to !== ROOT_NODE ? m.to : "";
  if (!from && !to) return null;
  const subtitle = from
    ? to
      ? `${pathLabel(from)} → ${pathLabel(to)}`
      : pathLabel(from)
    : `→ ${pathLabel(to)}`;
  const node = from || to;
  return { node, subtitle, border: `oklch(0.7 0.09 ${nodeHue(node)})` };
}

// ---- context: what the user attached to a line --------------------------------

/** Most characters of an attached selection. */
export const MAX_SELECTION = 2000;
/** Most characters of the attached page's title. */
export const MAX_CONTEXT_TITLE = 200;
/** Most characters of its path (or host). */
export const MAX_CONTEXT_PATH = 300;
/** Most files attached to one line. */
export const MAX_CONTEXT_FILES = 8;
/** Most characters of a file's name, its URL and its media type. */
export const MAX_FILE_NAME = 200;
export const MAX_FILE_URL = 2048;
export const MAX_FILE_TYPE = 100;

/** A file the host uploaded for a line: where it is now, never its bytes. */
export type ContextFile = {
  name: string;
  /** http(s) or a same-origin path ("/…"); nothing else survives cleanContext. */
  url: string;
  /** Its media type ("image/png"). */
  type?: string;
  /** In bytes. */
  size?: number;
};

/**
 * What goes with a line besides its text (the box's + menu): a selection
 * from the page, where it was made, and files the host uploaded. Every part
 * is optional, but an empty context is no context. Shown to the agent as
 * data, never as instructions; shown in the box as text, never as HTML.
 */
export type ChatContext = {
  selection?: string;
  /** The page's path (no query, no fragment). */
  path?: string;
  title?: string;
  /** The page's host, when the box runs on another site than its hub's. */
  host?: string;
  files?: ContextFile[];
};

const isFileUrl = (u: string) => /^https?:\/\/[^\s]+$/i.test(u) || /^\/(?!\/)[^\s]*$/.test(u);

/**
 * A ChatContext from the wire (or a host), or undefined: known keys only,
 * each bounded; the path loses its query and fragment; a file without a
 * name or with a URL that is not http(s) or a same-origin path is dropped.
 * With neither a selection nor a file it is undefined.
 */
export function cleanContext(raw: unknown): ChatContext | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  const selection = text(r.selection, MAX_SELECTION).trim();
  const files: ContextFile[] = [];
  if (Array.isArray(r.files))
    for (const f of r.files) {
      if (files.length >= MAX_CONTEXT_FILES) break;
      if (!f || typeof f !== "object") continue;
      const x = f as Record<string, unknown>;
      const name = text(x.name, MAX_FILE_NAME).replace(/\s+/g, " ").trim();
      const url = typeof x.url === "string" && x.url.length <= MAX_FILE_URL ? x.url.trim() : "";
      if (!name || !url || !isFileUrl(url)) continue;
      const file: ContextFile = { name, url };
      const type = text(x.type, MAX_FILE_TYPE).trim();
      if (type && /^[\w.+-]+\/[\w.+-]+$/.test(type)) file.type = type;
      if (typeof x.size === "number" && Number.isFinite(x.size) && x.size >= 0)
        file.size = Math.floor(x.size);
      files.push(file);
    }
  if (!selection && !files.length) return undefined;
  const out: ChatContext = {};
  if (selection) out.selection = selection;
  const path = text(r.path, MAX_CONTEXT_PATH).split(/[?#]/)[0]!.trim();
  const title = text(r.title, MAX_CONTEXT_TITLE).replace(/\s+/g, " ").trim();
  const host = text(r.host, MAX_CONTEXT_PATH).trim();
  if (path) out.path = path;
  if (title) out.title = title;
  if (host && /^[\w.-]+(:\d+)?$/.test(host)) out.host = host;
  if (files.length) out.files = files;
  return out;
}

/**
 * Two contexts as one: the newer selection (and its page) replaces the
 * older, files add up (to MAX_CONTEXT_FILES, the same URL once).
 */
export function mergeContext(
  a: ChatContext | null | undefined,
  b: ChatContext | null | undefined,
): ChatContext | undefined {
  if (!a) return cleanContext(b);
  if (!b) return cleanContext(a);
  const sel = b.selection ? b : a;
  const seen = new Set<string>();
  const files = [...(a.files ?? []), ...(b.files ?? [])].filter((f) =>
    seen.has(f.url) ? false : (seen.add(f.url), true),
  );
  return cleanContext({
    selection: sel.selection,
    path: sel.path ?? b.path ?? a.path,
    title: sel.title ?? b.title ?? a.title,
    host: sel.host ?? b.host ?? a.host,
    files,
  });
}

// ---- attachments: files the host stored for a line ----------------------------

/** Most files sent with one line. */
export const MAX_ATTACHMENTS = 10;
/** Most characters of an attached file's name. */
export const MAX_ATTACHMENT_NAME = 200;

/**
 * A file sent with a line (ChatMessage.attachments): the host's id for the
 * stored upload, the file's name (for display only), its media type and its
 * size in bytes. Where to fetch it is the host's business (ChatFiles.url).
 */
export type AttachmentRef = { id: string; name: string; type: string; size: number };

/** Control and bidirectional-override characters: never in a shown file name. */
// oxlint-disable-next-line no-control-regex
const NAME_JUNK = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** A file name for display: no control or bidi characters, no folders, bounded; "file" if empty. */
export function cleanFileName(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  const base = s.replace(NAME_JUNK, "").split(/[\\/]/).at(-1)!.trim();
  return base.slice(0, MAX_ATTACHMENT_NAME) || "file";
}

/**
 * AttachmentRefs from the wire (or a host), or undefined: known keys only,
 * each checked (an id of 1–64 of [A-Za-z0-9_-], a media type that looks like
 * one, else application/octet-stream, a whole size ≥ 0, else 0); the same id
 * once; at most MAX_ATTACHMENTS.
 */
export function cleanAttachments(raw: unknown): AttachmentRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AttachmentRef[] = [];
  for (const a of raw.slice(0, MAX_ATTACHMENTS)) {
    if (!a || typeof a !== "object") continue;
    const r = a as Record<string, unknown>;
    if (typeof r.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(r.id)) continue;
    if (out.some((x) => x.id === r.id)) continue;
    const type =
      typeof r.type === "string" && /^[a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,60}$/.test(r.type)
        ? r.type
        : "application/octet-stream";
    const size =
      typeof r.size === "number" && Number.isSafeInteger(r.size) && r.size >= 0 ? r.size : 0;
    out.push({ id: r.id, name: cleanFileName(r.name), type, size });
  }
  return out.length ? out : undefined;
}
