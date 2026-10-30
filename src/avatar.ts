// The log's avatars, the pure part (src/box.ts draws them): who a line is
// from, which pictures to try in what order, and the generated fallback (the
// name's initial on an oklch circle). No DOM, so it is unit-tested directly.

import type { AvatarSrc, ChatMessage, Sender } from "./protocol.ts";

export type { AvatarSrc, Sender };

/** What a line's avatar shows, as box.ts draws it. */
export type LineAvatar = {
  /** URLs to try in order (empty: the element, or the initial). */
  srcs: string[];
  /** The agent's logo as an element (cloned per line), when it is not a URL. */
  node?: Element;
  /** The alt text and the screen-reader name: the sender's name, or "you". */
  name: string;
  /** Whose initial the fallback shows (the viewer's own name on "you" lines). */
  initialFrom: string;
  seed: string;
  mine: boolean;
};

/** A short, stable hash (FNV-1a, 32 bits, base 36). */
export function hashId(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** The URLs in an AvatarSrc, in order, empty ones dropped. */
export function avatarSrcs(src: AvatarSrc | null | undefined): string[] {
  if (typeof src === "string") return src ? [src] : [];
  if (Array.isArray(src)) return src.filter((u): u is string => typeof u === "string" && !!u);
  return [];
}

/** The fallback's letter: the name's first grapheme, upper-cased; "?" for none. */
export function initialOf(name: string | undefined): string {
  const s = (name ?? "").trim();
  if (!s) return "?";
  const Seg = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  const first = Seg
    ? (new Seg(undefined, { granularity: "grapheme" }).segment(s)[Symbol.iterator]().next().value
        ?.segment ?? s[0])
    : (Array.from(s)[0] ?? s);
  return (first ?? s).toLocaleUpperCase();
}

/** Relative luminance (WCAG) of an oklch colour, clamped into sRGB. */
export function oklchLuminance(l: number, c: number, hDeg: number): number {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const r = clamp(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_);
  const g = clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_);
  const bl = clamp(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_);
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

/** WCAG contrast ratio of two relative luminances. */
export const contrastRatio = (y1: number, y2: number) =>
  (Math.max(y1, y2) + 0.05) / (Math.min(y1, y2) + 0.05);

const AVATAR_L = 0.7;
const AVATAR_C = 0.12;
const INK = [
  { css: "oklch(0.2 0 0)", y: oklchLuminance(0.2, 0, 0) },
  { css: "oklch(1 0 0)", y: 1 },
];

/**
 * The fallback's colours for a seed: oklch(0.7 0.12 <hue>), the hue from a
 * hash so a person keeps one colour, the letter in whichever ink contrasts
 * more (at least 4.5:1 on every hue).
 */
export function avatarColors(seed: string): { bg: string; fg: string; hue: number } {
  const hue = parseInt(hashId(`avatar:${seed}`), 36) % 360;
  const y = oklchLuminance(AVATAR_L, AVATAR_C, hue);
  const ink = INK.reduce((best, i) =>
    contrastRatio(i.y, y) > contrastRatio(best.y, y) ? i : best,
  );
  return { bg: `oklch(${AVATAR_L} ${AVATAR_C} ${hue})`, fg: ink.css, hue };
}

/**
 * A line's avatar. The agent's is `agentAvatar` (the host app's logo, a URL
 * or an element) named by its label. Anyone else's comes from `avatarFor`
 * (the host's resolver), else the line's own `sender`; the viewer's own
 * lines (owner lines on the owner's page, friend lines on a friend's) fill
 * the gaps from `user` and are named "you".
 */
export function lineAvatar(
  m: ChatMessage,
  opts: {
    friend?: boolean;
    user?: Sender;
    agentAvatar?: AvatarSrc | Element | null;
    avatarFor?: (m: ChatMessage) => Sender | null | undefined;
  },
): LineAvatar {
  if (m.from === "agent") {
    // The node's assignee, when the line names one; else the agent's label.
    const name = m.agentId || m.label || "agent";
    const a = opts.agentAvatar;
    const isSrc = typeof a === "string" || Array.isArray(a);
    return {
      srcs: isSrc ? avatarSrcs(a as AvatarSrc) : [],
      ...(a && !isSrc ? { node: a as Element } : {}),
      name,
      initialFrom: name,
      seed: `agent:${name}`,
      mine: false,
    };
  }
  const mine = m.from === (opts.friend ? "friend" : "owner");
  const own = opts.avatarFor?.(m) ?? undefined;
  const s: Sender = { ...(mine ? opts.user : undefined), ...m.sender, ...own };
  const srcs = [
    ...avatarSrcs(own?.avatar),
    ...(mine ? avatarSrcs(opts.user?.avatar) : []),
    ...avatarSrcs(m.sender?.avatar),
  ];
  const name = s.name || (m.from === "friend" ? "friend" : "owner");
  return {
    srcs: [...new Set(srcs)],
    name: mine ? "you" : name,
    initialFrom: name,
    seed: s.id || m.thread || m.from,
    mine,
  };
}
