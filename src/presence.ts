// The presence bar, the pure part (src/box.ts draws it): who else is on the
// box's current node, kept from the hub's snapshot and deltas
// (src/protocol.ts parsePresence), and what the strip shows: at most
// PRESENCE_STACK stacked avatars, "+N" only when more are present, a hover
// preview of up to PRESENCE_PREVIEW with names. No DOM.

import type { PresenceDelta, PresenceFrame, PresenceMember } from "./protocol.ts";

export type { PresenceMember };

/** Avatars stacked in the strip at rest. */
export const PRESENCE_STACK = 3;
/** Members the hover/focus preview lists. */
export const PRESENCE_PREVIEW = 8;

export type PresenceState = { node: string; members: PresenceMember[] };

export const emptyPresence = (node: string): PresenceState => ({ node, members: [] });

/**
 * Apply a frame. A snapshot replaces the list; a delta adds `join` (a known
 * id is updated in place) and drops `leave`. A frame for another node than
 * `state.node` is ignored (the box moved on).
 */
export function applyPresence(
  state: PresenceState,
  frame: PresenceFrame | PresenceDelta,
): PresenceState {
  if (frame.node !== state.node) return state;
  if (frame.type === "presence") return { node: state.node, members: [...frame.members] };
  const gone = new Set(frame.leave ?? []);
  const list = state.members.filter((m) => !gone.has(m.id));
  for (const j of frame.join ?? []) {
    const i = list.findIndex((m) => m.id === j.id);
    if (i >= 0) list[i] = j;
    else list.push(j);
  }
  return { node: state.node, members: list };
}

/** "[lane@host]" for an agent with a lane, else "". */
export function laneTag(m: PresenceMember): string {
  if (m.kind !== "agent" || !m.lane) return "";
  return `[${m.host ? `${m.lane}@${m.host}` : m.lane}]`;
}

/** How a member reads in lists and labels: "label [lane@host]". */
export const memberLabel = (m: PresenceMember) => {
  const tag = laneTag(m);
  if (!tag) return m.label;
  const bare = tag.slice(1, -1);
  return m.label === bare || m.label === m.lane ? tag : `${m.label} ${tag}`;
};

/** A badge's text when there is no picture: an agent's lane (first 2 chars), else the name's. */
export function badgeText(m: PresenceMember): string {
  const s = (m.kind === "agent" && m.lane ? m.lane : m.label).trim();
  const chars = Array.from(s);
  return (m.kind === "agent" ? chars.slice(0, 2).join("") : (chars[0] ?? "?")).toUpperCase() || "?";
}

export type PresenceView = {
  /** Nothing to show: no one else is here. */
  hidden: boolean;
  /** The stacked avatars. */
  stack: PresenceMember[];
  /** "+N" after the stack; 0 = no number at all. */
  more: number;
  /** The hover/focus preview. */
  preview: PresenceMember[];
  /** Everyone else, for the click list. */
  all: PresenceMember[];
};

/** What the strip shows, leaving out `self` (this page's own id or ids). */
export function presenceView(
  members: readonly PresenceMember[],
  self: string | readonly string[] = [],
): PresenceView {
  const me = new Set(typeof self === "string" ? [self] : self);
  const all = members.filter((m) => !me.has(m.id));
  const stack = all.slice(0, PRESENCE_STACK);
  return {
    hidden: all.length === 0,
    stack,
    more: all.length > PRESENCE_STACK ? all.length - PRESENCE_STACK : 0,
    preview: all.slice(0, PRESENCE_PREVIEW),
    all,
  };
}

/** The strip's aria-label: who is here. */
export function presenceAria(all: readonly PresenceMember[], prefix: string): string {
  return `${prefix}: ${all.map(memberLabel).join(", ")}`;
}
