/**
 * The state tree as the chat box shows it, driven by treeNav (tree-nav.ts):
 * the top-level nodes as a row of chips (status glyph, title, 〔open count〕;
 * the row scrolls sideways), and the one open branch below it as lines, each
 * level indented, as deep as its detents opened it. Box-less, like the log:
 * text with the halo, an underline on the focused one. Tapping a chip or a
 * line focuses it and opens it a level. Plain DOM, text only.
 *
 * The pure parts (navIndexOf, openTopOf, branchLines) are tested in
 * test/tree-chips.test.ts; renderTreeChips needs a document.
 */
import { type TreeNode, type TreeStatus, countOpen } from "./state-tree.ts";
import {
  type NavIndex,
  type TreeNavEvent,
  type TreeNavState,
  indexTree,
  isVisible,
} from "./tree-nav.ts";

/** Ids are index paths ("0", "0.2", "0.2.1"), so a reload keeps the focus. */
export function navIndexOf(root: TreeNode | null): {
  ix: NavIndex;
  byId: Map<string, TreeNode>;
} {
  const byId = new Map<string, TreeNode>();
  const ix = indexTree(
    root?.children ?? [],
    (n) => n.children,
    (n, parent, i) => {
      const id = parent === null ? String(i) : `${parent}.${i}`;
      byId.set(id, n);
      return id;
    },
  );
  return { ix, byId };
}

/** The open branch's top chip: the one the accordion has open (null: none). */
export function openTopOf(nav: Pick<TreeNavState, "expanded">): string | null {
  const ids = Object.keys(nav.expanded);
  return ids.length ? ids[0]!.split(".")[0]! : null;
}

/** The open branch's lines, in order: every visible descendant of its top chip. */
export function branchLines(
  ix: NavIndex,
  nav: Pick<TreeNavState, "expanded">,
): { id: string; level: number }[] {
  const top = openTopOf(nav);
  const lines: { id: string; level: number }[] = [];
  const walk = (id: string, level: number) => {
    for (const c of ix.children.get(id) ?? []) {
      if (!isVisible(ix, nav, c)) continue;
      lines.push({ id: c, level });
      walk(c, level + 1);
    }
  };
  if (top !== null) walk(top, 0);
  return lines;
}

const GLYPH: Record<TreeStatus, string> = { open: "○", doing: "◐", blocked: "!", done: "✓" };
const INK: Record<TreeStatus, string> = {
  open: "oklch(0.62 0.03 260)",
  doing: "oklch(0.6 0.16 250)",
  blocked: "oklch(0.7 0.16 70)",
  done: "oklch(0.62 0.15 150)",
};
const ACCENT = "oklch(0.58 0.21 33)";

/** The chips' CSS, for the shadow root that holds them (the box's). */
export const TREE_CHIPS_CSS = `
.chips { min-width: 0; max-width: 100%; display: flex; flex-direction: column; gap: 2px; line-height: 1.35; }
.chiprow { pointer-events: auto; display: flex; column-gap: 12px; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; white-space: nowrap; scrollbar-width: none; }
.chiprow::-webkit-scrollbar { display: none; }
.chips button { all: unset; cursor: pointer; pointer-events: auto; text-align: start; }
.chiprow > button { flex: none; min-height: 24px; }
.chiprow > button[data-open] { font-weight: 600; }
.chips button[data-focus] .lbl { text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 3px; }
.chiplines { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.chiplines .note { margin: 0; padding-inline-start: 12px; font-size: 10px; opacity: .6; }
.chips .g { display: inline-block; margin-inline-end: 2px; }
.chips .done { opacity: .6; }
.chips .need { margin-inline-start: 2px; font-weight: 700; color: ${ACCENT}; }
.chips .cnt { margin-inline-start: 2px; opacity: .6; font-variant-numeric: tabular-nums; }
.chips .tw { margin-inline-end: 2px; opacity: .6; }
.chips .status { margin: 0; opacity: .6; }
`;

const el = (tag: string, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** A node's label: status glyph (blinking while in progress), title, (!), 〔open〕 when its branch is shut. */
function label(node: TreeNode, shut: boolean, needsYou: string): HTMLElement {
  const box = el("span", "lbl");
  if (node.status) {
    const g = el("span", `g${node.status === "doing" ? " blink" : ""}`, GLYPH[node.status]);
    g.setAttribute("aria-hidden", "true");
    g.style.color = INK[node.status];
    box.append(g);
  }
  box.append(el("span", node.status === "done" ? "done" : undefined, node.title || "—"));
  if (node.needsOwner && node.status !== "done") {
    const n = el("span", "need", "(!)");
    n.setAttribute("aria-label", needsYou);
    box.append(n);
  }
  const open = shut ? countOpen(node).open : 0;
  if (open > 0) box.append(el("span", "cnt", `〔${open}〕`));
  return box;
}

export type TreeChipsOptions = {
  root: TreeNode | null;
  nav: TreeNavState;
  ix: NavIndex;
  byId: Map<string, TreeNode>;
  onNav: (ev: TreeNavEvent) => void;
  /** Shown instead (loading, or why it failed). */
  status?: string;
  /** "The tree is empty." */
  empty: string;
  /** The chip row's label ("State tree"). */
  label: string;
  /** The (!) mark's label ("needs you"). */
  needsYou: string;
};

/**
 * The chips and the open branch, as one element. Taps never take the
 * input's focus (pointerdown is prevented), so the draft and the open log stay.
 */
export function renderTreeChips(o: TreeChipsOptions): HTMLElement {
  if (o.status || !o.root || !o.ix.roots.length) {
    const p = el("p", "status", o.status ?? o.empty);
    p.dataset.testid = "tree-chips-status";
    return p;
  }
  const keep = (b: HTMLElement, id: string) => {
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    b.addEventListener("click", () => o.onNav({ type: "tapChip", id }));
  };
  const top = openTopOf(o.nav);
  const focus = o.nav.focusId;
  const wrap = el("div", "chips");
  wrap.dataset.testid = "tree-chips";
  const row = el("div", "chiprow");
  row.setAttribute("role", "tablist");
  row.setAttribute("aria-label", o.label);
  for (const id of o.ix.roots) {
    const node = o.byId.get(id)!;
    const b = el("button");
    b.setAttribute("type", "button");
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(id === top));
    b.dataset.id = id;
    if (id === focus) b.dataset.focus = "";
    if (id === top) b.dataset.open = "";
    b.append(label(node, id !== top, o.needsYou));
    keep(b, id);
    row.append(b);
  }
  wrap.append(row);
  const lines = branchLines(o.ix, o.nav);
  if (lines.length) {
    const ul = el("ul", "chiplines");
    for (const { id, level } of lines) {
      const node = o.byId.get(id)!;
      const kids = o.ix.children.get(id) ?? [];
      const shut = kids.length > 0 && !kids.some((k) => isVisible(o.ix, o.nav, k));
      const li = el("li");
      li.dataset.id = id;
      li.dataset.level = String(level);
      li.style.paddingInlineStart = `${level * 0.75}rem`;
      const b = el("button");
      b.setAttribute("type", "button");
      if (id === focus) b.dataset.focus = "";
      if (kids.length) {
        const tw = el("span", "tw", shut ? "▸" : "▾");
        tw.setAttribute("aria-hidden", "true");
        b.append(tw);
      }
      b.append(label(node, shut, o.needsYou));
      keep(b, id);
      li.append(b);
      if (node.note && !shut && level < 1) li.append(el("p", "note", node.note));
      ul.append(li);
    }
    wrap.append(ul);
  }
  return wrap;
}
