import { S as ProgressView, m as ProgressEntry } from "./progress-CfE-meHr.js";

//#region src/state-tree.d.ts
/**
 * The state tree: a hand-edited markdown outline of what is in flight and
 * what waits on the owner, parsed into nodes for a read-only view
 * (tree.ts, <liagent-state-tree>) and a three-line frontier (done / doing / next). Pure and
 * generic — no app specifics, no imports.
 *
 * Syntax:
 *   ## Heading              a top-level node
 *   - item                  a node, nested by indent under the item above it
 *   - [ ] / [~] / [!] / [x] open / in progress / blocked / done
 *   (!)                     anywhere in an item: it waits on the owner
 *   (any order)             anywhere in an item: its children are unordered
 *   (done 2026-10-30T01:12) on a done item: when (the latest is "most recent")
 *   … @name                 a trailing token: the assignee. `@owner` is the
 *                           human owner, any other `@slug` an agent. Children
 *                           without their own inherit the nearest ancestor's.
 *   … @slug#id              an agent with an opaque id ([A-Za-z0-9_-], up to
 *                           40; anything else is dropped). Humans get none.
 *   → command or URL        a line under an item: its action (several join with "\n")
 *   ≈ done: … · doing: … · next: …
 *                           a line under a node (or before the first `##`, for
 *                           the whole tree): one-phrase summaries of its done,
 *                           doing and next groups, written by the agent that
 *                           edits the tree. Bare `≈` is zh (a 4-character
 *                           成语); `≈en`, `≈ja`, … are other locales.
 *   #123                    a PR in `opts.repo` (no repo: not a link)
 *   owner/repo#45           a PR in that repo
 *   https://…               a link
 *   <!-- … -->              a comment: ignored
 * Other lines under an item are its note (unindented after a heading's list:
 * the heading's note); other text outside any `##` or list
 * (a `#` title, a legend paragraph) is ignored. Siblings are in sequence: file
 * order is the order of work, unless the parent is `(any order)`.
 */
type TreeLink = {
  text: string;
  url: string;
};
type TreeStatus = "open" | "doing" | "blocked" | "done";
type Assignee = {
  type: "human" | "agent";
  name: string; /** An agent's opaque id from `@name#id` ([A-Za-z0-9_-], up to 40); never a human's. */
  id?: string;
};
/** One status group's summary per locale. */
type TreeSummary = {
  done?: string;
  doing?: string;
  next?: string;
};
type TreeNode = {
  title: string; /** From the box: undefined when the item has none. */
  status?: TreeStatus; /** true `[x]`, false any other box, undefined when the item has none. */
  done?: boolean; /** Marked `(!)`: waits on the owner. */
  needsOwner?: boolean; /** Marked `(any order)`: the children are not in sequence. */
  unordered?: boolean; /** `(done …)` on a done item, as written (ISO, so it sorts as text). */
  doneAt?: string; /** Its own trailing `@name`, or the nearest ancestor's. */
  assignee?: Assignee; /** The `→ ` lines under the item: a command or a URL (several join with "\n"). */
  action?: string; /** Any other text under the item. */
  note?: string; /** The `≈` lines, by locale (bare `≈` is "zh"). */
  summaries?: Record<string, TreeSummary>;
  links: TreeLink[];
  children: TreeNode[];
};
type ParseOptions = {
  /** `owner/repo` that a bare `#123` points at. */repo?: string; /** Default https://github.com. */
  host?: string;
};
/** Name of the human owner as an assignee token: `@owner`. */
declare const OWNER_NAME = "owner";
/** PR refs and URLs in `text`, in order, each once. */
declare function findLinks(text: string, opts?: ParseOptions): TreeLink[];
/** `@owner` is the human; anything else an agent. */
declare function assigneeOf(name: string, id?: string): Assignee;
/**
 * Parse the whole document into a root node (title "") whose children are the
 * top-level nodes and whose summaries are the `≈` lines before the first `##`.
 * Never throws: odd indentation nests under the nearest shallower item.
 */
declare function parseTreeDoc(md: string, opts?: ParseOptions): TreeNode;
/** The top-level nodes (parseTreeDoc's root children). */
declare function parseTree(md: string, opts?: ParseOptions): TreeNode[];
/** Open (not done) items below `n`, and those of them that wait on the owner. */
declare function countOpen(n: TreeNode): {
  open: number;
  needsOwner: number;
};
/**
 * Only the open `(!)` items and their ancestors (the "Needs me" view). A
 * matching item keeps only those of its children that match too.
 */
declare function filterNeedsOwner(nodes: TreeNode[]): TreeNode[];
/** An item and the titles of its ancestors (its breadcrumb). */
type FrontierItem = {
  node: TreeNode;
  path: string[];
  title: string;
  assignee?: Assignee;
};
/**
 * One frontier line. `node`/`path` is the one item it shows without a
 * summary (done: the most recent; doing: the first, an open `(!)` item before
 * any `[~]`; next: the first not started after it). With several items and a
 * `≈` summary for the UI locale (or zh, or en), `summary` is that phrase.
 * `items` lists the group in order, each with its own assignee.
 */
type FrontierEntry = FrontierItem & {
  count: number;
  summary?: string;
  items: FrontierItem[];
};
type Frontier = {
  done?: FrontierEntry;
  doing?: FrontierEntry;
  next?: FrontierEntry;
};
type FrontierOptions = {
  /** The UI locale, e.g. "ja" or "zh-CN". Summaries fall back to zh, then en. */locale?: string; /** Titles from the top down to the subtree to look at (default: all). */
  scope?: string[];
};
/** The summary list to try: the locale, its language, zh, en. */
declare function localeChain(locale?: string): string[];
/**
 * The three lines: ✓ the most recently done, ▶ in progress (an open `(!)`
 * item before any `[~]`), › the next not yet started. Blocked items are on
 * none of them, unless they wait on the owner.
 */
declare function frontier(input: TreeNode | TreeNode[], opts?: FrontierOptions): Frontier;
/** `/words › Learning Partner` */
declare const crumbs: (path: string[]) => string;
//#endregion
//#region src/progress-tree.d.ts
/** The live part of a node's note: "40% · ETA 15m · needs: … · <latest note>". */
declare function liveNote(e: ProgressEntry): string;
type OverlayOptions = ParseOptions & {
  /** The heading that slug ids (no path) go under. Default "Live". */liveTitle?: string;
};
/**
 * Lay the hub's nodes over the outline (parseTreeDoc's root). Path ids walk
 * the outline segment by segment ("/words" is the heading whose first word
 * is /words; deeper segments match an item's first word or its whole title
 * as a slug), adding what is missing; a slug id goes under a "Live" heading.
 * Groups and people are structure only. `opts.repo` makes `pr` a link. The
 * input is not changed.
 */
declare function overlayProgress(base: TreeNode, entries: readonly ProgressEntry[], opts?: OverlayOptions): TreeNode;
/** The slice of a WebSocket the feed uses (a browser's, or a fake in tests). */
type FeedSocket = {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: {
    data: unknown;
  }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send?(data: string): void;
  close(): void;
};
type FeedOptions = {
  /** The hub's reader WebSocket URL (ws:// or wss://; http(s):// is converted). */url: string;
  socket?: (url: string) => FeedSocket;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void; /** Called with a function to run when the network or the tab comes back; returns its remover. */
  onWake?: (fn: () => void) => () => void;
};
/**
 * A live progress feed: `subscribe` gets the view on every hub message (and
 * `live` false when the socket is lost); `resolve` checks a node off on an
 * open socket ({type:"resolve", id, note?}) — false when none is open.
 */
type ProgressFeed = {
  subscribe(onView: (view: ProgressView, live: boolean) => void): () => void;
  resolve(id: string, note?: string): boolean;
};
/** Reconnect delays: 1 s doubling to 60 s; after GIVE_UP failures in a row, wait for a wake. */
declare const FEED_MAX_DELAY_MS = 60000;
declare const GIVE_UP = 10;
/** ws(s):// for an http(s):// URL; a relative path resolves against the page. */
declare function progressSocketUrl(url: string, base?: string): string;
/** Wake on `online` and on the tab becoming visible (a no-op outside a browser). */
declare const browserWake: (fn: () => void) => (() => void);
/** The reader's side of the progress hub: one socket per subscriber, reconnecting with backoff. */
declare function progressFeed(opts: FeedOptions): ProgressFeed;
//#endregion
//#region src/tree.d.ts
/** What a source yields: markdown, top-level nodes, or a document root (parseTreeDoc's). */
type TreeValue = string | TreeNode[] | TreeNode;
/**
 * Where the tree comes from: a URL (fetched as markdown), a function
 * returning markdown or nodes, or a feed that pushes: `subscribe(onUpdate)`
 * returns its unsubscribe. `meta.live` marks data from a live source.
 */
type TreeSource = string | (() => TreeValue | Promise<TreeValue>) | {
  subscribe: (onUpdate: (v: TreeValue, meta?: {
    live?: boolean;
  }) => void, onError?: (e: unknown) => void) => () => void;
};
type TreeStrings = {
  tree: string;
  back: string;
  needsMe: string;
  needsYou: string; /** On a collapsed branch: "{n} open", "{n} need you". */
  openCount: string;
  needsYouCount: string;
  copy: string;
  copied: string;
  loading: string;
  failed: string;
  empty: string;
  nothingNeedsYou: string;
  you: string;
  lastDone: string;
  nowDoing: string;
  upNext: string;
  live: string;
};
declare const TREE_STRINGS_EN: TreeStrings;
/** Load a URL or function source once into its document root. */
declare function loadTree(source: Exclude<TreeSource, {
  subscribe: unknown;
}>, opts?: ParseOptions): Promise<TreeNode>;
/**
 * Watch any TreeSource: `onRoot` gets each version (a URL or function once, a
 * feed on every push). Returns the stop function. Never polls.
 */
declare function watchTree(source: TreeSource, opts: ParseOptions, onRoot: (root: TreeNode, live: boolean) => void, onError: (e: unknown) => void): () => void;
type LiveTreeOptions = OverlayOptions & {
  /** The hand-edited outline: any TreeSource (a feed too: each push is overlaid again). */base: TreeSource; /** The progress hub's reader socket URL, a ProgressFeed, or the feed's options. */
  progress: string | ProgressFeed | FeedOptions;
};
/**
 * The outline with live progress laid over it: the base as it loads, then
 * the overlay again on every hub message, with `meta.live` while the hub's
 * socket is up. Without the hub (not deployed, not a reader) the outline
 * shows as it is. Never polls.
 */
declare function liveTreeSource(opts: LiveTreeOptions): TreeSource;
/** localStorage: "1" while the Needs me filter is on (per device). */
declare const NEEDS_ME_KEY = "liagent:tree-needs-me";
declare const Base: typeof HTMLElement;
/** The read-only outline element. Properties in; `onBack` adds a back control. */
declare class StateTreeElement extends Base {
  static observedAttributes: string[];
  /** Set: a ‹ control in the header calls it (the chat box's tree view). */
  onBack?: () => void;
  repo?: string;
  locale?: string;
  strings: Partial<TreeStrings>;
  storageKey: string;
  private _source?;
  private _progress?;
  private _root;
  private live;
  private error;
  private stop?;
  private collapsed;
  private shadow?;
  /** The data: a URL, a function returning markdown or nodes, or a feed. (Re)loads it. */
  set source(v: TreeSource | undefined);
  get source(): TreeSource | undefined;
  /**
   * Live progress over the source: a progress hub's reader socket URL
   * (attribute `progress`) or a ProgressFeed. (Re)loads.
   */
  set progress(v: string | ProgressFeed | undefined);
  get progress(): string | ProgressFeed | undefined;
  /** Set the parsed tree directly (parseTreeDoc's root). */
  set root(v: TreeNode | null);
  get root(): TreeNode | null;
  attributeChangedCallback(n: string, _o: string | null, v: string | null): void;
  /** Load the source again (the chat box calls this each time its menu opens). */
  reload(): void;
  connectedCallback(): void;
  disconnectedCallback(): void;
  private get t();
  private get needsMe();
  render(): void;
  private list;
}
/**
 * The frontier in three lines — ✓ the most recently done, ▶ in progress, ›
 * next — each a ≈ summary (several items) or one item with its context. A
 * group shows 〔N〕 and lists its items on tap. Plain DOM, text only.
 */
declare function frontierLines(root: TreeNode, opts?: {
  locale?: string;
  strings?: Partial<TreeStrings>;
}): HTMLElement;
/** Register the element (once) under `tag`. Returns the class. */
declare function defineStateTree(tag?: string): typeof StateTreeElement;
//#endregion
export { ParseOptions as A, frontier as B, progressSocketUrl as C, FrontierItem as D, FrontierEntry as E, assigneeOf as F, parseTree as H, countOpen as I, crumbs as L, TreeNode as M, TreeStatus as N, FrontierOptions as O, TreeSummary as P, filterNeedsOwner as R, progressFeed as S, Frontier as T, parseTreeDoc as U, localeChain as V, OverlayOptions as _, TreeSource as a, liveNote as b, defineStateTree as c, loadTree as d, watchTree as f, GIVE_UP as g, FeedSocket as h, TREE_STRINGS_EN as i, TreeLink as j, OWNER_NAME as k, frontierLines as l, FeedOptions as m, NEEDS_ME_KEY as n, TreeStrings as o, FEED_MAX_DELAY_MS as p, StateTreeElement as r, TreeValue as s, LiveTreeOptions as t, liveTreeSource as u, ProgressFeed as v, Assignee as w, overlayProgress as x, browserWake as y, findLinks as z };
//# sourceMappingURL=tree-HB9RhX_H.d.ts.map