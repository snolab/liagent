/**
 * The minimized chat's frontier lines: the last thing done, what is in
 * progress, and what comes next. The data comes from src/state-tree.ts
 * (`frontier`); this file has only the small display rules, so they can be
 * tested without a DOM.
 */
import type { Assignee } from "./state-tree.ts";

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
