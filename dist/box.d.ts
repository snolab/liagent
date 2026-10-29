import { ChatMessage, PageInfo, PairInfo } from "./protocol.js";

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
/** A page's label is "<path> <user agent>": the path and a short device hint. */
declare function pageHint(label: string): string;
declare const Base: typeof HTMLElement;
/** HH:MM:SS today, YYYY-MM-DD HH:MM before — local time, ISO order. */
declare function when(at: number, now?: Date): string;
/** The chat box element. Plain properties in, callbacks out; see the file header. */
declare class ChatBox extends Base {
  /** Called with each draft that goes out; return false if it could not be sent (the draft is kept). */
  onSend?: (text: string) => boolean;
  /** The user answered a pairing request in the icon row. */
  onAnswer?: (type: AnswerType, p: PairInfo, answer: Answer) => void;
  /** End was pressed on a session in the menu. */
  onEnd?: (s: PairInfo) => void;
  /** End was pressed (and, for this page, confirmed) on one of the user's pages in the menu. */
  onEndPage?: (id: string) => void;
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
  private root?;
  private open;
  private menuOpen;
  private offline;
  private seen;
  private pos;
  private draft;
  private settledLen;
  private composing;
  private shiftEnter;
  private timer?;
  private lastGripTap;
  private dragged;
  private els;
  get messages(): ChatMessage[];
  /** Replace the log (history on connect): never read aloud. */
  set messages(v: ChatMessage[]);
  /** One message that arrived live: kept once per id; an agent's is read aloud. */
  push(m: ChatMessage): void;
  /**
   * One busy beat from the agent: the spinner shows for BUSY_MS unless the
   * next beat renews it or a reply ends it. A beat right after a reply
   * (BUSY_AFTER_REPLY_MS) is that work's tail, and ignored.
   */
  beat(at?: number): void;
  set live(v: boolean);
  get live(): boolean;
  /** Agents listening now (shown in the status). */
  set listeners(v: number);
  /** Approved sessions: an icon each for eval, and a line with End in the menu. */
  set sessions(v: PairInfo[]);
  /** A pairing waiting for the owner's answer. */
  set pending(v: PairInfo | null);
  /** Code just ran on this page: the eval icons pulse. */
  set evalRan(v: boolean);
  /** The agent is working: a spinner in the icon row. */
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
  /** Open or collapsed on first visit (later visits remember). Attribute: collapsed. */
  set defaultOpen(v: boolean);
  set placeholder(v: string);
  /** Per-device settings live under this prefix (attribute storage-key; default "liagent"). */
  private key;
  private read;
  private write;
  /** Whether agent replies are read aloud on this device (on unless turned off). */
  get speaking(): boolean;
  /**
   * Read a reply aloud, after any still being read: the language comes from
   * its script, with a matching installed voice if there is one.
   */
  speak(text: string): void;
  connectedCallback(): void;
  disconnectedCallback(): void;
  /** A tap anywhere outside the menu and its grip closes the menu. */
  private outside;
  private build;
  /** The log is click-through, so it can't be swiped: a vertical swipe on the input scrolls it. */
  private swipeScrollsLog;
  /**
   * Drag the box by `el` anywhere on screen: an offset from its bottom-right
   * home, kept on screen and remembered. A press that moves under 5 px is
   * still a click.
   */
  private dragHandle;
  /** The click that ends a drag is not a click. */
  private wasDrag;
  private disarm;
  private arm;
  /** Send the draft now. Kept (and the status says so) if it could not go out. */
  submit(): void;
  private setOpen;
  private setMenu;
  private status;
  private renderAll;
  private renderStatus;
  private unread;
  private renderIcons;
  /**
   * A pairing request, compact: its code, what it asks for, Allow and ✕ —
   * and, for code on a user with more than one page open, a checkbox per
   * page (this one ticked) plus "all pages". Chat is always every page. An agent that did not say what
   * it wants (an older client) gets the two old answers: code (8h) and chat.
   */
  private renderAsk;
  private renderLog;
  private renderInput;
  private renderMenu;
}
/** Register the element (once) under `tag`. Returns the class. */
declare function defineChatBox(tag?: string): typeof ChatBox;
//#endregion
export { Answer, AnswerType, ChatBox, defineChatBox, pageHint, when };
//# sourceMappingURL=box.d.ts.map