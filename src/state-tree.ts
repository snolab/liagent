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

export type TreeLink = { text: string; url: string };

export type TreeStatus = "open" | "doing" | "blocked" | "done";

export type Assignee = {
  type: "human" | "agent";
  name: string;
  /** An agent's opaque id from `@name#id` ([A-Za-z0-9_-], up to 40); never a human's. */
  id?: string;
};

/** One status group's summary per locale. */
export type TreeSummary = { done?: string; doing?: string; next?: string };

export type TreeNode = {
  title: string;
  /** From the box: undefined when the item has none. */
  status?: TreeStatus;
  /** true `[x]`, false any other box, undefined when the item has none. */
  done?: boolean;
  /** Marked `(!)`: waits on the owner. */
  needsOwner?: boolean;
  /** Marked `(any order)`: the children are not in sequence. */
  unordered?: boolean;
  /** `(done …)` on a done item, as written (ISO, so it sorts as text). */
  doneAt?: string;
  /** Its own trailing `@name`, or the nearest ancestor's. */
  assignee?: Assignee;
  /** The `→ ` lines under the item: a command or a URL (several join with "\n"). */
  action?: string;
  /** Any other text under the item. */
  note?: string;
  /** The `≈` lines, by locale (bare `≈` is "zh"). */
  summaries?: Record<string, TreeSummary>;
  links: TreeLink[];
  children: TreeNode[];
};

export type ParseOptions = {
  /** `owner/repo` that a bare `#123` points at. */
  repo?: string;
  /** Default https://github.com. */
  host?: string;
};

/** Name of the human owner as an assignee token: `@owner`. */
export const OWNER_NAME = "owner";

const TAB = "  ";
const ITEM = /^(\s*)[-*+]\s+(.*)$/;
const HEADING = /^##\s+(.*)$/;
const ACTION = /^(?:→|->)\s*(.*)$/;
const SUMMARY = /^≈([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)?)?\s+(.*)$/;
const BOX = /^\[([ xX~!])\]\s*/;
const OWNER = /\(!\)/g;
const ANY_ORDER = /\(any order\)/gi;
const DONE_AT = /\(done\s+(\d{4}-\d{2}-\d{2}(?:[T ][\d:]+)?)\)/i;
const ASSIGNEE = /(?:^|\s)@([A-Za-z0-9][\w.-]*)(?:#(\S*))?$/;
/** An agent's opaque id: nothing that could be a host, a pid with a colon, or a token. */
const AGENT_ID = /^[A-Za-z0-9_-]{1,40}$/;
const STATUS: Record<string, TreeStatus> = {
  " ": "open",
  "~": "doing",
  "!": "blocked",
  x: "done",
  X: "done",
};

/** PR refs and URLs in `text`, in order, each once. */
export function findLinks(text: string, opts: ParseOptions = {}): TreeLink[] {
  const host = (opts.host ?? "https://github.com").replace(/\/$/, "");
  const out: TreeLink[] = [];
  const seen = new Set<string>();
  const add = (l: TreeLink) => {
    if (seen.has(l.url)) return;
    seen.add(l.url);
    out.push(l);
  };
  const re =
    /(https?:\/\/[^\s)>\]]+)|(?<![\w/#])([A-Za-z0-9][\w.-]*\/[\w.-]+)#(\d+)\b|(?<![\w/&#])#(\d+)\b/g;
  for (const m of text.matchAll(re)) {
    if (m[1]) {
      const url = m[1].replace(/[.,;:]+$/, "");
      add({ text: url, url });
    } else if (m[2]) add({ text: `${m[2]}#${m[3]}`, url: `${host}/${m[2]}/pull/${m[3]}` });
    else if (m[4] && opts.repo) add({ text: `#${m[4]}`, url: `${host}/${opts.repo}/pull/${m[4]}` });
  }
  return out;
}

const indentOf = (s: string) => s.replaceAll("\t", TAB).length;

/** `@owner` is the human; anything else an agent. */
export function assigneeOf(name: string, id?: string): Assignee {
  if (name === OWNER_NAME) return { type: "human", name };
  return id && AGENT_ID.test(id) ? { type: "agent", name, id } : { type: "agent", name };
}

/** A node from an item's or a heading's text: box, markers, assignee, links. */
function node(raw: string, opts: ParseOptions): TreeNode {
  let text = raw.trim();
  let status: TreeStatus | undefined;
  const box = BOX.exec(text);
  if (box) {
    status = STATUS[box[1]!];
    text = text.slice(box[0].length);
  }
  const needsOwner = OWNER.test(text);
  OWNER.lastIndex = 0;
  if (needsOwner) text = text.replace(OWNER, " ");
  const unordered = ANY_ORDER.test(text);
  ANY_ORDER.lastIndex = 0;
  if (unordered) text = text.replace(ANY_ORDER, " ");
  const at = DONE_AT.exec(text);
  if (at) text = text.replace(at[0], " ");
  text = text.replace(/\s+/g, " ").trim();
  const who = ASSIGNEE.exec(text);
  if (who) text = text.slice(0, who.index).trim();
  const n: TreeNode = { title: text, links: findLinks(text, opts), children: [] };
  if (status) {
    n.status = status;
    n.done = status === "done";
  }
  if (needsOwner) n.needsOwner = true;
  if (unordered) n.unordered = true;
  if (at) n.doneAt = at[1]!.replace(" ", "T");
  if (who) n.assignee = assigneeOf(who[1]!, who[2]);
  return n;
}

/** `done: 捷报频传 · doing: 多线并进 · next: 蓄势待发` */
function parseSummary(text: string): TreeSummary {
  const out: TreeSummary = {};
  for (const part of text.split(/\s*[·|]\s*/)) {
    const m = /^(done|doing|next)\s*[:：]\s*(.+)$/i.exec(part.trim());
    if (m) out[m[1]!.toLowerCase() as keyof TreeSummary] = m[2]!.trim();
  }
  return out;
}

function addSummary(n: TreeNode, locale: string | undefined, text: string) {
  const s = parseSummary(text);
  if (!Object.keys(s).length) return;
  n.summaries ??= {};
  const key = (locale ?? "zh").toLowerCase();
  n.summaries[key] = { ...n.summaries[key], ...s };
}

/** Children without an assignee take the nearest ancestor's. */
function inherit(nodes: TreeNode[], from?: Assignee) {
  for (const n of nodes) {
    if (!n.assignee && from) n.assignee = from;
    inherit(n.children, n.assignee);
  }
}

/**
 * Parse the whole document into a root node (title "") whose children are the
 * top-level nodes and whose summaries are the `≈` lines before the first `##`.
 * Never throws: odd indentation nests under the nearest shallower item.
 */
export function parseTreeDoc(md: string, opts: ParseOptions = {}): TreeNode {
  const root: TreeNode = { title: "", links: [], children: [] };
  /** The open items, shallowest first, each with its indent. */
  let stack: { indent: number; node: TreeNode }[] = [];
  /** The current `##` heading, if any: items at any indent go under it. */
  let heading: TreeNode | null = null;
  /** The item that continuation lines (→ actions, notes) belong to. */
  let last: { indent: number; node: TreeNode } | null = null;

  const text = md.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const h = HEADING.exec(line);
    if (h) {
      heading = node(h[1]!, opts);
      root.children.push(heading);
      stack = [];
      last = { indent: -1, node: heading };
      continue;
    }
    if (/^#\s/.test(line)) {
      // A document title: ends the heading, and its text is not a node.
      heading = null;
      stack = [];
      last = null;
      continue;
    }
    const it = ITEM.exec(line);
    if (it && !ACTION.test(it[2]!) && !SUMMARY.test(it[2]!)) {
      const indent = indentOf(it[1]!);
      const n = node(it[2]!, opts);
      while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
      const parent = stack.length ? stack[stack.length - 1]!.node : (heading ?? root);
      parent.children.push(n);
      stack.push({ indent, node: n });
      last = { indent, node: n };
      continue;
    }
    const indent = indentOf(/^\s*/.exec(line)![0]);
    const body = line.trim().replace(/^[-*+]\s+/, "");
    const sum = SUMMARY.exec(body);
    // Before any heading or item, a ≈ line is the whole tree's.
    if (sum && !last && !root.children.length) {
      addSummary(root, sum[1], sum[2]!);
      continue;
    }
    // A continuation line: belongs to the last item if it is indented past it
    // (a heading takes any). Not indented past it, a note or ≈ line goes to the
    // heading (a paragraph after its list). Anything else (a legend paragraph
    // before any heading, a stray →) is ignored.
    const a = ACTION.exec(body);
    const under = !!last && (last.indent < 0 || indent > last.indent);
    if (!under && (!heading || a)) continue;
    const target = under ? last!.node : heading!;
    if (sum) addSummary(target, sum[1], sum[2]!);
    else if (a) {
      const act = a[1]!.trim();
      if (!act) continue;
      target.action = target.action ? `${target.action}\n${act}` : act;
      for (const l of findLinks(act, opts))
        if (!target.links.some((x) => x.url === l.url)) target.links.push(l);
    } else {
      target.note = target.note ? `${target.note} ${body}` : body;
    }
  }
  inherit(root.children, root.assignee);
  return root;
}

/** The top-level nodes (parseTreeDoc's root children). */
export function parseTree(md: string, opts: ParseOptions = {}): TreeNode[] {
  return parseTreeDoc(md, opts).children;
}

/** Open (not done) items below `n`, and those of them that wait on the owner. */
export function countOpen(n: TreeNode): { open: number; needsOwner: number } {
  let open = 0;
  let needsOwner = 0;
  for (const c of n.children) {
    if (c.done === false) {
      open++;
      if (c.needsOwner) needsOwner++;
    }
    const sub = countOpen(c);
    open += sub.open;
    needsOwner += sub.needsOwner;
  }
  return { open, needsOwner };
}

/**
 * Only the open `(!)` items and their ancestors (the "Needs me" view). A
 * matching item keeps only those of its children that match too.
 */
export function filterNeedsOwner(nodes: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  for (const n of nodes) {
    const children = filterNeedsOwner(n.children);
    if ((n.needsOwner && n.done !== true) || children.length) out.push({ ...n, children });
  }
  return out;
}

// ---------------------------------------------------------------- frontier

/** An item and the titles of its ancestors (its breadcrumb). */
export type FrontierItem = { node: TreeNode; path: string[]; title: string; assignee?: Assignee };

/**
 * One frontier line. `node`/`path` is the one item it shows without a
 * summary (done: the most recent; doing: the first, an open `(!)` item before
 * any `[~]`; next: the first not started after it). With several items and a
 * `≈` summary for the UI locale (or zh, or en), `summary` is that phrase.
 * `items` lists the group in order, each with its own assignee.
 */
export type FrontierEntry = FrontierItem & {
  count: number;
  summary?: string;
  items: FrontierItem[];
};

export type Frontier = { done?: FrontierEntry; doing?: FrontierEntry; next?: FrontierEntry };

export type FrontierOptions = {
  /** The UI locale, e.g. "ja" or "zh-CN". Summaries fall back to zh, then en. */
  locale?: string;
  /** Titles from the top down to the subtree to look at (default: all). */
  scope?: string[];
};

/** `[~]` first, then not started, blocked, done: the order inside an `(any order)` parent. */
const RANK: Record<TreeStatus, number> = { doing: 0, open: 1, blocked: 2, done: 3 };
const rank = (n: TreeNode) => (n.status ? RANK[n.status] : 1);

type Walked = FrontierItem & { chain: TreeNode[] };

/** Depth-first in work order, each with its breadcrumb and its ancestor nodes. */
function walk(root: TreeNode): Walked[] {
  const out: Walked[] = [];
  const go = (n: TreeNode, chain: TreeNode[]) => {
    const kids = n.unordered
      ? n.children
          .map((c, i) => [c, i] as const)
          .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
          .map(([c]) => c)
      : n.children;
    const next = [...chain, n];
    for (const c of kids) {
      if (c.status) {
        const path = next.map((x) => x.title).filter(Boolean);
        out.push({ node: c, path, title: c.title, assignee: c.assignee, chain: next });
      }
      go(c, next);
    }
  };
  go(root, []);
  return out;
}

/** The summary list to try: the locale, its language, zh, en. */
export function localeChain(locale?: string): string[] {
  const l = (locale ?? "").toLowerCase();
  return [...new Set([l, l.split("-")[0] ?? "", "zh", "en"].filter(Boolean))];
}

/** The deepest common ancestor of the group with a summary for `key`, in the first locale it has. */
function summaryFor(
  group: Walked[],
  key: keyof TreeSummary,
  locales: string[],
): string | undefined {
  let common = group[0]!.chain;
  for (const g of group) {
    let i = 0;
    while (i < common.length && i < g.chain.length && common[i] === g.chain[i]) i++;
    common = common.slice(0, i);
  }
  for (let i = common.length - 1; i >= 0; i--) {
    const s = common[i]!.summaries;
    if (!s) continue;
    for (const l of locales) if (s[l]?.[key]) return s[l][key];
  }
  return undefined;
}

/** The item without its ancestor nodes. */
function strip(w: Walked): FrontierItem {
  const it: FrontierItem = { node: w.node, path: w.path, title: w.title };
  if (w.assignee) it.assignee = w.assignee;
  return it;
}

function entry(
  group: Walked[],
  pick: Walked,
  key: keyof TreeSummary,
  locales: string[],
): FrontierEntry {
  const e: FrontierEntry = { ...strip(pick), count: group.length, items: group.map(strip) };
  if (group.length > 1) {
    const s = summaryFor(group, key, locales);
    if (s) e.summary = s;
  }
  return e;
}

/**
 * The three lines: ✓ the most recently done, ▶ in progress (an open `(!)`
 * item before any `[~]`), › the next not yet started. Blocked items are on
 * none of them, unless they wait on the owner.
 */
export function frontier(input: TreeNode | TreeNode[], opts: FrontierOptions = {}): Frontier {
  let root: TreeNode = Array.isArray(input) ? { title: "", links: [], children: input } : input;
  for (const t of opts.scope ?? []) {
    const hit = root.children.find((c) => c.title === t);
    if (!hit) return {};
    root = hit;
  }
  const locales = localeChain(opts.locale);
  const all = walk(root);
  const out: Frontier = {};

  const done = all.filter((w) => w.node.status === "done");
  if (done.length) {
    const dated = done.filter((w) => w.node.doneAt);
    const pick = dated.length
      ? dated.reduce((a, b) => (b.node.doneAt! >= a.node.doneAt! ? b : a))
      : done[done.length - 1];
    out.done = entry(done, pick!, "done", locales);
  }

  const owner = all.filter((w) => w.node.needsOwner && w.node.status !== "done");
  const doing = [...owner, ...all.filter((w) => w.node.status === "doing" && !w.node.needsOwner)];
  if (doing.length) out.doing = entry(doing, doing[0]!, "doing", locales);

  const next = all.filter((w) => w.node.status === "open" && !w.node.needsOwner);
  if (next.length) {
    // The first not started after the item in progress (when that is an agent's).
    const now = out.doing && !out.doing.node.needsOwner ? all.indexOf(doing[0]!) : -1;
    const pick = next.find((w) => all.indexOf(w) > now) ?? next[0];
    out.next = entry(next, pick!, "next", locales);
  }
  return out;
}

/** `/words › Learning Partner` */
export const crumbs = (path: string[]) => path.join(" › ");
