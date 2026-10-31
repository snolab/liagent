import { AvatarSrc, ChatMessage, EditedEvent, MessageSource, PageInfo, PairInfo, Sender } from "./protocol.js";
import { a as TreeSource, o as TreeStrings } from "./tree-CZ50sZNq.js";
import { r as VoicePreference } from "./voice-pick-BL3ttnwt.js";
import { i as UiStrings } from "./ui-strings-DM_Rvgjx.js";

//#region src/avatar.d.ts
/** What a line's avatar shows, as box.ts draws it. */
type LineAvatar = {
  /** URLs to try in order (empty: the element, or the initial). */srcs: string[]; /** The agent's logo as an element (cloned per line), when it is not a URL. */
  node?: Element; /** The alt text and the screen-reader name: the sender's name, or "you". */
  name: string; /** Whose initial the fallback shows (the viewer's own name on "you" lines). */
  initialFrom: string;
  seed: string;
  mine: boolean;
};
/** A short, stable hash (FNV-1a, 32 bits, base 36). */
declare function hashId(s: string): string;
/** The URLs in an AvatarSrc, in order, empty ones dropped. */
declare function avatarSrcs(src: AvatarSrc | null | undefined): string[];
/** The fallback's letter: the name's first grapheme, upper-cased; "?" for none. */
declare function initialOf(name: string | undefined): string;
/**
 * The fallback's colours for a seed: oklch(0.7 0.12 <hue>), the hue from a
 * hash so a person keeps one colour, the letter in whichever ink contrasts
 * more (at least 4.5:1 on every hue).
 */
declare function avatarColors(seed: string): {
  bg: string;
  fg: string;
  hue: number;
};
/**
 * A line's avatar. The agent's is `agentAvatar` (the host app's logo, a URL
 * or an element) named by its label. Anyone else's comes from `avatarFor`
 * (the host's resolver), else the line's own `sender`; the viewer's own
 * lines (owner lines on the owner's page, friend lines on a friend's) fill
 * the gaps from `user` and are named "you".
 */
declare function lineAvatar(m: ChatMessage, opts: {
  friend?: boolean;
  user?: Sender;
  agentAvatar?: AvatarSrc | Element | null;
  avatarFor?: (m: ChatMessage) => Sender | null | undefined;
}): LineAvatar;
//#endregion
//#region src/box.d.ts
type AnswerType = "allow" | "deny";
/**
 * What the user chose in a pairing request: the pages to allow (their ids,
 * or "all", including pages that open later), and — for an older agent that
 * did not say which scope it wants — "chat" when they tapped the 30-day chat
 * button rather than the hour.
 */
type Answer = {
  pages?: string[] | "all";
  scope?: "chat";
};
/**
 * A voice output the host plugs in (box.voice): replies are read through it
 * instead of speechSynthesis. `id` is the message's id; `stop` gets why
 * ("typing", "off").
 */
type ChatVoice = {
  speak(text: string, id?: string): void;
  stop(why?: string): void;
};
/** A page's label is "<path> <user agent>": the path and a short device hint. */
declare function pageHint(label: string): string;
declare const Base: typeof HTMLElement;
/** HH:MM:SS today, YYYY-MM-DD HH:MM before — local time, ISO order. */
declare function when(at: number, now?: Date): string;
/** The chat box element. Plain properties in, callbacks out; see the file header. */
declare class ChatBox extends Base {
  static get observedAttributes(): string[];
  /**
   * Called with each draft that goes out, and the state-tree node it is
   * addressed to (absent = the main thread); `opts.source` is "stt" when the
   * line is dictation, sent unchanged. Return false if it could not be sent
   * (the draft is kept).
   */
  onSend?: (text: string, to?: string, opts?: {
    source?: MessageSource;
  }) => boolean;
  /** The user answered a pairing request. */
  onAnswer?: (type: AnswerType, p: PairInfo, answer: Answer) => void;
  /** End was pressed on a session in the menu. */
  onEnd?: (s: PairInfo) => void;
  /** End was pressed (and, for this page, confirmed) on one of the user's pages in the menu. */
  onEndPage?: (id: string) => void;
  /**
   * The host's avatar for a line that is not the agent's: its pictures are
   * tried first, its name and id fill in. Return nothing to use the line's
   * `sender` (and, on the user's own lines, `userAvatar`).
   */
  avatarFor?: (m: ChatMessage) => Sender | null | undefined;
  /**
   * A voice output (`{ speak(text, id?), stop(why?) }`): replies are read
   * through it instead of speechSynthesis. Typing calls `stop("typing")`.
   */
  voice?: ChatVoice | null;
  /**
   * Read-aloud's voice when the box reads with speechSynthesis itself (no
   * `voice` set): `lang` forces the language, `prefer` lists voice names to
   * try first (exact, then substring; src/voice-pick.ts). With `voice` set,
   * give the same to `voice({ lang, prefer })` instead.
   */
  voicePrefer?: VoicePreference | null;
  private _messages;
  private _live;
  private _listeners;
  private _sessions;
  private _pending;
  private _evalRan;
  private _busy;
  private busyTimer?;
  private lastReplyAt;
  private _pages;
  private _self;
  /** The pages ticked in the pairing request, per pair id. */
  private picked;
  /** The page whose End was tapped once (this page needs a second tap). */
  private confirmEnd;
  private _friend;
  private _notice;
  private _warning;
  private _defaultOpen;
  private _placeholder;
  private _treeSource?;
  /** `owner/repo` that a bare `#123` in the tree links to. */
  treeRepo?: string;
  /** The tree's strings (English defaults; Chinese on a zh page). */
  treeStrings: Partial<TreeStrings>;
  private _strings;
  private _agentAvatar;
  private _user;
  /** The nodes agents listen at: "@/…" completions. */
  private _nodes;
  /** The node the next line goes to ("/" = the main thread, no chip). */
  private _target;
  /** Polished lines shown as first heard (their mark tapped). */
  private rawIds;
  private root?;
  private open;
  private panel;
  private offline;
  private pos;
  private _draft;
  /** The draft as dictation left it while nothing typed is in it (else null). */
  private pure;
  private _partial;
  private _micActive;
  /** The input has focus: the log opens. */
  private typing;
  /** The mark is held: the input shows how to use it. */
  private holding;
  private settledLen;
  private composing;
  private shiftEnter;
  private timer?;
  private els;
  private markDrag;
  private taps;
  private atEnd;
  private arrivals;
  private readSeq;
  private wasOpen;
  private floats;
  private floatHover;
  /** The frontier group opened by a tap (closed again on each minimize). */
  private frontierOpen;
  private place;
  private ro?;
  private treeStop?;
  private treeRoot;
  private treeError;
  private navIx;
  private nav;
  private treeAxis;
  private treeDragged;
  private treePress;
  private userScrollAt;
  get messages(): ChatMessage[];
  /** Replace the log (history on connect): never read aloud. */
  set messages(v: ChatMessage[]);
  /** One message that arrived live: kept once per id; an agent's is read aloud. */
  push(m: ChatMessage): void;
  /**
   * The agent polished a voice line ({type:"edited"}): it changes in place,
   * and is never read aloud again.
   */
  edit(e: Omit<EditedEvent, "type">): void;
  /**
   * One busy beat from the agent: the spinner shows for BUSY_MS unless the
   * next beat renews it or a reply ends it. A beat right after a reply
   * (BUSY_AFTER_REPLY_MS) is that work's tail, and ignored.
   */
  beat(at?: number): void;
  set live(v: boolean);
  get live(): boolean;
  /** The state-tree nodes agents listen at (the hub's `state.nodes`): "@/…" completions. */
  set nodes(v: string[]);
  /** The node the next line goes to ("/" = the main thread). */
  get target(): string;
  /** Address the next lines to a state-tree node ("/" = back to the main thread). */
  setTarget(path: string): void;
  /** Agents listening now (shown in the status). */
  set listeners(v: number);
  /** Approved sessions: a count on the tree button for eval, and a line with End in the menu. */
  set sessions(v: PairInfo[]);
  /** A pairing waiting for the owner's answer. */
  set pending(v: PairInfo | null);
  /** Code just ran on this page: the eval count pulses. */
  set evalRan(v: boolean);
  /** The agent is working: a spinner in the input. */
  set busy(v: boolean);
  get busy(): boolean;
  /** The user's connected pages (the hub's state.pages): offered when allowing, ended from the menu. */
  set pages(v: PageInfo[]);
  /** Which of `pages` this page is (the hub's state.self). */
  set self(v: string);
  /** A friend's page (not the user's): pairings are previews, with no chat scope to grant. */
  set friend(v: boolean);
  /** Shown instead of the input when this viewer cannot chat. */
  set notice(v: string | undefined);
  /** A one-line note above the input (say, a message dropped by a rate limit). */
  set warning(v: string | undefined);
  /** Open or minimized on first visit (later visits remember). Attribute: collapsed. */
  set defaultOpen(v: boolean);
  /**
   * The state tree (src/tree.ts): a URL serving its markdown, a function
   * returning markdown or nodes, or a feed `{subscribe(onUpdate) → unsubscribe}`.
   * The tree button shows it; it loads again each time the tree opens, and
   * its frontier fills the minimized bar's lines. Unset: "No tree source".
   */
  set treeSource(v: TreeSource | undefined);
  get treeSource(): TreeSource | undefined;
  /** Show the state tree (true) or hide it (false). */
  setTree(v: boolean): void;
  /** The box's own strings (English, or Chinese on a zh page, under these). */
  set strings(v: Partial<UiStrings> | undefined);
  /**
   * The agent's avatar: your app's logo, as a URL (or URLs in fallback
   * order) or an element (cloned onto each line). Attribute: agent-avatar.
   * Unset: the agent name's initial.
   */
  set agentAvatar(v: AvatarSrc | Element | null | undefined);
  get agentAvatar(): AvatarSrc | Element | null | undefined;
  /**
   * The user's picture on their own lines: a URL, or URLs in fallback order
   * (the app's own avatar, then the sign-in provider's image). Attribute:
   * user-avatar.
   */
  set userAvatar(v: AvatarSrc | null | undefined);
  /** The user's name: their fallback avatar's initial. Attribute: user-name. */
  set userName(v: string | null | undefined);
  /** A stable id (or a hash of one, never an email): the user's fallback colour. */
  set userId(v: string | null | undefined);
  /** Re-render the log only when the value changed (wrappers set props on every render). */
  private setUser;
  set placeholder(v: string);
  /** The draft in the input. */
  get draft(): string;
  /**
   * Set the draft. With `source: "stt"` it is dictation: sent unchanged, the
   * line goes out with source "stt" (anything typed into it makes it the
   * user's own). It is never sent by itself while a mic is on.
   */
  setDraft(text: string, opts?: {
    source?: "stt";
  }): void;
  /** A live transcript, shown dimmed after the draft and never committed (null: none). */
  setPartial(text: string | null): void;
  /** A mic is on: treated as focus (the log opens, the box is opaque). Attribute: mic-active. */
  get micActive(): boolean;
  set micActive(v: boolean);
  attributeChangedCallback(name: string): void;
  private applyMic;
  /** Per-device settings live under this prefix (attribute storage-key; default "liagent"). */
  private key;
  private read;
  private write;
  /** The speed setting under this box's storage key. */
  private rateStore;
  /** Whether agent replies are read aloud on this device (on unless turned off). */
  get speaking(): boolean;
  /** How fast replies are read (1, 1.25, 1.5 or 2; per device, picked in the menu). */
  get speechRate(): number;
  /**
   * Read a reply aloud, after any still being read (always while a mic is on):
   * through `voice` if set, else speechSynthesis, in the language its script
   * suggests (with a matching installed voice), at `speechRate`.
   */
  speak(text: string, id?: string): void;
  private stopSpeech;
  connectedCallback(): void;
  disconnectedCallback(): void;
  /** A tap anywhere outside the menu and the mark closes the menu. */
  private outside;
  /** Escape closes the open panel (caught first, so a mic's own Escape never sees it). */
  private escape;
  /** A resize (window, rotation, the visual viewport): the bar stays on screen, the float box re-placed. */
  private relayout;
  private get ui();
  private get treeText();
  private build;
  /**
   * The log is click-through, so it can't be scrolled where it is: a wheel,
   * trackpad or touch scroll over the input scrolls it instead, empty or not.
   * Text that overflows the input scrolls first, and at its end the rest of
   * the gesture goes on to the log (src/scroll-handoff.ts). A move the input
   * scrolls itself is never cancelled, and a tap still places the caret.
   */
  private swipeScrollsLog;
  /**
   * Drag the box by `el` anywhere on screen: an offset from its bottom-right
   * home, the bar kept on screen (up to the notch) and remembered. A press
   * that moves under 5 px is still a click.
   */
  private dragHandle;
  private setHolding;
  /**
   * Bring the bar back on screen (after expanding where the minimized bar
   * was, or on a smaller screen). Expanded, the bar spans the box, so the
   * box's own edges count.
   */
  private fit;
  /**
   * The tree button: a tap opens or closes the tree; a horizontal drag (axis
   * locked after 8 px) moves the focused node through its detents — right
   * opens it a level per cell, left folds it (src/tree-nav.ts) — with a live
   * preview, resisting past a limit, committed on release. A vertical drag
   * does nothing. Arrow keys on it move in the open tree.
   */
  private treeGestures;
  /** While dragging: the focused node and the depth it would open to, following the finger. */
  private showTreeHint;
  /** (Re)load the tree: once for a URL or function, a subscription for a feed. Never polls. */
  private loadTree;
  private setRoot;
  private setNav;
  /**
   * One nav step. After it, an expand brings the focused node and its new
   * children into view (unless the user is scrolling); a fold keeps the
   * focused row where it was.
   */
  private navTo;
  private renderTree;
  /** The floating tree overflows (or is scrolled): its top edge fades, as the log's. */
  private treeFade;
  private disarm;
  private arm;
  /**
   * Send the draft now, as Enter would; true if it went out. Kept (and the
   * status says so) if it could not.
   */
  submit(): boolean;
  private clearDraft;
  /**
   * The input grows with its text up to INPUT_MAX_PX, then scrolls inside
   * itself. Empty, it is one line (nothing measured: a placeholder measured
   * in a narrow slot wraps to several lines).
   */
  private fitInput;
  /** The draft's "@/…" while it is typed: the listening nodes under it. */
  private completions;
  private pick;
  private renderPlaceholder;
  /** The live transcript: a mirror of the draft, invisible, then the partial text dimmed. */
  private renderPartial;
  /** The target chip (× back to the main thread) and the "@/…" completions. */
  private renderAim;
  private setOpen;
  private setPanel;
  /** The log opens to 30vh while the input has focus, a mic is on, or the tree is open. */
  private wide;
  private status;
  private renderAll;
  /** Open or minimized, which panel, the column's size: the box's frame. */
  private renderLayout;
  private renderStatus;
  /** The eval/preview sessions on the tree button: their count, pulsing when code just ran. */
  private renderEvals;
  /** The spinner in the input while the agent works. */
  private renderBusy;
  /** A pairing request above the bar. */
  private renderAsks;
  /**
   * A pairing request, compact: its code, what it asks for, Allow and ✕ —
   * and, for code on a user with more than one page open, a checkbox per
   * page (this one ticked) plus "all pages". Chat is always every page. An agent that did not say what
   * it wants (an older client) gets the two old answers: code (8h) and chat.
   */
  private renderAsk;
  /** A polished line's body (its text, or tapped, the raw STT text) and its sparkle. */
  private lineBody;
  private renderLog;
  private toEnd;
  private onColumnScroll;
  /**
   * After the messages (or open/minimized) changed: what arrived (by id, on
   * this device's clock), what is read, and what floats. Expanded, everything
   * is read and nothing floats; just minimized, the latest floats again;
   * minimized, every new line floats — never the history loading in.
   */
  private messagesChanged;
  private clearFloats;
  private addFloat;
  private dropFloat;
  /** "who: text" (the latest copy: an edit changes it in place), and a polished line's sparkle. */
  private fillFloat;
  private renderFloatTexts;
  /** Hovered or touched: every line's timer waits; released, they go on. */
  private holdFloats;
  private renderFrontier;
  /** The float box on the bar's side of the screen, inside the viewport and its safe areas (anchor.ts). */
  private placeFloat;
  private renderInput;
  private renderMenu;
}
declare function defineChatBox(tag?: string): typeof ChatBox;
//#endregion
export { defineChatBox as a, avatarColors as c, initialOf as d, lineAvatar as f, ChatVoice as i, avatarSrcs as l, AnswerType as n, pageHint as o, ChatBox as r, when as s, Answer as t, hashId as u };
//# sourceMappingURL=box-DSnEVzkd.d.ts.map