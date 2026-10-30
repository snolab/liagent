/**
 * The minimized chat's frontier lines: the last thing done, what is in
 * progress, and what comes next. The data comes from src/state-tree.ts
 * (`frontier`); this file has only the small display rules, so they can be
 * tested without a DOM.
 */
import { type Assignee, type Frontier, type FrontierEntry, crumbs } from "./state-tree.ts";

export const FRONTIER_ROWS = [
  { key: "done", mark: "✓", label: "Last done" },
  { key: "doing", mark: "▶", label: "In progress" },
  { key: "next", mark: "›", label: "Next" },
] as const;

/** Visible characters of an agent id at the line's end. */
export const SHORT_ID_LEN = 6;
/** Longer than this, an "id" is more likely a token than a slug: hidden. */
export const MAX_ID_LEN = 64;
/** How long a touch must rest on the id to show the full one. */
export const LONG_PRESS_MS = 500;

/**
 * The agent id to show, or null. Only agents have one shown, and only an
 * opaque slug: anything that looks like a host, a path, a pid:port or a
 * token (a dot, colon or slash, or over 64 characters) is dropped.
 */
export function shownAgentId(a: Assignee | undefined): string | null {
  if (!a || a.type !== "agent" || !a.id) return null;
  const id = a.id.trim();
  if (!id || id.length > MAX_ID_LEN || /[.:/\\]/.test(id)) return null;
  return id;
}

/** The last SHORT_ID_LEN characters, for the line's end. */
export const shortId = (id: string) => id.slice(-SHORT_ID_LEN);

/** The `〔N〕` after a group's summary; nothing for a single item. */
export const countBadge = (n: number | undefined) => (n && n > 1 ? `〔${n}〕` : "");

/** One frontier line as the minimized bar draws it. */
export type FrontierLine = {
  /** A group's ≈ summary (several items), else the one item's title. */
  text: string;
  count: number;
  assignee?: Assignee;
  /** A group's members (only when count > 1), each with its breadcrumb. */
  items?: { title: string; path: string; assignee?: Assignee }[];
};
export type FrontierView = { done?: FrontierLine; doing?: FrontierLine; next?: FrontierLine };

/**
 * The bar's lines from state-tree.ts frontier(): a group as its summary (or,
 * without one, its first item's title) and count, its items with breadcrumbs;
 * one item as its title. Undefined when there is nothing to show.
 */
export function frontierView(f: Frontier): FrontierView | undefined {
  const line = (e: FrontierEntry | undefined): FrontierLine | undefined =>
    e && {
      text: e.count > 1 && e.summary ? e.summary : e.title,
      count: e.count,
      ...(e.assignee ? { assignee: e.assignee } : {}),
      ...(e.count > 1
        ? {
            items: e.items.map((it) => ({
              title: it.title,
              path: crumbs(it.path),
              ...(it.assignee ? { assignee: it.assignee } : {}),
            })),
          }
        : {}),
    };
  const out: FrontierView = {};
  const done = line(f.done);
  const doing = line(f.doing);
  const next = line(f.next);
  if (done) out.done = done;
  if (doing) out.doing = doing;
  if (next) out.next = next;
  return done || doing || next ? out : undefined;
}
