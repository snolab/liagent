// <liagent-state-tree>: a read-only outline of what is in flight and what
// waits on the owner (src/state-tree.ts has the syntax), framework-free.
//
//   import { defineStateTree } from "liagent/tree";
//   defineStateTree();                              // registers <liagent-state-tree>
//   const tree = document.createElement("liagent-state-tree");
//   tree.repo = "owner/app";                        // a bare #123 links there
//   tree.source = "/state-tree.md";                 // or () => md, or {subscribe}
//   document.body.append(tree);
//
// It looks like the chat log: plain text lines with the page-coloured halo,
// indented by depth, no boxes and no background. Branches collapse; a status
// glyph per item (open, in progress, blocked, done); `(!)` items carry a
// "needs you" mark; assignees, links, a copy button per action; counts on
// collapsed branches; the frontier rows (✓ last done, ▶ in progress, › next)
// marked; a "Needs me" toggle, remembered per device, keeps only the `(!)`
// items and their ancestors. Text only: nothing is parsed as HTML.
//
// frontierLines(root) builds the three-line summary (✓ ▶ ›) for a small
// space such as a minimized chat bar.
//
// Theming: --liagent-bg (the halo; default Canvas), --liagent-fg.

import {
  type Assignee,
  type Frontier,
  type FrontierEntry,
  type ParseOptions,
  type TreeNode,
  type TreeStatus,
  countOpen,
  crumbs,
  filterNeedsOwner,
  frontier,
  parseTreeDoc,
} from "./state-tree.ts";

export * from "./state-tree.ts";

/**
 * Where the tree comes from: a URL (fetched as markdown), a function
 * returning markdown or nodes, or a feed that pushes: `subscribe(onUpdate)`
 * returns its unsubscribe. `meta.live` marks data from a live source.
 */
export type TreeSource =
  | string
  | (() => string | TreeNode[] | Promise<string | TreeNode[]>)
  | {
      subscribe: (
        onUpdate: (v: string | TreeNode[], meta?: { live?: boolean }) => void,
        onError?: (e: unknown) => void,
      ) => () => void;
    };

export type TreeStrings = {
  tree: string;
  back: string;
  needsMe: string;
  needsYou: string;
  /** On a collapsed branch: "{n} open", "{n} need you". */
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

export const TREE_STRINGS_EN: TreeStrings = {
  tree: "Tree",
  back: "Back to the chat",
  needsMe: "Needs me",
  needsYou: "needs you",
  openCount: "{n} open",
  needsYouCount: "{n} need you",
  copy: "Copy",
  copied: "Copied",
  loading: "Loading…",
  failed: "Could not load the tree",
  empty: "The tree is empty.",
  nothingNeedsYou: "Nothing waits on you.",
  you: "you",
  lastDone: "Last done",
  nowDoing: "In progress",
  upNext: "Up next",
  live: "Live",
};

const toRoot = (v: string | TreeNode[], opts: ParseOptions): TreeNode =>
  typeof v === "string" ? parseTreeDoc(v, opts) : { title: "", links: [], children: v };

/** Load a URL or function source once into its document root. */
export async function loadTree(
  source: Exclude<TreeSource, { subscribe: unknown }>,
  opts: ParseOptions = {},
): Promise<TreeNode> {
  let v: string | TreeNode[];
  if (typeof source === "string") {
    const r = await fetch(source, { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    v = await r.text();
  } else v = await source();
  return toRoot(v, opts);
}

/**
 * Watch any TreeSource: `onRoot` gets each version (a URL or function once, a
 * feed on every push). Returns the stop function. Never polls.
 */
export function watchTree(
  source: TreeSource,
  opts: ParseOptions,
  onRoot: (root: TreeNode, live: boolean) => void,
  onError: (e: unknown) => void,
): () => void {
  let alive = true;
  if (typeof source === "object") {
    const off = source.subscribe(
      (v, meta) => alive && onRoot(toRoot(v, opts), !!meta?.live),
      (e) => alive && onError(e),
    );
    return () => {
      alive = false;
      off();
    };
  }
  loadTree(source, opts).then(
    (r) => alive && onRoot(r, false),
    (e) => alive && onError(e),
  );
  return () => {
    alive = false;
  };
}

const ACCENT = "oklch(0.58 0.21 33)";
const INK: Record<TreeStatus, string> = {
  open: "oklch(0.62 0.03 260)",
  doing: "oklch(0.6 0.16 250)",
  blocked: "oklch(0.7 0.16 70)",
  done: "oklch(0.62 0.15 150)",
};
const LINK = "oklch(0.58 0.15 255)";
const GLYPH: Record<TreeStatus, string> = { open: "☐", doing: "◧", blocked: "⊘", done: "☑" };

/** localStorage: "1" while the Needs me filter is on (per device). */
export const NEEDS_ME_KEY = "liagent:tree-needs-me";

const CSS = `
:host { display: block; font: 12px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--liagent-fg, CanvasText); --bg: var(--liagent-bg, Canvas);
  text-shadow: 0 0 3px var(--bg), 0 0 6px var(--bg); pointer-events: none; }
* { box-sizing: border-box; }
ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
ul ul { padding-inline-start: 12px; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; position: relative; }
/* Small controls: a 40px invisible hit area. */
button.hit::after { content: ""; position: absolute; inset: -10px; }
.head, .line, .act, .note { pointer-events: auto; }
.head { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.head .grow { flex: 1; display: flex; align-items: center; gap: 6px; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: ${INK.done}; }
.needs { font-size: 10px; font-weight: 600; color: ${ACCENT}; opacity: .7; }
.needs[aria-pressed="true"] { opacity: 1; text-decoration: underline; }
.line { display: flex; gap: 4px; align-items: flex-start; }
.line.branch { cursor: pointer; user-select: none; }
.chev { width: 10px; flex: none; display: inline-block; transition: transform .15s; }
.chev.open { transform: rotate(90deg); }
.text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.heading > .line .text { font-weight: 600; }
.done > .line .text { opacity: .6; }
.mark { font-weight: 700; margin-inline-end: 4px; }
.marked > .line .text { opacity: 1; font-weight: 500; }
.badge { font-size: 10px; font-weight: 600; color: ${ACCENT}; margin-inline-start: 6px; white-space: nowrap; }
.who, .count { font-size: 10px; opacity: .6; margin-inline-start: 6px; white-space: nowrap; }
a { color: ${LINK}; }
.note { padding-inline-start: 14px; opacity: .6; white-space: pre-line; }
.act { padding-inline-start: 14px; }
.act code { font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-all; opacity: .8; }
.act button { margin-inline-start: 4px; opacity: .6; }
.status { opacity: .6; margin: 0; }
`;

const Base: typeof HTMLElement =
  typeof HTMLElement === "undefined" ? (class {} as unknown as typeof HTMLElement) : HTMLElement;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const keyOf = (path: string[], title: string) => [...path, title].join("\u0000");
const fill = (s: string, n: number) => s.replace("{n}", String(n));
const who = (a: Assignee | undefined, t: TreeStrings) =>
  a ? `@${a.type === "human" ? t.you : a.name}` : "";

/** The title as text, with its links (PR refs, URLs) as anchors. */
function titleNodes(n: TreeNode): Node[] {
  const out: Node[] = [];
  let rest = n.title;
  for (const l of n.links) {
    const at = rest.indexOf(l.text);
    if (at < 0) continue;
    out.push(document.createTextNode(rest.slice(0, at)));
    const a = el("a", undefined, l.text);
    a.href = l.url;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.addEventListener("click", (e) => e.stopPropagation());
    out.push(a);
    rest = rest.slice(at + l.text.length);
  }
  out.push(document.createTextNode(rest));
  return out;
}

type Mark = { glyph: string; color: string; label: string };
function marks(f: Frontier, t: TreeStrings): Map<string, Mark> {
  const m = new Map<string, Mark>();
  const put = (e: FrontierEntry | undefined, mark: Mark) =>
    e && m.set(keyOf(e.path, e.title), mark);
  put(f.done, { glyph: "✓", color: INK.done, label: t.lastDone });
  put(f.next, { glyph: "›", color: INK.open, label: t.upNext });
  put(f.doing, {
    glyph: "▶",
    color: f.doing?.node.needsOwner ? ACCENT : INK.doing,
    label: t.nowDoing,
  });
  return m;
}

/** The read-only outline element. Properties in; `onBack` adds a back control. */
export class StateTreeElement extends Base {
  static observedAttributes = ["src"];
  /** Set: a ‹ control in the header calls it (the chat box's tree view). */
  onBack?: () => void;
  repo?: string;
  locale?: string;
  strings: Partial<TreeStrings> = {};
  storageKey = NEEDS_ME_KEY;

  private _source?: TreeSource;
  private _root: TreeNode | null = null;
  private live = false;
  private error = "";
  private stop?: () => void;
  private collapsed = new Set<string>();
  private shadow?: ShadowRoot;

  /** The data: a URL, a function returning markdown or nodes, or a feed. (Re)loads it. */
  set source(v: TreeSource | undefined) {
    this._source = v;
    this.reload();
  }
  get source() {
    return this._source;
  }
  /** Set the parsed tree directly (parseTreeDoc's root). */
  set root(v: TreeNode | null) {
    this._root = v;
    this.render();
  }
  get root() {
    return this._root;
  }
  attributeChangedCallback(_n: string, _o: string | null, v: string | null) {
    if (v) this.source = v;
  }
  /** Load the source again (the chat box calls this each time its menu opens). */
  reload() {
    this.stop?.();
    this.stop = undefined;
    if (!this._source || !this.isConnected) return;
    this.stop = watchTree(
      this._source,
      { repo: this.repo },
      (r, live) => {
        this._root = r;
        this.live = live;
        this.error = "";
        this.render();
      },
      (e) => {
        this.error = e instanceof Error ? e.message : String(e);
        this.render();
      },
    );
  }
  connectedCallback() {
    if (!this.shadow) {
      this.shadow = this.attachShadow({ mode: "open" });
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        this.shadow.adoptedStyleSheets = [sheet];
      } catch {
        const s = el("style");
        s.textContent = CSS;
        this.shadow.append(s);
      }
    }
    this.reload();
    this.render();
  }
  disconnectedCallback() {
    this.stop?.();
    this.stop = undefined;
  }

  private get t(): TreeStrings {
    return { ...TREE_STRINGS_EN, ...this.strings };
  }
  private get needsMe() {
    try {
      return localStorage.getItem(this.storageKey) === "1";
    } catch {
      return false;
    }
  }

  render() {
    const r = this.shadow;
    if (!r) return;
    const t = this.t;
    r.replaceChildren(...Array.from(r.querySelectorAll("style")));
    const head = el("div", "head");
    if (this.onBack) {
      const back = el("button", "hit", "‹");
      back.type = "button";
      back.setAttribute("aria-label", t.back);
      back.addEventListener("click", () => this.onBack?.());
      head.append(back);
    }
    const grow = el("span", "grow", t.tree);
    if (this.live) {
      const dot = el("span", "dot");
      dot.title = t.live;
      dot.setAttribute("role", "img");
      dot.setAttribute("aria-label", t.live);
      grow.append(dot);
    }
    const doc = this._root;
    const total = doc ? countOpen(doc).needsOwner : 0;
    const needs = el("button", "needs hit", `⚑ ${t.needsMe}${total ? ` · ${total}` : ""}`);
    needs.type = "button";
    needs.setAttribute("aria-pressed", String(this.needsMe));
    needs.addEventListener("click", () => {
      try {
        localStorage.setItem(this.storageKey, this.needsMe ? "0" : "1");
      } catch {}
      this.render();
    });
    head.append(grow, needs);
    r.append(head);
    if (this.error || !doc) {
      r.append(el("p", "status", this.error ? `${t.failed} (${this.error})` : t.loading));
      return;
    }
    const shown = this.needsMe ? filterNeedsOwner(doc.children) : doc.children;
    if (!shown.length) {
      r.append(el("p", "status", this.needsMe ? t.nothingNeedsYou : t.empty));
      return;
    }
    const m = marks(frontier(doc, { locale: this.locale }), t);
    r.append(this.list(shown, "", [], 0, m, undefined));
  }

  private list(
    nodes: TreeNode[],
    base: string,
    titles: string[],
    depth: number,
    m: Map<string, Mark>,
    parentWho: Assignee | undefined,
  ): HTMLUListElement {
    const t = this.t;
    const ul = el("ul");
    nodes.forEach((n, i) => {
      const path = base ? `${base}.${i}` : String(i);
      const branch = n.children.length > 0;
      const shut = branch && this.collapsed.has(path);
      const mark = m.get(keyOf(titles, n.title));
      const li = el("li");
      li.dataset.status = n.status ?? "";
      if (depth === 0 && !n.status && branch) li.classList.add("heading");
      if (n.status === "done") li.classList.add("done");
      if (mark) li.classList.add("marked");
      const line = el("div", `line${branch ? " branch" : ""}`);
      line.append(el("span", `chev${shut || !branch ? "" : " open"}`, branch ? "›" : ""));
      if (n.status) {
        const g = el("span", undefined, GLYPH[n.status]);
        g.style.color = INK[n.status];
        g.setAttribute("aria-label", n.status);
        line.append(g);
      }
      const text = el("span", "text");
      if (mark) {
        const s = el("span", "mark", mark.glyph);
        s.style.color = mark.color;
        s.title = mark.label;
        text.append(s);
      }
      text.append(...titleNodes(n));
      if (n.needsOwner && n.status !== "done") text.append(el("span", "badge", `⚑ ${t.needsYou}`));
      else if (n.assignee && n.assignee !== parentWho)
        text.append(el("span", "who", who(n.assignee, t)));
      if (shut) {
        const c = countOpen(n);
        if (c.open) text.append(el("span", "count", fill(t.openCount, c.open)));
        if (c.needsOwner)
          text.append(el("span", "badge", `⚑ ${fill(t.needsYouCount, c.needsOwner)}`));
      }
      line.append(text);
      if (branch) {
        line.setAttribute("role", "button");
        line.tabIndex = 0;
        line.setAttribute("aria-expanded", String(!shut));
        const toggle = () => {
          if (!this.collapsed.delete(path)) this.collapsed.add(path);
          this.render();
        };
        line.addEventListener("click", toggle);
        line.addEventListener("keydown", (e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          toggle();
        });
      }
      li.append(line);
      if (n.note) li.append(el("p", "note", n.note));
      for (const a of n.action?.split("\n") ?? []) {
        const row = el("div", "act");
        row.append(el("code", undefined, a));
        const copy = el("button", "hit", "⧉");
        copy.type = "button";
        copy.setAttribute("aria-label", `${t.copy}: ${a}`);
        copy.addEventListener("click", () => {
          void navigator.clipboard?.writeText(a).then(
            () => {
              copy.textContent = "✓";
              copy.setAttribute("aria-label", t.copied);
              setTimeout(() => (copy.textContent = "⧉"), 1500);
            },
            () => {},
          );
        });
        row.append(copy);
        li.append(row);
      }
      if (branch && !shut)
        li.append(
          this.list(
            n.children,
            path,
            n.title ? [...titles, n.title] : titles,
            depth + 1,
            m,
            n.assignee,
          ),
        );
      ul.append(li);
    });
    return ul;
  }
}

/**
 * The frontier in three lines — ✓ the most recently done, ▶ in progress, ›
 * next — each a ≈ summary (several items) or one item with its context. A
 * group shows 〔N〕 and lists its items on tap. Plain DOM, text only.
 */
export function frontierLines(
  root: TreeNode,
  opts: { locale?: string; strings?: Partial<TreeStrings> } = {},
): HTMLElement {
  const t = { ...TREE_STRINGS_EN, ...opts.strings };
  const f = frontier(root, { locale: opts.locale });
  const box = el("div", "liagent-frontier");
  const rows: [keyof Frontier, string, string, string][] = [
    ["done", "✓", INK.done, t.lastDone],
    ["doing", "▶", f.doing?.node.needsOwner ? ACCENT : INK.doing, t.nowDoing],
    ["next", "›", INK.open, t.upNext],
  ];
  for (const [key, glyph, color, label] of rows) {
    const e = f[key];
    if (!e) continue;
    const group = e.count > 1 && !!e.summary;
    const line = el(group ? "button" : "div");
    line.dataset.frontier = key;
    line.title = group ? label : crumbs([...e.path, e.title]);
    line.style.cssText =
      "display:flex;gap:4px;align-items:center;width:100%;font:inherit;color:inherit;background:none;border:0;padding:0;text-align:start;pointer-events:auto";
    const g = el("span", undefined, glyph);
    g.style.color = color;
    g.style.fontWeight = "700";
    g.setAttribute("aria-label", label);
    const text = el(
      "span",
      undefined,
      group ? e.summary : [...e.path.slice(-1), e.title].join(" › "),
    );
    text.style.cssText =
      "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    line.append(g, text);
    if (group) line.append(el("span", undefined, `〔${e.count}〕`));
    else if (e.assignee) line.append(el("span", undefined, who(e.assignee, t)));
    box.append(line);
    if (group) {
      const list = el("ul");
      list.hidden = true;
      list.style.cssText = "list-style:none;margin:0;padding:0 0 0 16px";
      for (const it of e.items) {
        const li = el(
          "li",
          undefined,
          `${it.title}${it.assignee ? ` ${who(it.assignee, t)}` : ""}`,
        );
        li.title = crumbs(it.path);
        list.append(li);
      }
      line.setAttribute("aria-expanded", "false");
      line.addEventListener("click", () => {
        list.hidden = !list.hidden;
        line.setAttribute("aria-expanded", String(!list.hidden));
      });
      box.append(list);
    }
  }
  return box;
}

/** Register the element (once) under `tag`. Returns the class. */
export function defineStateTree(tag = "liagent-state-tree"): typeof StateTreeElement {
  if (typeof customElements !== "undefined" && !customElements.get(tag))
    customElements.define(tag, StateTreeElement);
  return StateTreeElement;
}
