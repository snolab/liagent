// Channel tags on history lines (box.channelOf / box.channelFilter).
//
// The host decides each line's channel: channelOf(m) → { label, color } or
// null (no tag). The tag is text only (textContent, never HTML); its colour
// goes in as a CSS custom property (--channel) through style.setProperty,
// never by building CSS strings, and only when it parses as a colour.

/**
 * A line's channel: its tag text (e.g. 世界) and a CSS colour. `world: true`
 * marks the world channel (root "/"): its lines show under every filter, as
 * in an old MMO chat.
 */
export type Channel = { label: string; color: string; world?: boolean };
export type ChannelOf<M> = (m: M) => Channel | null | undefined;

/** True if `c` is a CSS colour (CSS.supports where there is one). */
export function isCssColor(c: unknown): c is string {
  if (typeof c !== "string" || !c.trim()) return false;
  const css = (globalThis as { CSS?: { supports?: (p: string, v: string) => boolean } }).CSS;
  if (css?.supports) return css.supports("color", c);
  // No CSS object (tests, SSR): no declaration-breaking characters.
  return !/[;{}<>]/.test(c);
}

/** The line's channel, or null when unset, null, or malformed (a host error never breaks the log). */
export function channelFor<M>(channelOf: ChannelOf<M> | null | undefined, m: M): Channel | null {
  if (!channelOf) return null;
  let ch: Channel | null | undefined;
  try {
    ch = channelOf(m);
  } catch {
    return null;
  }
  if (!ch || typeof ch.label !== "string") return null;
  return ch;
}

/**
 * The lines to show: all of them without a filter, else those whose channel
 * label equals it plus the world lines (`world: true`).
 */
export function filterByChannel<M>(
  msgs: readonly M[],
  channelOf: ChannelOf<M> | null | undefined,
  filter: string | null | undefined,
): M[] {
  if (filter == null) return [...msgs];
  return msgs.filter((m) => {
    const ch = channelFor(channelOf, m);
    return !!ch && (ch.label === filter || ch.world === true);
  });
}

/** The 【label】 tag element: text only, the colour as --channel. */
export function channelTagEl(doc: Document, ch: Channel): HTMLElement {
  const el = doc.createElement("span");
  el.className = "channel";
  el.textContent = `【${ch.label}】`;
  if (isCssColor(ch.color)) el.style.setProperty("--channel", ch.color);
  return el;
}
