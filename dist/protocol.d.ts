//#region src/protocol.d.ts
/** Largest `code` accepted, in characters. */
declare const MAX_CODE: number;
/** Largest result summary a page sends back, in characters. */
declare const MAX_RESULT = 4000;
/** Largest page or controller label, in characters. */
declare const MAX_LABEL = 300;
/** How long the owner has to answer a pairing prompt. */
declare const PENDING_MS: number;
/** How long a friend's preview approval (eval on their pages, one socket) lasts. */
declare const APPROVAL_MS: number;
/**
 * How long the user's eval approval lasts — and its resumable grant token: the
 * agent reconnects with it (x-liagent-token) without a new prompt until then,
 * or until End revokes it.
 */
declare const EVAL_GRANT_MS: number;
/** How long "Allow chat" lasts — and its resumable grant token. */
declare const CHAT_MS: number;
/** Largest chat message (owner's or agent's), in characters. */
declare const MAX_CHAT = 4000;
/** Chat messages the hub keeps (and sends a page on connect). */
declare const CHAT_HISTORY = 200;
/** A page shows the spinner while the agent's last busy beat is younger than this. */
declare const BUSY_MS = 12000;
/** A beat this soon after a reply is the tail of the work just answered: ignored. */
declare const BUSY_AFTER_REPLY_MS = 1500;
/**
 * How long an eval grant outlives its pages: if every page it covers stays
 * closed this long, the agent is told to pair again (4409). Shorter gaps —
 * a phone app switch, a reload — keep the grant, since a tab keeps its page id.
 */
declare const PAGES_GONE_MS: number;
/** A page id: the tab's own, kept in sessionStorage and sent on reconnect (?page=). */
declare const isPageId: (v: unknown) => v is string;
/** How long a page waits after client-side navigation before reporting it. */
declare const PAGE_DEBOUNCE_MS = 300;
/**
 * What an approval lets an agent do: "eval" (8 hours, resumable) runs code on
 * the owner's pages and chats; "chat" (Allow chat for 30 days) only chats.
 */
type Scope = "eval" | "chat";
/** Picture URLs in fallback order: each that fails to load falls through to the next. */
type AvatarSrc = string | readonly string[];
/**
 * Who sent a line, for the box's avatar. Optional everywhere: the bundled
 * hub does not set it, a host's hub may. `id` seeds the fallback colour:
 * a stable id or a hash of one, never an email.
 */
type Sender = {
  id?: string;
  name?: string; /** In fallback order: the app's own avatar, then the sign-in provider's image. */
  avatar?: AvatarSrc;
};
/** One line of the chat, as the hub stores and sends it. */
type ChatMessage = {
  id: string;
  from: "owner" | "agent" | "friend";
  label: string;
  text: string;
  at: number;
  thread?: string; /** Who sent it, for the avatar (absent: the box falls back, see src/avatar.ts). */
  sender?: Sender; /** The state-tree node an agent line comes from ("/words/prefetch"; absent = the main thread). */
  taskPath?: string; /** The node's assignee that wrote an agent line (≤ MAX_AGENT_ID). */
  agentId?: string; /** The node the line is addressed to (absent or "/" = the main thread). */
  to?: string;
  /**
   * "stt": the owner's line came from the box's own mic — an STT final sent
   * as heard, or sent unchanged. Absent = typed (or dictation edited before
   * sending). Only such a line may be polished by the agent (`edit`).
   */
  source?: MessageSource; /** The STT text as first heard, kept once the agent has polished the line. */
  raw?: string; /** An agent line never read aloud (`say --quiet`: FYI, progress). Only ever `true`. */
  quiet?: true; /** An agent line read aloud even in the device's quiet hours (`say --loud`). Only ever `true`. */
  loud?: true; /** Set when the agent polished the line: when, by which agent, and how many times. */
  edited?: EditMark;
};
/** Where an owner line came from: "stt" (the box's mic). Absent = typed. */
type MessageSource = "stt";
/** An agent's polish of a voice line (ChatMessage.edited). */
type EditMark = {
  at: number;
  by: string;
  count: number;
};
/** How many times the agent may polish one voice line. */
declare const MAX_EDITS = 3;
/**
 * The hub's broadcast after an agent polished a voice line: the pages and
 * listeners update that line in place (never read aloud again).
 */
type EditedEvent = {
  type: "edited";
  id: string;
  thread: string;
  text: string;
  raw: string;
  edited: EditMark;
};
/** A message updated by an EditedEvent; any other message is returned as is. */
declare function applyEdit<M extends ChatMessage>(m: M, e: Omit<EditedEvent, "type">): M;
/**
 * The draft after a transcript landed in it, if the whole draft is still
 * dictation (the draft was empty, or is exactly what dictation left there);
 * null once anything typed is in it.
 */
declare function dictatedDraft(prev: string, pure: string | null, next: string): string | null;
/**
 * A line's source as it is sent: "stt" when the draft is exactly what the
 * mic left there (sent as heard, or unchanged); undefined when anything was
 * typed or edited in it.
 */
declare function draftSource(draft: string, pure: string | null): MessageSource | undefined;
/**
 * A pairing: waiting for the owner's answer (no `until`), or approved.
 * `scope` is what the agent asked for (absent from an agent that did not
 * say: then the owner's answer decides). `pages`: the page ids it was
 * approved on, or "all" (every page of that audience, now and later).
 */
type PairInfo = {
  pair: string;
  code: string;
  label: string;
  at: number;
  until?: number;
  scope?: Scope;
  pages?: string[] | "all";
};
/** One connected page of the viewer's own audience (the owner's pages, or a friend's own). */
type PageInfo = {
  id: string;
  label: string;
  at: number;
};
type HubState = {
  type: "state";
  pending: PairInfo | null;
  sessions: PairInfo[]; /** Chat-capable agents connected now. */
  listeners: number; /** This audience's connected pages, and which of them the receiving page is. */
  pages: PageInfo[];
  self: string; /** The state-tree nodes agents listen at (never "/"), for the box's "@/…" completions. */
  nodes?: string[];
};
type ControllerMessage = {
  type: "eval";
  code: string;
  target?: string;
} /** `to`: a friend's thread; `node`: a state-tree node (a `to` starting with "/"). */ | {
  type: "say";
  text: string;
  to?: string;
  node?: string;
  taskPath?: string;
  agentId?: string; /** Never read aloud. Kept only as boolean true, and dropped when `loud` is set too. */
  quiet?: true; /** Read aloud even in quiet hours. Kept only as boolean true. */
  loud?: true;
} | {
  type: "busy";
  to?: string;
  on?: boolean;
} /** Polish the owner's latest line, when it came from the box's mic (`source: "stt"`). */ | {
  type: "edit";
  id: string;
  text: string;
} /** Let senders within node `from` address nodes within `to` (only a listener holding both). */ | {
  type: "grant";
  from: string;
  to: string;
  ms?: number;
} | {
  type: "ungrant";
  from: string;
  to: string;
};
type PageMessage = {
  type: "allow";
  pair: string;
  pages?: string[] | "all";
  scope?: "chat";
} | {
  type: "deny" | "revoke";
  pair: string;
} | {
  type: "page";
  label: string;
} | {
  type: "end-page";
  id: string;
} /** `source: "stt"`: sent from the box's mic, unchanged (absent = typed). */ | {
  type: "chat";
  id: string;
  text: string;
  to?: string;
  source?: MessageSource;
} | {
  type: "result";
  id: string;
  to: string;
  ok: boolean;
  value?: string;
  error?: string;
  stack?: string;
  ms?: number;
};
/** A chat message's text: trimmed, non-empty, at most MAX_CHAT characters; else undefined. */
declare function chatText(raw: unknown): string | undefined;
/** Validate an agent's message; anything else is an error sent back to it. */
declare function parseControllerMessage(raw: unknown): {
  ok: true;
  value: ControllerMessage;
} | {
  ok: false;
  error: string;
};
/** Validate a page's message; anything else is dropped. */
declare function parsePageMessage(raw: unknown): PageMessage | null;
/** The newest `max` messages, oldest first. */
declare function trimHistory(list: ChatMessage[], max?: number): ChatMessage[];
/**
 * The language to read a reply in, from its script alone: any kana is
 * Japanese, Hangul Korean, other Han Chinese (zh-CN), and everything else
 * English.
 */
declare function pickLang(text: string): "ja-JP" | "ko-KR" | "zh-CN" | "en-US";
/** An installed voice for `lang`: the exact locale first, then the same language. */
declare function pickVoice<V extends {
  lang: string;
  default?: boolean;
}>(voices: readonly V[], lang: string): V | undefined;
/** A label shown to the user: one line, printable, bounded. */
declare function cleanLabel(raw: string | null | undefined, max?: number): string;
/** The short code the CLI prints and the prompt shows, so the owner can match them. */
declare function shortCode(bytes: Uint8Array): string;
/** A page's label matches when there is no target, or it contains the target (any case). */
declare function matchesTarget(label: string, target: string | undefined): boolean;
/**
 * A JSON-serialisable summary of whatever the code returned, at most `max`
 * characters: cycles, functions, DOM nodes, errors, Maps, Sets and BigInts
 * become readable strings instead of throwing.
 */
declare function summarize(value: unknown, max?: number): string;
/**
 * Compile `code` as an async function. An expression (`document.title`) is
 * returned as is; anything else is a function body, so `return x` works and
 * `await` is allowed in both.
 */
declare function compile(code: string): () => Promise<unknown>;
/** Longest node path kept, in characters ("/words/prefetch"). */
declare const MAX_NODE_PATH = 80;
/** Longest assignee id kept (`agentId`), in characters. */
declare const MAX_AGENT_ID = 40;
/** The main thread's node: the root of the tree. */
declare const ROOT_NODE = "/";
/**
 * A node path, normalised: trimmed, a leading "/", segments split on "/" or
 * "›" (so "/words › prefetch" and "words/prefetch" are "/words/prefetch"),
 * no empty, "." or ".." segment, at most MAX_NODE_PATH characters, path
 * characters only. Anything else is undefined (never truncated: a cut path
 * would name another node).
 */
declare function nodePath(raw: unknown): string | undefined;
/** An assignee id: trimmed, cut to MAX_AGENT_ID, letters, digits and ._@:+- or spaces only. */
declare function agentIdOf(raw: unknown): string | undefined;
/** `p` is `root` or below it. Both are normalised node paths. */
declare function isWithin(p: string, root: string): boolean;
/** The deepest node both paths are within. */
declare function commonAncestor(a: string, b: string): string;
/** How a node path reads in the chat: "/words › prefetch" ("/" stays "/"). */
declare function pathLabel(p: string): string;
/**
 * Whether a listener at node `listener` gets a message addressed to `to`
 * (both absent = the root, the main thread, as before node paths):
 * "direct" when it is that node, "observed" when it is an ancestor (the
 * root observes everything), null otherwise (a sibling or a descendant).
 */
declare function routeTo(listener: string | undefined, to: string | undefined): "direct" | "observed" | null;
/** An approval that lets senders within `from` address nodes within `to`. */
type NodeGrant = {
  from: string;
  to: string;
  until: number;
};
/**
 * May a sender at node `from` address node `to`? Always into its own
 * subtree, always upward (its parent, any ancestor, the root), else only
 * under a live grant covering both. The error names the common ancestor,
 * whose listener (or the root's) may grant it.
 */
declare function mayAddress(from: string, to: string, grants?: readonly NodeGrant[], now?: number): {
  ok: true;
  via: "subtree" | "upward" | "grant";
} | {
  ok: false;
  error: string;
};
/**
 * A draft that starts with "@/words › prefetch " (or "@/words/prefetch ")
 * addresses that node: `to` and the rest of the text. `complete` is false
 * while the address is still being typed (no space after it yet). Null when
 * the draft is not an address.
 */
declare function parseAddress(draft: string): {
  to: string;
  text: string;
  complete: boolean;
} | null;
/** The node paths offered while typing "@/…": those starting with what is typed, shortest first. */
declare function completeNode(partial: string, nodes: readonly string[]): string[];
/** A node's hue (0–359), from its path: the log line's left border. */
declare function nodeHue(p: string): number;
/**
 * What a log line shows about nodes: the node it belongs to (an agent's
 * `taskPath`, else the owner's target `to`), the muted subtitle ("/words ›
 * prefetch", "→ /words › prefetch", or "/a › b → /c" for agent→agent), and
 * its left-border colour. Nothing for a main-thread line without a node.
 */
declare function lineNode(m: {
  from: string;
  taskPath?: string;
  to?: string;
}): {
  node: string;
  subtitle: string;
  border: string;
} | null;
//#endregion
export { APPROVAL_MS, AvatarSrc, BUSY_AFTER_REPLY_MS, BUSY_MS, CHAT_HISTORY, CHAT_MS, ChatMessage, ControllerMessage, EVAL_GRANT_MS, EditMark, EditedEvent, HubState, MAX_AGENT_ID, MAX_CHAT, MAX_CODE, MAX_EDITS, MAX_LABEL, MAX_NODE_PATH, MAX_RESULT, MessageSource, NodeGrant, PAGES_GONE_MS, PAGE_DEBOUNCE_MS, PENDING_MS, PageInfo, PageMessage, PairInfo, ROOT_NODE, Scope, Sender, agentIdOf, applyEdit, chatText, cleanLabel, commonAncestor, compile, completeNode, dictatedDraft, draftSource, isPageId, isWithin, lineNode, matchesTarget, mayAddress, nodeHue, nodePath, parseAddress, parseControllerMessage, parsePageMessage, pathLabel, pickLang, pickVoice, routeTo, shortCode, summarize, trimHistory };
//# sourceMappingURL=protocol.d.ts.map