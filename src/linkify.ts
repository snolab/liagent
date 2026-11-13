/**
 * Auto-links in message text: http(s) URLs become `<a>` elements built as DOM
 * nodes (never HTML from the text). External hosts open in a new tab with
 * `rel="noopener noreferrer"`; same-origin links stay in the tab.
 */

/** A piece of message text: plain, or a URL to link. */
export type TextPart = { text: string } | { text: string; url: string };

// A URL runs to whitespace (incl. U+3000), `<>"`, or Japanese 、。and full-width brackets （）「」『』【】〔〕.
const URL_RE = /\bhttps?:\/\/[^\s　<>"、。（）「」『』【】〔〕]+/gi;
const TRAIL = /[.,;:!?'"\]}）]$/;
const OPEN: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function count(s: string, c: string): number {
  return s.split(c).length - 1;
}

/** Drop trailing punctuation; a closing bracket stays when it balances one inside. */
export function trimUrl(raw: string): string {
  let s = raw;
  for (;;) {
    const last = s.at(-1);
    if (!last) return s;
    const open = OPEN[last];
    if (open) {
      if (count(s, open) >= count(s, last)) return s;
      s = s.slice(0, -1);
      continue;
    }
    if (TRAIL.test(last)) {
      s = s.slice(0, -1);
      continue;
    }
    return s;
  }
}

/** Split text into plain and link parts. Only http(s) URLs that parse are links. */
export function linkParts(text: string): TextPart[] {
  const out: TextPart[] = [];
  let at = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index;
    const url = trimUrl(m[0]);
    if (!/^https?:\/\/[^/?#]/i.test(url)) continue;
    try {
      new URL(url);
    } catch {
      continue;
    }
    if (start > at) out.push({ text: text.slice(at, start) });
    out.push({ text: url, url });
    at = start + url.length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** True when `url` has the page's origin. */
export function sameOrigin(url: string, origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** DOM nodes for `text` with its URLs linked. */
export function linkify(
  text: string,
  doc: Document = document,
  origin: string | undefined = doc.defaultView?.location?.origin,
): Node[] {
  return linkParts(text).map((p) => {
    if (!("url" in p)) return doc.createTextNode(p.text);
    const a = doc.createElement("a");
    a.href = p.url;
    a.textContent = p.text;
    if (!sameOrigin(p.url, origin)) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
    return a;
  });
}
