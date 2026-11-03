import { ChatContext, ContextFile } from "./protocol.js";
import { o as TreeStrings } from "./tree-B1QbJYuB.js";

//#region src/attach.d.ts
/** Where an action shows: in the + menu, or as a bar button at its start or end. */
type ActionPlace = "menu" | "leading" | "trailing";
/** What an action's callbacks get from the box. */
type ActionHost = {
  /** Attach to the line being typed (merged with what is attached already). */attach(ctx: ChatContext): void; /** Focus the box's input. */
  focus(): void; /** Close the + menu (it closes by itself after a pick). */
  close(): void; /** Show a short notice over the input (an upload that failed…). */
  notice(text: string): void; /** The box itself, for anything else. */
  box: HTMLElement;
};
/**
 * One item of the + menu, or one bar button. Plain data and callbacks, no
 * framework element: any UI stack can register them.
 */
type ChatAction = {
  /** Unique among the box's actions; also the element's data-action. */id: string; /** The row's text, or the button's accessible name. Shown as text. */
  label: string;
  /**
   * A glyph (text, e.g. "＋" or "❝"), or a Node (an <svg> the host built) that
   * is cloned for each render. Never parsed as HTML.
   */
  icon?: string | Node; /** Where it goes (default "menu"). */
  place?: ActionPlace; /** The menu group heading it sits under (default: none, at the top). */
  group?: string; /** A muted second line in the menu (what would be attached…). */
  hint?: () => string | undefined; /** Off: shown disabled. Read on every render. */
  enabled?: () => boolean; /** Tells the box when `enabled` or `hint` may have changed; returns an unsubscribe. */
  subscribe?: (changed: () => void) => () => void; /** Do it. */
  onSelect?: (host: ActionHost) => void | Promise<void>;
  /**
   * Attach something: the result is merged into what goes with the next line
   * (null: nothing). Runs after onSelect when both are given.
   */
  attach?: (host: ActionHost) => ChatContext | null | undefined | Promise<ChatContext | null | undefined>; /** The line it attached to went out (a kept selection is let go). */
  sent?: () => void;
};
/** The actions for one place, in the host's order; a later duplicate id is dropped. */
declare function actionsAt(list: readonly ChatAction[], place: ActionPlace): ChatAction[];
/** The menu's actions grouped: ungrouped first, then each group in first-seen order. */
declare function menuGroups(list: readonly ChatAction[]): {
  group?: string;
  items: ChatAction[];
}[];
/** Whether an action can be picked now (a throwing `enabled` counts as off). */
declare function actionEnabled(a: ChatAction): boolean;
/** How long a remembered selection stays attachable. */
declare const SELECTION_TTL_MS: number;
/** A remembered selection: what can be attached, and when it was made. */
type PageSelection = ChatContext & {
  selection: string;
  at: number;
};
/** The slice of an element read here (the DOM's, or a test's fake). */
type ElLike = {
  tagName?: string;
  type?: string;
  value?: string;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  getAttribute?(name: string): string | null;
  closest?(selector: string): unknown;
  parentElement?: ElLike | null;
  nodeType?: number;
};
/** The box's own elements: a selection in them is never attached. */
declare const CHAT_FENCE = "liagent-chat, [data-liagent-chat]";
/** Marks a part of a page whose text is never captured (any page may use it). */
declare const SENSITIVE = "[data-sensitive], [data-liagent-sensitive]";
/** A field (or a part of the page) whose text must never be attached. */
declare function isSensitive(el: ElLike | null | undefined): boolean;
type SelectionDoc = {
  activeElement: ElLike | null;
  getSelection(): {
    rangeCount: number;
    isCollapsed: boolean;
    anchorNode: ElLike | null;
    focusNode: ElLike | null;
    toString(): string;
    getRangeAt?(i: number): {
      intersectsNode(n: unknown): boolean;
    };
  } | null; /** The fenced elements a selection must not cross. */
  querySelectorAll?(selector: string): ArrayLike<unknown>;
  addEventListener(type: string, f: (e: {
    target: unknown;
  }) => void, capture?: boolean): void;
  removeEventListener(type: string, f: (e: {
    target: unknown;
  }) => void, capture?: boolean): void;
};
type SelectionDeps = {
  doc: SelectionDoc; /** Whether a node is part of the chat itself. */
  inChat(node: unknown): boolean; /** Where the page is: path, title, and host when it matters. */
  where(): Omit<ChatContext, "selection" | "files">; /** Extra fences (selectors) besides CHAT_FENCE and SENSITIVE. */
  fence?: string;
  now?: () => number;
};
/** What is selected now outside the chat: "" when nothing, null when it must be left alone. */
declare function readSelection(d: Pick<SelectionDeps, "doc" | "inChat" | "fence">): string | null;
type SelectionMemory = ReturnType<typeof createSelectionMemory>;
/**
 * The last non-empty selection made outside the chat. Cleared by a press
 * elsewhere on the page that leaves nothing selected, by clear(), and when
 * older than SELECTION_TTL_MS.
 */
declare function createSelectionMemory(d: SelectionDeps): {
  start(): () => void; /** The kept selection while it is fresh. */
  get(): PageSelection | null;
  clear: () => void; /** Fence more of the page (selectors whose text is never attached); never removed. */
  addFence(selector: string | undefined): void;
  subscribe(f: () => void): () => undefined; /** For tests: run the handlers as the DOM would. */
  _events: {
    onDown: (e: {
      target: unknown;
    }) => void;
    onChange: () => void;
  };
};
/** One line of a selection, for a chip: whitespace collapsed. */
declare const oneLine: (s: string) => string;
/**
 * The page's selection memory, made and started once (every copy of the
 * module shares it, on globalThis). Null where there is no DOM. Each
 * caller's `fence` is added to it; `host` is the first caller's.
 */
declare function pageSelection(opts?: {
  host?: boolean;
  fence?: string;
}): SelectionMemory | null;
type SelectionActionOptions = {
  id?: string;
  label?: string; /** The hint when nothing is selected. */
  none?: string;
  icon?: string | Node;
  group?: string;
  place?: ActionPlace; /** Send the page's host too (a box embedded on other sites). */
  host?: boolean; /** More selectors whose text is never attached. */
  fence?: string; /** The memory to use (tests, or a host's own); default: the page's. */
  memory?: SelectionMemory | null;
};
/** "Attach the selection": the page's last selection outside the box, as context. */
declare function selectionAction(o?: SelectionActionOptions): ChatAction;
/** What a host's upload hook returns for one file. */
type UploadedFile = ContextFile;
type FileActionOptions = {
  /** The host uploads the file and says where it is now (throw to refuse). */upload: (file: File) => Promise<UploadedFile>;
  id?: string;
  label?: string;
  icon?: string | Node;
  group?: string;
  place?: ActionPlace; /** The picker's accept (default: any file). */
  accept?: string;
  multiple?: boolean; /** The notice when an upload throws. */
  failed?: (file: File, err: unknown) => string; /** The picker (tests): default an <input type="file">. */
  pick?: (accept: string | undefined, multiple: boolean) => Promise<File[]>;
};
/** "Attach a file": the host's upload hook, each result attached as a file. */
declare function fileAction(o: FileActionOptions): ChatAction;
/** "Attach a photo or video": fileAction for media (image, video, audio). */
declare function mediaAction(o: FileActionOptions): ChatAction;
//#endregion
//#region src/ui-strings.d.ts
type UiStrings = {
  stateTree: string;
  closeTree: string;
  noTreeSource: string;
  lastDone: string;
  nowDoing: string;
  upNext: string;
  needsYou: string;
  items: string; /** The mark on a voice line the agent polished (its tooltip and label). */
  polished: string; /** The + button (its label and tooltip), and the menu's name. */
  attachOpen: string; /** The × on what is attached to the next line. */
  attachRemove: string; /** The accessible name of the attached selection's quote. */
  attachQuoted: string; /** A file attached (its accessible prefix). */
  attachFile: string; /** Echo cancellation in the menu, when a mic is in the box. */
  echoOn: string;
  echoOff: string;
};
declare const UI_EN: UiStrings;
declare const UI_ZH: UiStrings;
/** The tree's strings in Chinese (tree.ts TreeStrings). */
declare const TREE_ZH: TreeStrings;
/** The page's language is Chinese. */
declare function isZh(lang?: string | null | undefined): boolean;
/** The box's strings for the page's language. */
declare const uiStrings: (lang?: string | null) => UiStrings;
/** The tree's defaults for the page's language, under the host's own. */
declare const treeDefaults: (lang?: string | null) => Partial<TreeStrings>;
//#endregion
//#region src/speak-rules.d.ts
/**
 * Which agent lines are read aloud. Every line is shown in the log; this
 * decides only whether it is also spoken. There is no time of day in it.
 *
 * 1. A quiet line (`quiet: true`, `liagent say --quiet`: FYI, progress,
 *    notices) is never read, even with a mic on.
 * 2. A hidden page (another tab, the app in the background, the screen
 *    locked: `document.visibilityState` "hidden") never speaks; browsers
 *    would not let it. The box also stops a reading under way when the page
 *    hides.
 *
 * Everything else is read by the usual rules (read-aloud on, or a mic on).
 * Pure: test/speak-rules.test.ts.
 */
/** What a line says about being read aloud (ChatMessage's `quiet`). */
type SpeakMeta = {
  quiet?: unknown;
};
/** Quiet: `say --quiet`. Only boolean true counts. */
declare const isQuiet: (m: SpeakMeta) => boolean;
/** Why a line is not read aloud; null = read it (by the usual rules). */
type Silence = "hidden" | "quiet";
/** The rules: a quiet line, then a hidden page. */
declare function silenceFor(m: SpeakMeta, at: {
  hidden: boolean;
}): Silence | null;
/** The page is hidden or the screen is locked (true without a document: never speak there). */
declare const pageHidden: () => boolean;
/**
 * Per-device setting names an older version saved (under the box's
 * storage-key) that mean nothing now. The box removes them when it attaches.
 */
declare const RETIRED_SETTINGS: readonly ["quiet-hours"];
//#endregion
export { createSelectionMemory as A, SelectionActionOptions as C, UploadedFile as D, SelectionMemory as E, oneLine as F, pageSelection as I, readSelection as L, isSensitive as M, mediaAction as N, actionEnabled as O, menuGroups as P, selectionAction as R, SENSITIVE as S, SelectionDoc as T, ChatAction as _, pageHidden as a, PageSelection as b, UI_EN as c, isZh as d, treeDefaults as f, CHAT_FENCE as g, ActionPlace as h, isQuiet as i, fileAction as j, actionsAt as k, UI_ZH as l, ActionHost as m, Silence as n, silenceFor as o, uiStrings as p, SpeakMeta as r, TREE_ZH as s, RETIRED_SETTINGS as t, UiStrings as u, ElLike as v, SelectionDeps as w, SELECTION_TTL_MS as x, FileActionOptions as y };
//# sourceMappingURL=speak-rules-DA130XN6.d.ts.map