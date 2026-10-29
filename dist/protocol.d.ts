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
/** One line of the chat, as the hub stores and sends it. */
type ChatMessage = {
  id: string;
  from: "owner" | "agent" | "friend";
  label: string;
  text: string;
  at: number;
  thread?: string;
};
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
  self: string;
};
type ControllerMessage = {
  type: "eval";
  code: string;
  target?: string;
} | {
  type: "say";
  text: string;
  to?: string;
} | {
  type: "busy";
  to?: string;
  on?: boolean;
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
} | {
  type: "chat";
  id: string;
  text: string;
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
//#endregion
export { APPROVAL_MS, BUSY_AFTER_REPLY_MS, BUSY_MS, CHAT_HISTORY, CHAT_MS, ChatMessage, ControllerMessage, EVAL_GRANT_MS, HubState, MAX_CHAT, MAX_CODE, MAX_LABEL, MAX_RESULT, PAGES_GONE_MS, PAGE_DEBOUNCE_MS, PENDING_MS, PageInfo, PageMessage, PairInfo, Scope, chatText, cleanLabel, compile, isPageId, matchesTarget, parseControllerMessage, parsePageMessage, pickLang, pickVoice, shortCode, summarize, trimHistory };
//# sourceMappingURL=protocol.d.ts.map