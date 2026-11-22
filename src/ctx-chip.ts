import { cleanCtx } from "./protocol.ts";

// A chat line's ctx as a small chip that expands on click (box.ctxRenderer).
//
// A line's `ctx` (host fields from the beforesend event, see src/before-send.ts)
// and legacy "[ctx] {json}" lines anywhere in the text (removed from it) render as
// a chip (part="ctx", a <button> with aria-expanded) instead of raw text;
// clicking it (or Enter/Space, native to a button) toggles a panel
// (part="ctx-detail") with the detail. Everything is text: textContent only,
// never HTML from ctx or the host's renderer; an icon is a short string.

/** What the chip shows: an icon (emoji or short string), a title, an optional detail. */
export type CtxView = { icon?: string; title: string; detail?: string };
/** The host's hook: a view for the line's ctx, or null for the default. */
export type CtxRenderer<M> = (ctx: Record<string, unknown>, line: M) => CtxView | null | undefined;

export const CTX_ICON = "📎";
const MAX_ICON = 4; // code points
const MAX_TITLE = 80;
const MAX_DETAIL = 2000;
const MAX_VALUE = 120;
const TITLE_KEYS = ["title", "table", "row", "page", "selection"] as const;

const clip = (s: string, n: number) => {
  const cps = [...s];
  return cps.length > n ? `${cps.slice(0, n - 1).join("")}…` : s;
};
const flat = (s: string) => s.replace(/\s+/g, " ").trim();
function show(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

/** The default view: a title from record.company, else record.row, else title/table/row/page/selection; a detail as "key: value" lines. */
export function defaultCtxView(ctx: Record<string, unknown>): CtxView {
  const parts: string[] = [];
  // Report lines: {page, record: {row, company, …}}.
  const rec =
    ctx.record && typeof ctx.record === "object" ? (ctx.record as Record<string, unknown>) : null;
  const named = rec && (flat(show(rec.company)) || flat(show(rec.row)));
  if (named) parts.push(named);
  else
    for (const k of TITLE_KEYS) {
      const v = flat(show(ctx[k]));
      if (!v) continue;
      parts.push(k === "row" ? `#${v}` : v);
      if (k === "title") break; // an explicit title is enough
    }
  const keys = Object.keys(ctx);
  const title = clip(parts.join(" · ") || keys.slice(0, 3).join(", ") || "ctx", MAX_TITLE);
  const detail = keys.map((k) => `${k}: ${clip(flat(show(ctx[k])), MAX_VALUE)}`).join("\n");
  return { icon: CTX_ICON, title, ...(detail ? { detail: clip(detail, MAX_DETAIL) } : {}) };
}

/** Coerce a host view to strings within limits; null when it is not a usable view. */
export function cleanCtxView(v: unknown): CtxView | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.title !== "string" || !flat(o.title)) return null;
  const out: CtxView = { title: clip(flat(o.title), MAX_TITLE) };
  if (typeof o.icon === "string" && flat(o.icon)) out.icon = clip(flat(o.icon), MAX_ICON);
  if (typeof o.detail === "string" && o.detail.trim()) out.detail = clip(o.detail, MAX_DETAIL);
  return out;
}

/** The chip's view for a ctx: the host's renderer when it returns one, else the default. */
export function ctxViewFor<M>(
  renderer: CtxRenderer<M> | null | undefined,
  ctx: Record<string, unknown>,
  line: M,
): CtxView {
  if (renderer) {
    try {
      const v = cleanCtxView(renderer(ctx, line));
      if (v) return { icon: CTX_ICON, ...v };
    } catch {
      // a host error never breaks the log
    }
  }
  return defaultCtxView(ctx);
}

/** One legacy "[ctx] …" line: its JSON object (cleanCtx limits), or the raw text when it is not one. */
export type LegacyCtx = { ctx: Record<string, unknown> } | { raw: string };
const LEGACY = /^\s*(?:>\s*)?\[ctx\]\s(.*)$/;

/**
 * Legacy "[ctx] {json}" lines anywhere in a message (also quoted "> [ctx] …"),
 * as some agents write them: each such line is taken out of the text and
 * becomes one chip (several lines = several chips, in order). null when there is none.
 */
export function parseLegacyCtx(text: string): { ctxs: LegacyCtx[]; text: string } | null {
  const ctxs: LegacyCtx[] = [];
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const m = LEGACY.exec(line);
    if (!m) {
      kept.push(line);
      continue;
    }
    const rest = (m[1] ?? "").trim();
    let obj: Record<string, unknown> | undefined;
    try {
      obj = cleanCtx(JSON.parse(rest));
    } catch {
      obj = undefined;
    }
    ctxs.push(obj ? { ctx: obj } : { raw: rest });
  }
  if (!ctxs.length) return null;
  return {
    ctxs,
    text: kept
      .join("\n")
      .replace(/^\s*\n|\n\s*$/g, "")
      .trim(),
  };
}

/** The view for a legacy "[ctx]" line that is not a JSON object: its raw text as the title. */
export function legacyCtxView(raw: string): CtxView {
  const s = flat(raw);
  return { icon: CTX_ICON, title: clip(s || "ctx", MAX_TITLE), ...(s ? { detail: raw } : {}) };
}

type Doc = { createElement(tag: string): HTMLElement };

/**
 * The chip (a button, part="ctx") and, when open, its panel (part="ctx-detail").
 * Text only. `onToggle` flips the open state (the box keeps it per line).
 */
export function ctxChipEls(
  doc: Doc,
  view: CtxView,
  open: boolean,
  id: string,
  onToggle: () => void,
): HTMLElement[] {
  const chip = doc.createElement("button");
  (chip as HTMLButtonElement).type = "button";
  chip.className = "ctx";
  chip.setAttribute("part", "ctx");
  chip.setAttribute("aria-expanded", String(open));
  chip.setAttribute("aria-label", `ctx: ${view.title}`);
  chip.title = view.title;
  const pid = `ctx-${id.replace(/[^\w-]/g, "_")}`;
  if (open) chip.setAttribute("aria-controls", pid);
  const icon = doc.createElement("span");
  icon.className = "ctx-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = view.icon ?? CTX_ICON;
  chip.append(icon);
  chip.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onToggle();
  });
  if (!open) return [chip];
  const panel = doc.createElement("div");
  panel.className = "ctx-detail";
  panel.setAttribute("part", "ctx-detail");
  panel.id = pid;
  const t = doc.createElement("div");
  t.className = "ctx-title";
  t.textContent = view.title;
  panel.append(t);
  if (view.detail) {
    const d = doc.createElement("div");
    d.className = "ctx-body";
    d.textContent = view.detail;
    panel.append(d);
  }
  return [chip, panel];
}
