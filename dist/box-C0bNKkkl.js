import { BUSY_AFTER_REPLY_MS, BUSY_MS, MAX_CHAT, ROOT_NODE, applyEdit, completeNode, dictatedDraft, draftSource, lineNode, nodePath, parseAddress, pathLabel, pickLang, trimHistory } from "./protocol.js";
import { r as countOpen, s as frontier } from "./state-tree-BZCmAknI.js";
import { c as watchTree, r as TREE_STRINGS_EN } from "./tree-BrR7NwMf.js";
import { $ as dragCells, B as countUnread, C as LONG_PRESS_MS, D as frontierView, E as countBadge, F as FADE_MS, G as minimizeFloat, I as FLOAT_MAX, M as placeBox, O as shortId, S as FRONTIER_ROWS, U as createFloatLife, V as createArrivals, W as dwellMs, _ as createAxisLock, a as treeDefaults, at as maxDetent, b as createTapper, d as splitScroll, et as dragOffset, f as wheelPixels, it as isVisible, k as shownAgentId, l as createSwipeHandoff, nt as indexTree, o as uiStrings, ot as treeNav, rt as initialNav, v as createDragFlag, y as createLongPress } from "./ui-strings-CBDcKqFQ.js";
import { a as speechRate, i as setSpeechRate, n as SPEECH_RATES } from "./speech-rate-DXeJjRTc.js";
import { a as watchVoices, i as readingLang, n as createVoicePicker } from "./voice-pick-CKunvwiO.js";

//#region src/input.ts
/** Typing pauses this long before the draft is sent. */
const DEBOUNCE_MS = 3e3;
/** A burst this long or longer (dictation) that ends a sentence sends at once. */
const BURST_CHARS = 10;
const ENDS_SENTENCE = /[。．.!?！？]$/;
/** An Enter keydown that sends: not Shift+Enter, not inside or confirming an IME composition. */
function enterSends(e, composing) {
	if (e.key !== "Enter" || e.shiftKey) return false;
	return !(e.isComposing || composing || e.keyCode === 229);
}
/** A beforeinput line break that sends (Android): not Shift+Enter, not composing. */
function lineBreakSends(inputType, opts) {
	if (inputType !== "insertLineBreak" && inputType !== "insertParagraph") return false;
	return !(opts.composing || opts.isComposing || opts.shiftEnter);
}
/**
* After the draft changed outside a composition: "send" now (a dictated
* sentence), "arm" the debounce, or "idle" (nothing to send). `settledLen` is
* the draft's length at the previous settled change.
*/
function afterChange(text, settledLen, composing) {
	if (composing) return "idle";
	if (text.length - settledLen > BURST_CHARS && ENDS_SENTENCE.test(text.trim())) return "send";
	return text.trim() ? "arm" : "idle";
}
const CJK_START = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;
const CJK_END = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]$/u;
/**
* What a live (not yet final) transcript adds after the draft, as shown
* dimmed in the input: a space between two words, none after a space or a
* line break, or next to CJK text. Empty for no partial.
*/
function partialTail(draft, partial) {
	const p = (partial ?? "").trim();
	if (!p) return "";
	if (!draft || /\s$/.test(draft) || CJK_END.test(draft) || CJK_START.test(p)) return p;
	return ` ${p}`;
}

//#endregion
//#region src/avatar.ts
/** A short, stable hash (FNV-1a, 32 bits, base 36). */
function hashId(s) {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(36);
}
/** The URLs in an AvatarSrc, in order, empty ones dropped. */
function avatarSrcs(src) {
	if (typeof src === "string") return src ? [src] : [];
	if (Array.isArray(src)) return src.filter((u) => typeof u === "string" && !!u);
	return [];
}
/** The fallback's letter: the name's first grapheme, upper-cased; "?" for none. */
function initialOf(name) {
	const s = (name ?? "").trim();
	if (!s) return "?";
	const Seg = Intl.Segmenter;
	return ((Seg ? new Seg(void 0, { granularity: "grapheme" }).segment(s)[Symbol.iterator]().next().value?.segment ?? s[0] : Array.from(s)[0] ?? s) ?? s).toLocaleUpperCase();
}
/** Relative luminance (WCAG) of an oklch colour, clamped into sRGB. */
function oklchLuminance(l, c, hDeg) {
	const h = hDeg * Math.PI / 180;
	const a = c * Math.cos(h);
	const b = c * Math.sin(h);
	const l_ = (l + .3963377774 * a + .2158037573 * b) ** 3;
	const m_ = (l - .1055613458 * a - .0638541728 * b) ** 3;
	const s_ = (l - .0894841775 * a - 1.291485548 * b) ** 3;
	const clamp = (v) => Math.min(1, Math.max(0, v));
	const r = clamp(4.0767416621 * l_ - 3.3077115913 * m_ + .2309699292 * s_);
	const g = clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - .3413193965 * s_);
	const bl = clamp(-.0041960863 * l_ - .7034186147 * m_ + 1.707614701 * s_);
	return .2126 * r + .7152 * g + .0722 * bl;
}
/** WCAG contrast ratio of two relative luminances. */
const contrastRatio = (y1, y2) => (Math.max(y1, y2) + .05) / (Math.min(y1, y2) + .05);
const AVATAR_L = .7;
const AVATAR_C = .12;
const INK$1 = [{
	css: "oklch(0.2 0 0)",
	y: oklchLuminance(.2, 0, 0)
}, {
	css: "oklch(1 0 0)",
	y: 1
}];
/**
* The fallback's colours for a seed: oklch(0.7 0.12 <hue>), the hue from a
* hash so a person keeps one colour, the letter in whichever ink contrasts
* more (at least 4.5:1 on every hue).
*/
function avatarColors(seed) {
	const hue = parseInt(hashId(`avatar:${seed}`), 36) % 360;
	const y = oklchLuminance(AVATAR_L, AVATAR_C, hue);
	const ink = INK$1.reduce((best, i) => contrastRatio(i.y, y) > contrastRatio(best.y, y) ? i : best);
	return {
		bg: `oklch(${AVATAR_L} ${AVATAR_C} ${hue})`,
		fg: ink.css,
		hue
	};
}
/**
* A line's avatar. The agent's is `agentAvatar` (the host app's logo, a URL
* or an element) named by its label. Anyone else's comes from `avatarFor`
* (the host's resolver), else the line's own `sender`; the viewer's own
* lines (owner lines on the owner's page, friend lines on a friend's) fill
* the gaps from `user` and are named "you".
*/
function lineAvatar(m, opts) {
	if (m.from === "agent") {
		const name = m.agentId || m.label || "agent";
		const a = opts.agentAvatar;
		const isSrc = typeof a === "string" || Array.isArray(a);
		return {
			srcs: isSrc ? avatarSrcs(a) : [],
			...a && !isSrc ? { node: a } : {},
			name,
			initialFrom: name,
			seed: `agent:${name}`,
			mine: false
		};
	}
	const mine = m.from === (opts.friend ? "friend" : "owner");
	const own = opts.avatarFor?.(m) ?? void 0;
	const s = {
		...mine ? opts.user : void 0,
		...m.sender,
		...own
	};
	const srcs = [
		...avatarSrcs(own?.avatar),
		...mine ? avatarSrcs(opts.user?.avatar) : [],
		...avatarSrcs(m.sender?.avatar)
	];
	const name = s.name || (m.from === "friend" ? "friend" : "owner");
	return {
		srcs: [...new Set(srcs)],
		name: mine ? "you" : name,
		initialFrom: name,
		seed: s.id || m.thread || m.from,
		mine
	};
}

//#endregion
//#region src/tree-chips.ts
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
/** Ids are index paths ("0", "0.2", "0.2.1"), so a reload keeps the focus. */
function navIndexOf(root) {
	const byId = /* @__PURE__ */ new Map();
	return {
		ix: indexTree(root?.children ?? [], (n) => n.children, (n, parent, i) => {
			const id = parent === null ? String(i) : `${parent}.${i}`;
			byId.set(id, n);
			return id;
		}),
		byId
	};
}
/** The open branch's top chip: the one the accordion has open (null: none). */
function openTopOf(nav) {
	const ids = Object.keys(nav.expanded);
	return ids.length ? ids[0].split(".")[0] : null;
}
/** The open branch's lines, in order: every visible descendant of its top chip. */
function branchLines(ix, nav) {
	const top = openTopOf(nav);
	const lines = [];
	const walk = (id, level) => {
		for (const c of ix.children.get(id) ?? []) {
			if (!isVisible(ix, nav, c)) continue;
			lines.push({
				id: c,
				level
			});
			walk(c, level + 1);
		}
	};
	if (top !== null) walk(top, 0);
	return lines;
}
const GLYPH = {
	open: "○",
	doing: "◐",
	blocked: "!",
	done: "✓"
};
const INK = {
	open: "oklch(0.62 0.03 260)",
	doing: "oklch(0.6 0.16 250)",
	blocked: "oklch(0.7 0.16 70)",
	done: "oklch(0.62 0.15 150)"
};
const ACCENT = "oklch(0.58 0.21 33)";
/** The chips' CSS, for the shadow root that holds them (the box's). */
const TREE_CHIPS_CSS = `
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
const el = (tag, cls, text) => {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text !== void 0) e.textContent = text;
	return e;
};
/** A node's label: status glyph (blinking while in progress), title, (!), 〔open〕 when its branch is shut. */
function label(node, shut, needsYou) {
	const box = el("span", "lbl");
	if (node.status) {
		const g = el("span", `g${node.status === "doing" ? " blink" : ""}`, GLYPH[node.status]);
		g.setAttribute("aria-hidden", "true");
		g.style.color = INK[node.status];
		box.append(g);
	}
	box.append(el("span", node.status === "done" ? "done" : void 0, node.title || "—"));
	if (node.needsOwner && node.status !== "done") {
		const n = el("span", "need", "(!)");
		n.setAttribute("aria-label", needsYou);
		box.append(n);
	}
	const open = shut ? countOpen(node).open : 0;
	if (open > 0) box.append(el("span", "cnt", `〔${open}〕`));
	return box;
}
/**
* The chips and the open branch, as one element. Taps never take the
* input's focus (pointerdown is prevented), so the draft and the open log stay.
*/
function renderTreeChips(o) {
	if (o.status || !o.root || !o.ix.roots.length) {
		const p = el("p", "status", o.status ?? o.empty);
		p.dataset.testid = "tree-chips-status";
		return p;
	}
	const keep = (b, id) => {
		b.addEventListener("pointerdown", (e) => e.preventDefault());
		b.addEventListener("click", () => o.onNav({
			type: "tapChip",
			id
		}));
	};
	const top = openTopOf(o.nav);
	const focus = o.nav.focusId;
	const wrap = el("div", "chips");
	wrap.dataset.testid = "tree-chips";
	const row = el("div", "chiprow");
	row.setAttribute("role", "tablist");
	row.setAttribute("aria-label", o.label);
	for (const id of o.ix.roots) {
		const node = o.byId.get(id);
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
			const node = o.byId.get(id);
			const kids = o.ix.children.get(id) ?? [];
			const shut = kids.length > 0 && !kids.some((k) => isVisible(o.ix, o.nav, k));
			const li = el("li");
			li.dataset.id = id;
			li.dataset.level = String(level);
			li.style.paddingInlineStart = `${level * .75}rem`;
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

//#endregion
//#region src/box.ts
/** A page's label is "<path> <user agent>": the path and a short device hint. */
function pageHint(label) {
	const [path = "", ...rest] = label.split(" ");
	const ua = rest.join(" ");
	const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh|Mac OS/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux|X11/.test(ua) ? "Linux" : ua.split(" ").find((w) => w !== "pwa") ?? "";
	const pwa = /(^| )pwa( |$)/.test(ua) ? " app" : "";
	return device ? `${path} · ${device}${pwa}` : path;
}
const Base = typeof HTMLElement === "undefined" ? class {} : HTMLElement;
const synth = () => typeof speechSynthesis === "undefined" ? null : speechSynthesis;
/** The box's own read-aloud voice, chosen again whenever the device's voices change. */
const voicePicker = createVoicePicker({
	voices: () => synth()?.getVoices() ?? [],
	watch: watchVoices
});
let unlocked = false;
/** iOS speaks only after a user gesture: an empty utterance on the first one unlocks it. */
function unlockSpeech() {
	const s = synth();
	if (unlocked || !s) return;
	unlocked = true;
	s.speak(new SpeechSynthesisUtterance(""));
}
/** Drop whatever is being read and queued — the owner has started typing. */
function cancelSpeech() {
	const s = synth();
	if (s && (s.speaking || s.pending)) s.cancel();
}
const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
/** env(safe-area-inset-*) in px, measured with a probe. */
function safeInsets() {
	const probe = document.createElement("div");
	probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left)";
	document.body.append(probe);
	const cs = getComputedStyle(probe);
	const v = {
		top: Number.parseFloat(cs.paddingTop) || 0,
		left: Number.parseFloat(cs.paddingLeft) || 0,
		right: Number.parseFloat(cs.paddingRight) || 0
	};
	probe.remove();
	return v;
}
const pad = (n) => String(n).padStart(2, "0");
/** HH:MM:SS today, YYYY-MM-DD HH:MM before — local time, ISO order. */
function when(at, now = /* @__PURE__ */ new Date()) {
	const d = new Date(at);
	const day = (x) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
	const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	return day(d) === day(now) ? `${hm}:${pad(d.getSeconds())}` : `${day(d)} ${hm}`;
}
/** In the input while the mark is held. */
const DRAG_HINT = "drag: move · tap: minimize · double-tap: menu";
const MARK_HINT = "Tap: minimize or restore · double-tap: menu · drag: move the chat";
const TREE_HINT = "Tap: show or hide the state tree · drag right: open the focused node deeper · drag left: fold it · arrow keys: move";
/** The input grows to about five lines, then scrolls inside itself. */
const INPUT_MAX_PX = 128;
const ICONS = {
	lock: `<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path fill="currentColor" d="M5 7V5a3 3 0 0 1 6 0v2h1v7H4V7zm1.5 0h3V5a1.5 1.5 0 0 0-3 0z"/></svg>`,
	sparkle: `<svg viewBox="0 0 256 256" width="1em" height="1em" aria-hidden="true"><path fill="currentColor" d="M104,40Q112,136,200,144Q112,152,104,248Q96,152,8,144Q96,136,104,40ZM200,8Q204,48,244,52Q204,56,200,96Q196,56,156,52Q196,48,200,8Z"/></svg>`,
	speaker: `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M2 6h3l4-3v10l-4-3H2z"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6 6 0 0 1 0 9" stroke="currentColor" fill="none" stroke-width="1.3"/></svg>`,
	mark: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3h10a4 4 0 0 1 4 4v7a4 4 0 0 1-4 4h-7l-5 3v-3.6A4 4 0 0 1 3 14V7a4 4 0 0 1 4-4Z"/><path d="M10.5 6.5v8"/><path d="M15.5 5.6l.55 1.35 1.35.55-1.35.55-.55 1.35-.55-1.35-1.35-.55 1.35-.55Z" fill="oklch(0.72 0.17 150)" stroke="oklch(0.72 0.17 150)" stroke-width="1"/></svg>`,
	tree: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="10" width="7" height="4.5" rx="1.5"/><rect x="14" y="16.5" width="7" height="4.5" rx="1.5"/><path d="M6.5 8v10.75H14M6.5 12.25H14"/></svg>`
};
const CSS = `
:host {
  all: initial;
  position: fixed;
  right: 0.5rem;
  bottom: calc(0.5rem + env(safe-area-inset-bottom));
  z-index: var(--liagent-z, 40);
  /* Click-through: only the bar, the menu, the pairing line and opted-in rows take pointer events. */
  pointer-events: none;
  font: 12px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--liagent-fg, CanvasText);
  --bg: var(--liagent-bg, Canvas);
  --glass: color-mix(in oklch, var(--bg) 55%, transparent);
  --line: color-mix(in oklch, currentColor 25%, transparent);
  --muted: color-mix(in oklch, currentColor 55%, transparent);
  /* Lines straight over the page (floating, frontier): a stronger halo, never a fill. */
  --halo: 0 0 1px var(--bg), 0 0 2px var(--bg), 0 0 4px var(--bg), 0 0 8px var(--bg);
}
* { box-sizing: border-box; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
.halo { text-shadow: 0 0 3px var(--bg), 0 0 6px var(--bg); }
.box {
  width: var(--liagent-width, min(20rem, calc(100vw - 1rem)));
  display: flex; flex-direction: column; pointer-events: none;
  opacity: .6; transition: opacity .15s;
}
.box:focus-within, .box:active, .box.on { opacity: 1; }
/* The one scroller: the tree (when open) on top, the log below. Compact at rest. */
.column {
  max-height: 4.4rem; min-height: 3rem; overflow-y: auto; padding: 6px 8px;
  scrollbar-width: none; transition: max-height .15s ease-out;
}
.column::-webkit-scrollbar { display: none; }
.column.wide { max-height: 30vh; }
.column.fade { -webkit-mask-image: linear-gradient(to bottom, transparent, black .9rem); mask-image: linear-gradient(to bottom, transparent, black .9rem); }
.column.wide.fade { -webkit-mask-image: linear-gradient(to bottom, transparent, black 2.5rem); mask-image: linear-gradient(to bottom, transparent, black 2.5rem); }
.treepanel { pointer-events: none; display: flex; flex-direction: row-reverse; align-items: flex-start; min-width: 0; max-width: 100%; padding-bottom: 4px; animation: appear .18s ease-out; }
@keyframes appear { from { opacity: 0; } }
.treepanel .tbody { flex: 1; min-width: 0; }
.treepanel .x { pointer-events: auto; flex: none; position: relative; padding: 0 6px; font-size: 10px; color: var(--muted); }
.ftree .tbody { max-height: 4.4rem; overflow-y: auto; scrollbar-width: none; }
.ftree .tbody.wide { max-height: 30vh; }
.ftree .tbody.fade { -webkit-mask-image: linear-gradient(to bottom, transparent, black .9rem); mask-image: linear-gradient(to bottom, transparent, black .9rem); }
.blink { animation: blink 1.6s ease-in-out infinite; }
@keyframes blink { 50% { opacity: .35; } }
.log { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.log li { display: flex; align-items: flex-start; gap: 6px; }
.text { flex: 1; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; padding-top: 1px; }
.log .hint { opacity: .6; display: block; }
.polished { all: unset; pointer-events: auto; cursor: pointer; margin-inline-start: 4px; font-size: .85em; opacity: .55; vertical-align: baseline; }
.polished[aria-pressed="true"] { opacity: .9; }
.raw { opacity: .65; }
.log li.node { border-inline-start: 2px solid var(--node); padding-inline-start: 4px; }
.log .sub { display: block; font-size: 10px; line-height: 1.2; opacity: .65; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Fixed size whatever loads, so a late picture shifts nothing. */
.av {
  --s: var(--liagent-avatar, 18px);
  flex: none; width: var(--s); height: var(--s); border-radius: 50%; overflow: hidden;
  display: inline-flex; align-items: center; justify-content: center;
  font-weight: 600; font-size: calc(var(--s) * 0.55); line-height: 1; text-shadow: none; user-select: none;
}
img.av { display: block; object-fit: cover; }
.av > * { max-width: 100%; max-height: 100%; }
.sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.warn { padding: 4px 8px 0; font-size: 10px; color: oklch(0.6 0.17 45); }
.asks { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 0 0 4px; }
.asks:empty { display: none; }
.ask {
  pointer-events: auto; display: inline-flex; align-items: center; gap: 4px;
  border-radius: 999px; padding: 2px 2px 2px 6px; font-size: 10px; color: oklch(1 0 0);
  background: oklch(0.45 0.12 30); text-shadow: none;
}
.ask b { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; }
.ask button { border-radius: 999px; padding: 0 6px; }
.ask .y { background: oklch(0.55 0.15 145); }
.ask .c { background: oklch(0.5 0.1 230); }
.ask .n { background: oklch(0.4 0.02 260); }
.ask .tag { opacity: .85; }
.askwrap { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; pointer-events: auto; }
.pagelist {
  display: flex; flex-direction: column; gap: 1px; padding: 3px 8px; border-radius: 8px; font-size: 11px;
  border: 1px solid var(--line); background: var(--glass); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
}
.pagelist label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
.pagelist input { margin: 0; }
/* The bar's row: two grid columns, the bar's and a spacer's, trading 1fr ⇄ 0fr. */
.rowbox { position: relative; display: grid; grid-template-columns: 1fr 0fr; transition: grid-template-columns .18s ease-out; }
.min .rowbox { grid-template-columns: 0fr 1fr; }
.bar {
  pointer-events: auto; position: relative; display: flex; align-items: flex-end;
  padding: 2px; border-radius: 1.125rem; border: 1px solid var(--line); background: var(--glass);
  backdrop-filter: blur(12px) saturate(1.5); -webkit-backdrop-filter: blur(12px) saturate(1.5);
  touch-action: none; text-shadow: none;
}
.min .bar { padding: 1px; }
/* 40px targets: the hit area reaches 40px whatever the drawn size. */
.tap { position: relative; flex: none; width: 40px; height: 32px; display: inline-flex; align-items: center; justify-content: center; border-radius: 999px; }
.tap::before { content: ""; position: absolute; left: 50%; top: 50%; width: max(100%, 40px); height: max(100%, 40px); transform: translate(-50%, -50%); }
.mark, .treebtn { touch-action: none; cursor: grab; }
.treebtn { cursor: pointer; }
.mark .dot { position: absolute; top: 4px; inset-inline-end: 6px; width: 6px; height: 6px; border-radius: 50%; }
.evals {
  position: absolute; top: 0; inset-inline-end: 2px; min-width: 14px; height: 14px; padding: 0 2px; border-radius: 999px;
  display: inline-flex; align-items: center; justify-content: center; font-size: 8px; line-height: 1; color: oklch(1 0 0);
  background: oklch(0.55 0.15 30); font-variant-numeric: tabular-nums;
}
.evals.ran { animation: pulse 1s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .4; } }
.thint { pointer-events: none; position: absolute; inset-inline-start: 0; bottom: 100%; margin-bottom: 8px; white-space: nowrap; font-size: 10px; text-shadow: var(--halo); }
.slot { position: relative; display: flex; flex: 1; width: 0; min-width: 0; transition: opacity .18s ease-out; }
.min .slot { opacity: 0; max-height: 2rem; overflow: hidden; }
textarea {
  pointer-events: auto; display: block; flex: 1; min-width: 0; resize: none; margin: 0; align-self: flex-end;
  font: 16px/1.35 inherit; font-family: inherit; color: inherit; height: 2.125rem; min-height: 2.125rem; max-height: ${INPUT_MAX_PX}px;
  padding: 4px 8px; border: 1px solid transparent; background: transparent; outline: none;
  overflow-y: auto; overscroll-behavior: contain; touch-action: pan-y;
}
textarea.pe { padding-inline-end: 24px; }
textarea::placeholder { color: color-mix(in oklch, currentColor 45%, transparent); }
.mirror {
  pointer-events: none; position: absolute; inset: 0; overflow: hidden; white-space: pre-wrap; overflow-wrap: anywhere;
  border: 1px solid transparent; padding: 4px 8px; font: 16px/1.35 inherit; font-family: inherit;
}
.mirror .ghost { visibility: hidden; }
.mirror .partial { color: var(--muted); }
.notice { margin: 0; flex: 1; min-width: 0; padding: 8px; opacity: .8; }
.spin {
  pointer-events: none; position: absolute; inset-inline-end: 6px; top: 50%; margin-top: -6px;
  width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid var(--line); border-top-color: var(--liagent-agent, oklch(0.55 0.14 150));
  animation: rot .8s linear infinite;
}
@keyframes rot { to { transform: rotate(360deg); } }
.mic { pointer-events: auto; flex: none; display: flex; align-items: center; min-height: 32px; }
.unread {
  pointer-events: none; position: absolute; top: -6px; inset-inline-end: -6px; border-radius: 999px; padding: 0 4px;
  font-size: 10px; line-height: 16px; color: oklch(1 0 0); background: oklch(0.55 0.2 260);
}
.drain {
  position: absolute; inset: 0 12px auto 12px; height: 2px; background: oklch(0.55 0.2 260 / .6);
  transform-origin: left; animation: drain var(--drain-ms) linear both; pointer-events: none;
}
@keyframes drain { to { transform: scaleX(0); } }
.aim { position: absolute; inset-inline-start: 84px; bottom: 100%; margin-bottom: 4px; max-width: calc(100% - 6rem); display: flex; flex-direction: column; align-items: flex-start; gap: 4px; pointer-events: none; }
.aim > * { pointer-events: auto; }
.target { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; border: 1px solid var(--node, var(--line)); border-radius: 999px; padding: 0 6px; font-size: 10px; line-height: 16px; background: var(--glass); }
.target.preview { opacity: .7; }
.target button { all: unset; cursor: pointer; line-height: 1; }
.nodes { list-style: none; margin: 0; padding: 2px 0; max-width: 100%; border: 1px solid var(--line); border-radius: 8px; font-size: 11px; background: var(--glass); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
.nodes button { all: unset; display: block; cursor: pointer; padding: 1px 8px; }
/* Minimized: the tree, the floating lines and the frontier, on the bar's side. */
.floatbox {
  pointer-events: none; position: absolute; bottom: 100%; margin-bottom: 4px; left: 0;
  width: max-content; max-width: min(20rem, calc(100vw - 16px));
  display: flex; flex-direction: column; gap: 4px; align-items: flex-start;
}
.floatbox[data-side="center"] { align-items: center; text-align: center; }
.floatbox[data-side="right"] { align-items: flex-end; text-align: right; }
.floats, .frontier { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; align-items: inherit; max-width: 100%; }
.floats:empty, .frontier:empty, .ftree:empty { display: none; }
.float {
  pointer-events: auto; max-width: 100%; padding: 2px 0; white-space: pre-wrap; overflow-wrap: anywhere;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; overflow: hidden;
  text-shadow: var(--halo); opacity: 1; transition: none;
}
.float.fading { opacity: 0; transition: opacity ${FADE_MS}ms ease-out; }
.float .who { margin-inline-end: 4px; font-weight: 500; }
.frontier > li { pointer-events: auto; max-width: 100%; min-width: 0; text-shadow: var(--halo); }
.frontier .fl { display: flex; min-width: 0; align-items: center; }
.frontier .fb { display: flex; min-width: 0; align-items: center; gap: 4px; padding: 2px 4px 2px 0; text-align: start; }
.frontier .fb[aria-expanded] { cursor: pointer; }
.frontier .fb:not([aria-expanded]) { cursor: default; }
.frontier .m { width: 12px; flex: none; text-align: center; opacity: .7; }
.frontier .t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.frontier .n { flex: none; opacity: .7; }
.frontier .fav {
  display: inline-flex; width: 16px; height: 16px; flex: none; align-items: center; justify-content: center;
  border-radius: 50%; font-size: 9px; line-height: 1; font-weight: 600; text-shadow: none;
}
.frontier .id { position: relative; margin-inline-start: auto; flex: none; padding: 0 8px 0 6px; user-select: none; -webkit-user-select: none; font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
.frontier .full {
  position: absolute; inset-inline-end: 0; bottom: 100%; margin-bottom: 4px; white-space: nowrap; padding: 2px 6px; border-radius: 6px;
  border: 1px solid var(--line); background: color-mix(in oklch, var(--bg) 85%, transparent); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
}
.frontier .items { list-style: none; margin: 0; padding: 0 8px 4px; max-height: 9.75rem; overflow-y: auto; overscroll-behavior: contain; }
.frontier .items li { display: flex; min-width: 0; align-items: center; gap: 4px; padding: 1px 0; }
.frontier .items .p { margin-inline-start: 4px; font-size: 10px; color: var(--muted); }
.menu {
  pointer-events: auto; position: absolute; bottom: 100%; left: 0; margin-bottom: 4px; min-width: 12rem; max-height: 60vh; overflow-y: auto;
  display: flex; flex-direction: column; padding: 4px 0; border-radius: 8px; text-shadow: none;
  border: 1px solid var(--line); background: var(--glass); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
}
.menu > * { padding: 5px 12px; text-align: start; display: flex; align-items: center; gap: 8px; }
.menu .status { opacity: .65; }
.menu .rate { gap: 4px; padding-top: 2px; padding-bottom: 2px; }
.menu .rate span { opacity: .65; margin-inline-end: 4px; }
.menu .rate button { min-width: 40px; min-height: 28px; border-radius: 4px; font-variant-numeric: tabular-nums; opacity: .7; }
.menu .rate button[aria-checked="true"] { opacity: 1; font-weight: 600; text-decoration: underline; text-underline-offset: 2px; }
.menu .sess, .menu .pg { opacity: .75; }
.menu .sess span, .menu .pg span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu .sess button, .menu .pg button { text-decoration: underline; padding: 0; }
.menu .head { opacity: .5; font-size: 10px; padding-bottom: 0; }
.menu [aria-checked="false"] svg { opacity: .45; }
${TREE_CHIPS_CSS}
@media (prefers-reduced-motion: reduce) {
  .rowbox, .slot, .column, .box, .float.fading { transition: none; }
  .blink, .treepanel, .evals.ran { animation: none; }
}
[hidden] { display: none !important; }
`;
/** The chat box element. Plain properties in, callbacks out; see the file header. */
var ChatBox = class extends Base {
	static get observedAttributes() {
		return ["mic-active"];
	}
	/**
	* Called with each draft that goes out, and the state-tree node it is
	* addressed to (absent = the main thread); `opts.source` is "stt" when the
	* line is dictation, sent unchanged. Return false if it could not be sent
	* (the draft is kept).
	*/
	onSend;
	/** The user answered a pairing request. */
	onAnswer;
	/** End was pressed on a session in the menu. */
	onEnd;
	/** End was pressed (and, for this page, confirmed) on one of the user's pages in the menu. */
	onEndPage;
	/**
	* The host's avatar for a line that is not the agent's: its pictures are
	* tried first, its name and id fill in. Return nothing to use the line's
	* `sender` (and, on the user's own lines, `userAvatar`).
	*/
	avatarFor;
	/**
	* A voice output (`{ speak(text, id?), stop(why?) }`): replies are read
	* through it instead of speechSynthesis. Typing calls `stop("typing")`.
	*/
	voice;
	/**
	* Read-aloud's voice when the box reads with speechSynthesis itself (no
	* `voice` set): `lang` forces the language, `prefer` lists voice names to
	* try first (exact, then substring; src/voice-pick.ts). With `voice` set,
	* give the same to `voice({ lang, prefer })` instead.
	*/
	voicePrefer;
	_messages = [];
	_live = false;
	_listeners = 0;
	_sessions = [];
	_pending = null;
	_evalRan = false;
	_busy = false;
	busyTimer;
	lastReplyAt = 0;
	_pages = [];
	_self = "";
	/** The pages ticked in the pairing request, per pair id. */
	picked = /* @__PURE__ */ new Map();
	/** The page whose End was tapped once (this page needs a second tap). */
	confirmEnd = "";
	_friend = false;
	_notice = "";
	_warning = "";
	_defaultOpen = true;
	_placeholder = "";
	_treeSource;
	/** `owner/repo` that a bare `#123` in the tree links to. */
	treeRepo;
	/** The tree's strings (English defaults; Chinese on a zh page). */
	treeStrings = {};
	_strings = {};
	_agentAvatar = null;
	_user = {};
	/** The nodes agents listen at: "@/…" completions. */
	_nodes = [];
	/** The node the next line goes to ("/" = the main thread, no chip). */
	_target = ROOT_NODE;
	/** Polished lines shown as first heard (their mark tapped). */
	rawIds = /* @__PURE__ */ new Set();
	root;
	open = true;
	panel = "none";
	offline = false;
	pos = {
		x: 0,
		y: 0
	};
	_draft = "";
	/** The draft as dictation left it while nothing typed is in it (else null). */
	pure = null;
	_partial = "";
	_micActive = false;
	/** The input has focus: the log opens. */
	typing = false;
	/** The mark is held: the input shows how to use it. */
	holding = false;
	settledLen = 0;
	composing = false;
	shiftEnter = false;
	timer;
	els = {};
	markDrag = createDragFlag();
	taps = createTapper({
		onSingle: () => {
			this.setPanel("none");
			this.setOpen(!this.open);
		},
		onDouble: () => this.setPanel(this.panel === "menu" ? "none" : "menu")
	});
	atEnd = true;
	arrivals = createArrivals();
	readSeq = 0;
	wasOpen = true;
	floats = /* @__PURE__ */ new Map();
	floatHover = false;
	/** The frontier group opened by a tap (closed again on each minimize). */
	frontierOpen = null;
	place = {
		side: "left",
		left: 0
	};
	ro;
	treeStop;
	treeRoot = null;
	treeError = "";
	navIx = navIndexOf(null);
	nav = initialNav(this.navIx.ix);
	treeAxis = createAxisLock();
	treeDragged = createDragFlag();
	treePress = {
		cells: 0,
		limitAt: null
	};
	userScrollAt = 0;
	get messages() {
		return this._messages;
	}
	/** Replace the log (history on connect): never read aloud. */
	set messages(v) {
		this._messages = trimHistory(Array.isArray(v) ? v : []);
		this.messagesChanged();
	}
	/** One message that arrived live: kept once per id; an agent's is read aloud. */
	push(m) {
		if (!m || typeof m.text !== "string" || typeof m.id !== "string") return;
		if (this._messages.some((x) => x.id === m.id)) return;
		this._messages = trimHistory([...this._messages, m]);
		this.messagesChanged(m.from !== "agent");
		if (m.from !== "agent") return;
		this.lastReplyAt = Date.now();
		this.busy = false;
		this.speak(m.text, m.id);
	}
	/**
	* The agent polished a voice line ({type:"edited"}): it changes in place,
	* and is never read aloud again.
	*/
	edit(e) {
		if (!e || typeof e.id !== "string" || typeof e.text !== "string") return;
		this._messages = this._messages.map((m) => applyEdit(m, e));
		this.renderLog();
		this.renderFloatTexts();
	}
	/**
	* One busy beat from the agent: the spinner shows for BUSY_MS unless the
	* next beat renews it or a reply ends it. A beat right after a reply
	* (BUSY_AFTER_REPLY_MS) is that work's tail, and ignored.
	*/
	beat(at = Date.now()) {
		if (at - this.lastReplyAt < BUSY_AFTER_REPLY_MS) return;
		this.busy = true;
		this.busyTimer = setTimeout(() => this.busy = false, BUSY_MS);
	}
	set live(v) {
		this._live = !!v;
		this.renderStatus();
	}
	get live() {
		return this._live;
	}
	/** The state-tree nodes agents listen at (the hub's `state.nodes`): "@/…" completions. */
	set nodes(v) {
		this._nodes = Array.isArray(v) ? v.filter((n) => typeof n === "string") : [];
		this.renderAim();
	}
	/** The node the next line goes to ("/" = the main thread). */
	get target() {
		return this._target;
	}
	/** Address the next lines to a state-tree node ("/" = back to the main thread). */
	setTarget(path) {
		this._target = nodePath(path) ?? ROOT_NODE;
		this.renderAim();
		this.renderPlaceholder();
	}
	/** Agents listening now (shown in the status). */
	set listeners(v) {
		this._listeners = Number(v) || 0;
		this.renderStatus();
	}
	/** Approved sessions: a count on the tree button for eval, and a line with End in the menu. */
	set sessions(v) {
		this._sessions = Array.isArray(v) ? v : [];
		this.renderEvals();
		this.renderMenu();
	}
	/** A pairing waiting for the owner's answer. */
	set pending(v) {
		this._pending = v ?? null;
		this.renderAsks();
	}
	/** Code just ran on this page: the eval count pulses. */
	set evalRan(v) {
		this._evalRan = !!v;
		this.renderEvals();
	}
	/** The agent is working: a spinner in the input. */
	set busy(v) {
		clearTimeout(this.busyTimer);
		this._busy = !!v;
		this.renderBusy();
	}
	get busy() {
		return this._busy;
	}
	/** The user's connected pages (the hub's state.pages): offered when allowing, ended from the menu. */
	set pages(v) {
		this._pages = Array.isArray(v) ? v : [];
		this.renderAsks();
		this.renderMenu();
	}
	/** Which of `pages` this page is (the hub's state.self). */
	set self(v) {
		this._self = v ?? "";
		this.renderAsks();
		this.renderMenu();
	}
	/** A friend's page (not the user's): pairings are previews, with no chat scope to grant. */
	set friend(v) {
		this._friend = !!v;
		this.renderAsks();
	}
	/** Shown instead of the input when this viewer cannot chat. */
	set notice(v) {
		this._notice = v ?? "";
		this.renderInput();
	}
	/** A one-line note above the input (say, a message dropped by a rate limit). */
	set warning(v) {
		this._warning = v ?? "";
		this.renderInput();
	}
	/** Open or minimized on first visit (later visits remember). Attribute: collapsed. */
	set defaultOpen(v) {
		this._defaultOpen = !!v;
	}
	/**
	* The state tree (src/tree.ts): a URL serving its markdown, a function
	* returning markdown or nodes, or a feed `{subscribe(onUpdate) → unsubscribe}`.
	* The tree button shows it; it loads again each time the tree opens, and
	* its frontier fills the minimized bar's lines. Unset: "No tree source".
	*/
	set treeSource(v) {
		this._treeSource = v;
		this.loadTree();
		this.renderMenu();
	}
	get treeSource() {
		return this._treeSource;
	}
	/** Show the state tree (true) or hide it (false). */
	setTree(v) {
		this.setPanel(v ? "tree" : this.panel === "tree" ? "none" : this.panel);
	}
	/** The box's own strings (English, or Chinese on a zh page, under these). */
	set strings(v) {
		this._strings = v ?? {};
		this.renderAll();
	}
	/**
	* The agent's avatar: your app's logo, as a URL (or URLs in fallback
	* order) or an element (cloned onto each line). Attribute: agent-avatar.
	* Unset: the agent name's initial.
	*/
	set agentAvatar(v) {
		if (same(this._agentAvatar, v ?? null)) return;
		this._agentAvatar = v ?? null;
		this.renderLog();
	}
	get agentAvatar() {
		return this._agentAvatar;
	}
	/**
	* The user's picture on their own lines: a URL, or URLs in fallback order
	* (the app's own avatar, then the sign-in provider's image). Attribute:
	* user-avatar.
	*/
	set userAvatar(v) {
		this.setUser("avatar", v ?? void 0);
	}
	/** The user's name: their fallback avatar's initial. Attribute: user-name. */
	set userName(v) {
		this.setUser("name", v ?? void 0);
	}
	/** A stable id (or a hash of one, never an email): the user's fallback colour. */
	set userId(v) {
		this.setUser("id", v ?? void 0);
	}
	/** Re-render the log only when the value changed (wrappers set props on every render). */
	setUser(k, v) {
		if (same(this._user[k], v)) return;
		this._user = {
			...this._user,
			[k]: v
		};
		this.renderLog();
	}
	set placeholder(v) {
		this._placeholder = v;
		this.renderPlaceholder();
	}
	/** The draft in the input. */
	get draft() {
		return this._draft;
	}
	/**
	* Set the draft. With `source: "stt"` it is dictation: sent unchanged, the
	* line goes out with source "stt" (anything typed into it makes it the
	* user's own). It is never sent by itself while a mic is on.
	*/
	setDraft(text, opts) {
		const next = String(text ?? "").slice(0, MAX_CHAT);
		this.pure = opts?.source === "stt" ? dictatedDraft(this._draft, this.pure, next) : null;
		this._draft = next;
		this.settledLen = next.length;
		this.offline = false;
		const ta = this.els.input;
		if (ta) {
			ta.value = next;
			this.fitInput();
			ta.setSelectionRange?.(next.length, next.length);
			ta.scrollTop = ta.scrollHeight;
		}
		this.renderPartial();
		this.renderStatus();
		this.renderAim();
		this.arm();
	}
	/** A live transcript, shown dimmed after the draft and never committed (null: none). */
	setPartial(text) {
		this._partial = text ?? "";
		this.renderPartial();
		this.renderPlaceholder();
		this.arm();
	}
	/** A mic is on: treated as focus (the log opens, the box is opaque). Attribute: mic-active. */
	get micActive() {
		return this._micActive;
	}
	set micActive(v) {
		if (typeof this.toggleAttribute === "function") this.toggleAttribute("mic-active", !!v);
		else this.applyMic(!!v);
	}
	attributeChangedCallback(name) {
		if (name === "mic-active") this.applyMic(this.hasAttribute("mic-active"));
	}
	applyMic(v) {
		if (v === this._micActive) return;
		this._micActive = v;
		this.renderLayout();
		this.arm();
	}
	/** Per-device settings live under this prefix (attribute storage-key; default "liagent"). */
	key(name) {
		return `${this.getAttribute("storage-key") || "liagent"}:${name}`;
	}
	read(name) {
		try {
			return localStorage.getItem(this.key(name));
		} catch {
			return null;
		}
	}
	write(name, v) {
		try {
			localStorage.setItem(this.key(name), v);
		} catch {}
	}
	/** The speed setting under this box's storage key. */
	rateStore = {
		getItem: () => this.read("speech-rate"),
		setItem: (_k, v) => this.write("speech-rate", v)
	};
	/** Whether agent replies are read aloud on this device (on unless turned off). */
	get speaking() {
		return this.read("speak") !== "0";
	}
	/** How fast replies are read (1, 1.25, 1.5 or 2; per device, picked in the menu). */
	get speechRate() {
		return speechRate(this.rateStore);
	}
	/**
	* Read a reply aloud, after any still being read (always while a mic is on):
	* through `voice` if set, else speechSynthesis, in the language its script
	* suggests (with a matching installed voice), at `speechRate`.
	*/
	speak(text, id) {
		if (!this.speaking && !this._micActive) return;
		if (this.voice) return this.voice.speak(text, id);
		const s = synth();
		if (!s) return;
		const u = new SpeechSynthesisUtterance(text);
		u.lang = readingLang(this.voicePrefer, () => pickLang(text));
		u.rate = this.speechRate;
		const voice = voicePicker.pick(u.lang, this.voicePrefer);
		if (voice) u.voice = voice;
		s.speak(u);
	}
	stopSpeech(why) {
		if (this.voice) this.voice.stop(why);
		else cancelSpeech();
	}
	connectedCallback() {
		document.addEventListener("pointerdown", this.outside, true);
		document.addEventListener("keydown", this.escape, true);
		addEventListener("resize", this.relayout);
		addEventListener("orientationchange", this.relayout);
		globalThis.visualViewport?.addEventListener("resize", this.relayout);
		if (this.root) {
			this.loadTree();
			return;
		}
		if (this.hasAttribute("collapsed")) this._defaultOpen = false;
		const ph = this.getAttribute("placeholder");
		if (ph) this._placeholder = ph;
		const agentAv = this.getAttribute("agent-avatar");
		if (agentAv && !this._agentAvatar) this._agentAvatar = agentAv;
		const userAv = this.getAttribute("user-avatar");
		if (userAv && !this._user.avatar) this._user.avatar = userAv;
		const userName = this.getAttribute("user-name");
		if (userName && !this._user.name) this._user.name = userName;
		this._micActive = this.hasAttribute("mic-active");
		const o = this.read("open");
		this.open = o === null ? this._defaultOpen : o === "1";
		this.wasOpen = this.open;
		try {
			const v = JSON.parse(this.read("pos") ?? "null");
			if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) this.pos = v;
		} catch {}
		synth()?.getVoices();
		this.root = this.attachShadow({ mode: "open" });
		this.build();
		this.messagesChanged();
		this.renderAll();
		this.loadTree();
	}
	disconnectedCallback() {
		clearTimeout(this.timer);
		this.taps.cancel();
		this.treeStop?.();
		this.treeStop = void 0;
		document.removeEventListener("pointerdown", this.outside, true);
		document.removeEventListener("keydown", this.escape, true);
		removeEventListener("resize", this.relayout);
		removeEventListener("orientationchange", this.relayout);
		globalThis.visualViewport?.removeEventListener("resize", this.relayout);
	}
	/** A tap anywhere outside the menu and the mark closes the menu. */
	outside = (e) => {
		if (this.panel !== "menu") return;
		const path = e.composedPath();
		if (path.includes(this.els.menu) || path.includes(this.els.mark)) return;
		this.setPanel("none");
	};
	/** Escape closes the open panel (caught first, so a mic's own Escape never sees it). */
	escape = (e) => {
		if (e.key !== "Escape" || this.panel === "none") return;
		e.stopPropagation();
		this.setPanel("none");
	};
	/** A resize (window, rotation, the visual viewport): the bar stays on screen, the float box re-placed. */
	relayout = () => {
		this.fit();
		this.placeFloat();
	};
	get ui() {
		return {
			...uiStrings(),
			...this._strings
		};
	}
	get treeText() {
		return {
			...TREE_STRINGS_EN,
			...treeDefaults(),
			...this.treeStrings
		};
	}
	build() {
		const r = this.root;
		let style = "";
		try {
			const sheet = new CSSStyleSheet();
			sheet.replaceSync(CSS);
			r.adoptedStyleSheets = [sheet];
		} catch {
			style = `<style>${CSS}</style>`;
		}
		r.innerHTML = `${style}
<section class="box halo" id="box" aria-label="Chat with the agent">
  <div class="column" id="column">
    <ol class="log" id="log"></ol>
  </div>
  <div class="warn" id="warn" role="alert" hidden></div>
  <div class="asks" id="asks" aria-label="Agent connections"></div>
  <div class="rowbox" id="rowbox">
    <div class="aim" id="aim" hidden></div>
    <div class="bar" id="bar">
      <button type="button" class="tap mark" id="mark" title="${MARK_HINT}">${ICONS.mark}<span class="dot" id="dot"></span></button>
      <button type="button" class="tap treebtn" id="treebtn" aria-expanded="false" title="${TREE_HINT}">${ICONS.tree}<span class="evals" id="evals" aria-hidden="true" hidden></span><span class="thint" id="thint" role="status" hidden></span></button>
      <div class="slot" id="slot">
        <div class="mirror" id="mirror" aria-hidden="true" hidden><span class="ghost" id="ghost"></span><span class="partial" id="partial"></span></div>
        <textarea id="input" rows="1" maxlength="${MAX_CHAT}" aria-label="Message the agent"></textarea>
        <p class="notice" id="notice" role="status" hidden></p>
        <span class="spin" id="spin" role="status" hidden></span>
      </div>
      <div class="mic" id="mic" hidden><slot name="mic" id="micslot"></slot></div>
      <span class="unread" id="unread" hidden></span>
    </div>
    <span aria-hidden="true"></span>
    <div class="floatbox" id="floatbox" hidden>
      <div class="ftree" id="ftree"></div>
      <ol class="floats" id="floats" aria-live="polite"></ol>
      <ul class="frontier" id="frontier"></ul>
    </div>
    <div class="menu" id="menu" role="menu" hidden></div>
  </div>
</section>`;
		for (const el of r.querySelectorAll("[id]")) this.els[el.id] = el;
		const { box, bar, mark, treebtn, column, floats, rowbox } = this.els;
		const ta = this.els.input;
		const micslot = this.els.micslot;
		const panel = document.createElement("div");
		panel.className = "treepanel";
		panel.id = "tree";
		panel.setAttribute("role", "region");
		const x = document.createElement("button");
		x.type = "button";
		x.className = "x tap";
		x.textContent = "✕";
		x.addEventListener("mousedown", (e) => e.preventDefault());
		x.addEventListener("click", () => this.setPanel("none"));
		const body = document.createElement("div");
		body.className = "tbody";
		body.addEventListener("scroll", () => this.treeFade());
		panel.append(x, body);
		this.els.tree = panel;
		this.els.tbody = body;
		this.els.tclose = x;
		box.addEventListener("pointerdown", unlockSpeech);
		box.addEventListener("keydown", unlockSpeech);
		this.dragHandle(mark, () => true);
		mark.addEventListener("pointerdown", () => this.setHolding(true));
		for (const ev of ["pointerup", "pointercancel"]) mark.addEventListener(ev, () => this.setHolding(false));
		mark.addEventListener("click", () => !this.markDrag.wasDrag() && this.taps.tap());
		this.dragHandle(bar, (e) => e.target === bar);
		this.treeGestures(treebtn);
		column.addEventListener("scroll", () => this.onColumnScroll());
		column.addEventListener("wheel", () => this.userScrollAt = Date.now(), { passive: true });
		column.addEventListener("touchmove", () => this.userScrollAt = Date.now(), { passive: true });
		column.addEventListener("transitionend", (e) => {
			if (e.target !== column) return;
			if (!this.wide()) this.toEnd();
			this.onColumnScroll();
		});
		rowbox.addEventListener("transitionend", (e) => {
			if (e.target !== rowbox) return;
			this.fitInput();
			this.placeFloat();
		});
		floats.addEventListener("pointerenter", () => this.holdFloats(true));
		floats.addEventListener("pointerleave", () => this.holdFloats(false));
		floats.addEventListener("pointercancel", () => this.holdFloats(false));
		floats.addEventListener("touchstart", () => this.holdFloats(true), { passive: true });
		floats.addEventListener("touchend", () => this.holdFloats(false), { passive: true });
		micslot.addEventListener("slotchange", () => {
			this.els.mic.hidden = !micslot.assignedElements().length;
		});
		this.els.mic.hidden = !micslot.assignedElements().length;
		if (typeof ResizeObserver !== "undefined") {
			let width = ta.clientWidth;
			this.ro = new ResizeObserver((entries) => {
				for (const e of entries) if (e.target === ta) {
					if (ta.clientWidth === width) continue;
					width = ta.clientWidth;
					this.fitInput();
				} else this.placeFloat();
			});
			this.ro.observe(ta);
			this.ro.observe(this.els.floatbox);
		}
		ta.addEventListener("input", () => {
			this._draft = ta.value;
			this.offline = false;
			this.stopSpeech("typing");
			this.fitInput();
			this.renderPartial();
			this.arm();
			this.renderStatus();
			this.renderAim();
		});
		ta.addEventListener("scroll", () => this.els.mirror.scrollTop = ta.scrollTop);
		ta.addEventListener("focus", () => {
			this.typing = true;
			this.renderLayout();
		});
		ta.addEventListener("blur", () => {
			this.typing = false;
			this.renderLayout();
		});
		ta.addEventListener("compositionstart", () => {
			this.composing = true;
			this.disarm();
		});
		ta.addEventListener("compositionend", () => {
			this.composing = false;
			this.arm();
		});
		ta.addEventListener("beforeinput", (e) => {
			const ie = e;
			if (lineBreakSends(ie.inputType, {
				composing: this.composing,
				isComposing: ie.isComposing,
				shiftEnter: this.shiftEnter
			})) {
				e.preventDefault();
				const first = this.completions()[0];
				if (first) return this.pick(first);
				this.submit();
			}
		});
		ta.addEventListener("keydown", (e) => {
			this.shiftEnter = e.key === "Enter" && e.shiftKey;
			const first = this.completions()[0];
			if ((e.key === "Tab" || e.key === "Enter") && !e.shiftKey && first) {
				e.preventDefault();
				return this.pick(first);
			}
			if (e.key === "Backspace" && !this._draft && this._target !== ROOT_NODE) return this.setTarget(ROOT_NODE);
			if (!enterSends(e, this.composing)) return;
			e.preventDefault();
			this.submit();
		});
		this.swipeScrollsLog(ta);
	}
	/**
	* The log is click-through, so it can't be scrolled where it is: a wheel,
	* trackpad or touch scroll over the input scrolls it instead, empty or not.
	* Text that overflows the input scrolls first, and at its end the rest of
	* the gesture goes on to the log (src/scroll-handoff.ts). A move the input
	* scrolls itself is never cancelled, and a tap still places the caret.
	*/
	swipeScrollsLog(el) {
		const toLog = (d) => {
			if (!d) return;
			this.els.column.scrollTop += d;
			this.userScrollAt = Date.now();
		};
		el.addEventListener("wheel", (e) => {
			if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
			const { inputDelta, logDelta } = splitScroll(el, wheelPixels(e.deltaY, e.deltaMode, this.els.column.clientHeight));
			if (!logDelta) return;
			e.preventDefault();
			if (inputDelta) el.scrollTop += inputDelta;
			toLog(logDelta);
		}, { passive: false });
		const swipe = createSwipeHandoff();
		el.addEventListener("touchstart", (e) => swipe.start(e.touches[0].clientY), { passive: true });
		el.addEventListener("touchmove", (e) => {
			if (e.touches.length !== 1) return;
			const step = swipe.move(el, e.touches[0].clientY, e.cancelable);
			if (!step) return;
			if (step.prevent) e.preventDefault();
			if (step.inputDelta) el.scrollTop += step.inputDelta;
			toLog(step.logDelta);
		}, { passive: false });
	}
	/**
	* Drag the box by `el` anywhere on screen: an offset from its bottom-right
	* home, the bar kept on screen (up to the notch) and remembered. A press
	* that moves under 5 px is still a click.
	*/
	dragHandle(el, accept) {
		let d = null;
		el.addEventListener("pointerdown", (e) => {
			if (!accept(e)) return;
			d = {
				px: e.clientX,
				py: e.clientY,
				x: this.pos.x,
				y: this.pos.y,
				moved: false
			};
			this.markDrag.down();
			el.setPointerCapture?.(e.pointerId);
		});
		el.addEventListener("pointermove", (e) => {
			if (!d) return;
			const dx = e.clientX - d.px;
			const dy = e.clientY - d.py;
			if (!d.moved && Math.hypot(dx, dy) < 5) return;
			d.moved = true;
			const bar = this.els.bar.getBoundingClientRect();
			const left = bar.left - (this.pos.x - d.x);
			const top = bar.top - (this.pos.y - d.y);
			const safeTop = safeInsets().top;
			this.pos = {
				x: d.x + Math.max(-left, Math.min(innerWidth - bar.width - left, dx)),
				y: d.y + Math.max(safeTop - top, Math.min(innerHeight - bar.height - top, dy))
			};
			this.style.transform = `translate(${this.pos.x}px, ${this.pos.y}px)`;
		});
		const end = () => {
			const moved = d?.moved;
			d = null;
			this.setHolding(false);
			if (!moved) return;
			this.markDrag.dragEnded();
			this.write("pos", JSON.stringify(this.pos));
			this.placeFloat();
		};
		el.addEventListener("pointerup", end);
		el.addEventListener("pointercancel", () => {
			d = null;
			this.setHolding(false);
		});
	}
	setHolding(v) {
		if (this.holding === v) return;
		this.holding = v;
		this.renderPlaceholder();
	}
	/**
	* Bring the bar back on screen (after expanding where the minimized bar
	* was, or on a smaller screen). Expanded, the bar spans the box, so the
	* box's own edges count.
	*/
	fit() {
		const bar = this.els.bar?.getBoundingClientRect();
		const box = this.els.box?.getBoundingClientRect();
		if (!bar || !box || !bar.width) return;
		const row = this.open ? box : bar;
		const top = safeInsets().top;
		const dx = row.left < 0 ? -row.left : row.right > innerWidth ? innerWidth - row.right : 0;
		const dy = bar.top < top ? top - bar.top : bar.bottom > innerHeight ? innerHeight - bar.bottom : 0;
		if (!dx && !dy) return;
		this.pos = {
			x: this.pos.x + dx,
			y: this.pos.y + dy
		};
		this.style.transform = `translate(${this.pos.x}px, ${this.pos.y}px)`;
		this.write("pos", JSON.stringify(this.pos));
	}
	/**
	* The tree button: a tap opens or closes the tree; a horizontal drag (axis
	* locked after 8 px) moves the focused node through its detents — right
	* opens it a level per cell, left folds it (src/tree-nav.ts) — with a live
	* preview, resisting past a limit, committed on release. A vertical drag
	* does nothing. Arrow keys on it move in the open tree.
	*/
	treeGestures(b) {
		b.addEventListener("mousedown", (e) => e.preventDefault());
		b.addEventListener("pointerdown", (e) => {
			this.treeAxis.down(e.clientX, e.clientY);
			this.treeDragged.down();
			this.treePress = {
				cells: 0,
				limitAt: null
			};
			b.setPointerCapture?.(e.pointerId);
		});
		b.addEventListener("pointermove", (e) => {
			const was = this.treeAxis.axis();
			const m = this.treeAxis.move(e.clientX, e.clientY);
			if (!m || m.axis !== "x" || !this._treeSource) return;
			if (!was) {
				if (this.panel !== "tree") this.setPanel("tree");
				this.nav = treeNav(this.navIx.ix, this.nav, { type: "dragStart" });
			}
			const p = this.treePress;
			p.cells = dragCells(m.dx, p.cells);
			const next = treeNav(this.navIx.ix, this.nav, {
				type: "dragMove",
				cells: p.cells
			});
			p.limitAt = next.atLimit ? p.limitAt ?? p.cells - Math.sign(p.cells) : null;
			this.setNav(next);
			this.showTreeHint(m.dx, p.limitAt);
		});
		b.addEventListener("pointerup", () => {
			const axis = this.treeAxis.up();
			if (!axis) return;
			this.treeDragged.dragEnded();
			if (axis === "x") this.navTo({ type: "dragEnd" });
			this.els.thint.hidden = true;
		});
		b.addEventListener("pointercancel", () => {
			if (this.treeAxis.up() === "x") this.navTo({ type: "dragCancel" });
			this.els.thint.hidden = true;
		});
		b.addEventListener("click", () => {
			if (this.treeDragged.wasDrag()) return;
			this.setPanel(this.panel === "tree" ? "none" : "tree");
		});
		b.addEventListener("keydown", (e) => {
			if (this.panel !== "tree" || !e.key.startsWith("Arrow")) return;
			e.preventDefault();
			this.navTo({
				type: "key",
				key: e.key
			});
		});
	}
	/** While dragging: the focused node and the depth it would open to, following the finger. */
	showTreeHint(dx, limitAt) {
		const hint = this.els.thint;
		const id = this.nav.focusId;
		const node = id === null ? void 0 : this.navIx.byId.get(id);
		const depth = id === null ? 0 : this.nav.expanded[id] ?? 0;
		const max = id === null ? 0 : maxDetent(this.navIx.ix, id);
		hint.textContent = node ? `${node.title} · ${depth}/${max}` : "—";
		hint.style.transform = `translateX(${Math.round(dragOffset(dx, limitAt ?? void 0) * .25)}px)`;
		hint.hidden = false;
	}
	/** (Re)load the tree: once for a URL or function, a subscription for a feed. Never polls. */
	loadTree() {
		this.treeStop?.();
		this.treeStop = void 0;
		const src = this._treeSource;
		if (!src) {
			this.treeRoot = null;
			this.treeError = "";
			this.setRoot(null);
			return;
		}
		if (!this.isConnected || !this.root) return;
		this.treeStop = watchTree(src, { repo: this.treeRepo }, (root) => {
			this.treeError = "";
			this.setRoot(root);
		}, (e) => {
			this.treeError = e instanceof Error ? e.message : String(e);
			this.renderTree();
		});
	}
	setRoot(root) {
		this.treeRoot = root;
		this.navIx = navIndexOf(root);
		const f = this.nav.focusId;
		if (f === null || !this.navIx.ix.parent.has(f)) this.nav = initialNav(this.navIx.ix);
		this.renderTree();
		this.renderFrontier();
	}
	setNav(next) {
		if (next === this.nav) return;
		this.nav = next;
		this.renderTree();
	}
	/**
	* One nav step. After it, an expand brings the focused node and its new
	* children into view (unless the user is scrolling); a fold keeps the
	* focused row where it was.
	*/
	navTo(ev) {
		const scroller = this.open ? this.els.column : this.els.tbody;
		const rows = () => this.els.tbody.querySelectorAll("[data-id]");
		const tops = /* @__PURE__ */ new Map();
		for (const r of rows()) tops.set(r.dataset.id, r.getBoundingClientRect().top);
		const sum = (e) => Object.values(e).reduce((a, b) => a + b, 0);
		const prev = this.nav;
		const next = treeNav(this.navIx.ix, prev, ev);
		this.setNav(next);
		const f = next.focusId;
		if (f === null) return;
		const row = [...rows()].find((r) => r.dataset.id === f);
		if (!row) return;
		if (sum(next.expanded) > sum(prev.expanded)) {
			if (Date.now() - this.userScrollAt < 600) return;
			const last = [...rows()].filter((r) => r.dataset.id.startsWith(`${f}.`)).at(-1) ?? row;
			const top = row.getBoundingClientRect().top;
			const bottom = last.getBoundingClientRect().bottom;
			const box = scroller.getBoundingClientRect();
			if (bottom > box.bottom) scroller.scrollTop += Math.min(bottom - box.bottom, top - box.top);
			else if (top < box.top) scroller.scrollTop -= box.top - top;
		} else {
			const was = tops.get(f);
			if (was !== void 0) scroller.scrollTop += row.getBoundingClientRect().top - was;
		}
	}
	renderTree() {
		if (!this.root) return;
		const body = this.els.tbody;
		const t = this.treeText;
		body.replaceChildren(this._treeSource ? renderTreeChips({
			root: this.treeRoot,
			nav: this.nav,
			ix: this.navIx.ix,
			byId: this.navIx.byId,
			onNav: (ev) => this.navTo(ev),
			status: this.treeError ? `${t.failed} (${this.treeError})` : this.treeRoot ? void 0 : t.loading,
			empty: t.empty,
			label: this.ui.stateTree,
			needsYou: this.ui.needsYou
		}) : Object.assign(document.createElement("p"), {
			className: "chips status",
			textContent: this.ui.noTreeSource
		}));
		this.treeFade();
	}
	/** The floating tree overflows (or is scrolled): its top edge fades, as the log's. */
	treeFade() {
		const b = this.els.tbody;
		if (b) b.classList.toggle("fade", b.scrollHeight > b.clientHeight + 1 || b.scrollTop > 0);
	}
	disarm() {
		clearTimeout(this.timer);
		this.els.bar?.querySelector(".drain")?.remove();
	}
	arm() {
		this.disarm();
		if (parseAddress(this._draft)?.complete === false) return;
		const next = afterChange(this._draft, this.settledLen, this.composing);
		if (!this.composing) this.settledLen = this._draft.length;
		if (next === "send") return void this.submit();
		if (next === "idle" || this._micActive || this._partial) return;
		const bar = document.createElement("div");
		bar.className = "drain";
		bar.setAttribute("aria-hidden", "true");
		bar.style.setProperty("--drain-ms", `${DEBOUNCE_MS}ms`);
		this.els.bar.prepend(bar);
		this.timer = setTimeout(() => this.submit(), DEBOUNCE_MS);
	}
	/**
	* Send the draft now, as Enter would; true if it went out. Kept (and the
	* status says so) if it could not.
	*/
	submit() {
		this.disarm();
		let text = this._draft.trim();
		const addr = parseAddress(text);
		if (addr) {
			if (!addr.complete) return false;
			this.setTarget(addr.to);
			text = addr.text;
			if (!text) {
				this.clearDraft();
				return false;
			}
		}
		if (!text) return false;
		const to = this._target === ROOT_NODE ? void 0 : this._target;
		const source = draftSource(this._draft, this.pure);
		if (!this.onSend?.(text, to, source ? { source } : void 0)) {
			this.offline = true;
			this.renderStatus();
			return false;
		}
		this.offline = false;
		this.clearDraft();
		return true;
	}
	clearDraft() {
		this._draft = "";
		this.pure = null;
		this.settledLen = 0;
		const ta = this.els.input;
		if (ta) ta.value = "";
		this.fitInput();
		this.renderPartial();
		this.renderStatus();
		this.renderAim();
	}
	/**
	* The input grows with its text up to INPUT_MAX_PX, then scrolls inside
	* itself. Empty, it is one line (nothing measured: a placeholder measured
	* in a narrow slot wraps to several lines).
	*/
	fitInput() {
		const el = this.els.input;
		if (!el) return;
		el.style.height = "";
		if (!el.value || el.clientWidth < 40) return;
		el.style.height = "auto";
		const border = el.offsetHeight - el.clientHeight;
		el.style.height = `${Math.min(el.scrollHeight + border, INPUT_MAX_PX)}px`;
	}
	/** The draft's "@/…" while it is typed: the listening nodes under it. */
	completions() {
		const a = /^@\/\S*(?:\s*›\s*\S*)*$/.test(this._draft) ? parseAddress(this._draft) : null;
		return a && !a.complete ? completeNode(this._draft, this._nodes) : [];
	}
	pick(n) {
		this.setTarget(n);
		this.clearDraft();
		this.els.input.focus();
	}
	renderPlaceholder() {
		const ta = this.els.input;
		if (!ta) return;
		ta.placeholder = this.holding ? DRAG_HINT : this._partial ? "" : this._target !== ROOT_NODE ? `Message ${pathLabel(this._target)}…` : this._placeholder || (this._live && !this._listeners ? "Agent offline — your message waits for it…" : "Message the agent…");
	}
	/** The live transcript: a mirror of the draft, invisible, then the partial text dimmed. */
	renderPartial() {
		const mirror = this.els.mirror;
		if (!mirror) return;
		const tail = partialTail(this._draft, this._partial);
		mirror.hidden = !tail;
		this.els.ghost.textContent = tail ? this._draft : "";
		this.els.partial.textContent = tail;
		mirror.scrollTop = this.els.input.scrollTop;
	}
	/** The target chip (× back to the main thread) and the "@/…" completions. */
	renderAim() {
		const aim = this.els.aim;
		if (!aim) return;
		aim.replaceChildren();
		const list = this.completions();
		const typed = parseAddress(this._draft)?.complete ? parseAddress(this._draft) : null;
		const shown = typed ? typed.to : this._target;
		if (list.length) {
			const ul = document.createElement("ul");
			ul.className = "nodes";
			ul.setAttribute("role", "listbox");
			ul.setAttribute("aria-label", "Nodes to address");
			for (const n of list) {
				const li = document.createElement("li");
				li.setAttribute("role", "option");
				const b = document.createElement("button");
				b.type = "button";
				b.textContent = pathLabel(n);
				b.addEventListener("pointerdown", (e) => e.preventDefault());
				b.addEventListener("click", () => this.pick(n));
				li.append(b);
				ul.append(li);
			}
			aim.append(ul);
		}
		if (shown !== ROOT_NODE) {
			const chip = document.createElement("span");
			chip.className = typed ? "target preview" : "target";
			chip.dataset.node = shown;
			const border = lineNode({
				from: "owner",
				to: shown
			})?.border;
			if (border) chip.style.setProperty("--node", border);
			const label = document.createElement("span");
			label.textContent = `→ ${pathLabel(shown)}`;
			chip.append(label);
			if (!typed) {
				const x = document.createElement("button");
				x.type = "button";
				x.textContent = "×";
				x.setAttribute("aria-label", "Send to the main thread instead");
				x.addEventListener("pointerdown", (e) => e.preventDefault());
				x.addEventListener("click", () => this.setTarget(ROOT_NODE));
				chip.append(x);
			}
			aim.append(chip);
		}
		aim.hidden = !this.open || !aim.childElementCount;
	}
	setOpen(v) {
		if (v) this.atEnd = true;
		this.open = v;
		this.write("open", v ? "1" : "0");
		this.messagesChanged();
		this.renderAll();
		requestAnimationFrame?.(() => this.fit());
	}
	setPanel(p) {
		if (p === this.panel) return;
		const opening = p === "tree" && this.panel !== "tree";
		this.panel = p;
		if (opening) this.loadTree();
		this.renderLayout();
		this.renderMenu();
		if (opening && this.open) this.els.column.scrollTop = 0;
		requestAnimationFrame?.(() => this.fit());
	}
	/** The log opens to 30vh while the input has focus, a mic is on, or the tree is open. */
	wide() {
		return this.typing || this._micActive || this.panel === "tree";
	}
	status() {
		if (this._notice) return "chat unavailable";
		if (this.offline) return "not connected — your draft is kept";
		if (!this._live) return "reconnecting…";
		return this._listeners ? `agent listening (${this._listeners})` : "agent offline · messages wait until it is back";
	}
	renderAll() {
		if (!this.root) return;
		this.style.transform = `translate(${this.pos.x}px, ${this.pos.y}px)`;
		this.renderLayout();
		this.renderAsks();
		this.renderEvals();
		this.renderBusy();
		this.renderLog();
		this.renderInput();
		this.renderAim();
		this.renderPlaceholder();
		this.renderPartial();
		this.renderTree();
		this.renderFrontier();
		this.renderStatus();
		this.renderMenu();
	}
	/** Open or minimized, which panel, the column's size: the box's frame. */
	renderLayout() {
		if (!this.root) return;
		const { box, column, slot, mark, treebtn, tree, tclose, ftree } = this.els;
		const ui = this.ui;
		box.classList.toggle("min", !this.open);
		box.classList.toggle("on", this._micActive || this.panel !== "none");
		column.hidden = !this.open;
		slot.toggleAttribute("inert", !this.open);
		if (this.open) slot.removeAttribute("aria-hidden");
		else slot.setAttribute("aria-hidden", "true");
		mark.setAttribute("aria-expanded", String(this.open));
		treebtn.setAttribute("aria-expanded", String(this.panel === "tree"));
		treebtn.setAttribute("aria-label", ui.stateTree);
		tree.setAttribute("aria-label", ui.stateTree);
		tclose.setAttribute("aria-label", ui.closeTree);
		if (this.panel === "tree") {
			const host = this.open ? column : ftree;
			if (tree.parentElement !== host) host.prepend(tree);
		} else tree.remove();
		const wide = this.wide();
		column.classList.toggle("wide", wide);
		this.els.tbody.classList.toggle("wide", wide);
		this.renderAim();
		this.renderFrontier();
		this.onColumnScroll();
		this.treeFade();
		if (!wide && this.panel !== "tree") this.toEnd();
		this.placeFloat();
	}
	renderStatus() {
		if (!this.root) return;
		const dot = this._live && this._listeners ? "oklch(0.68 0.16 150)" : this._live ? "oklch(0.75 0.13 75)" : "oklch(0.62 0.02 70)";
		this.els.dot.style.background = dot;
		const status = this.status();
		this.els.bar.title = status;
		const unread = this.open ? 0 : countUnread(this._messages, (id) => this.arrivals.seqOf(id), this.readSeq);
		const badge = this.els.unread;
		badge.hidden = unread === 0;
		badge.textContent = String(unread);
		this.els.mark.setAttribute("aria-label", this.open ? "Minimize chat" : `Restore chat${unread ? `, ${unread} new` : ""}`);
		this.renderPlaceholder();
		if (this.panel === "menu") this.renderMenu();
	}
	/** The eval/preview sessions on the tree button: their count, pulsing when code just ran. */
	renderEvals() {
		if (!this.root) return;
		const evals = this._sessions.filter((x) => x.scope !== "chat");
		const b = this.els.evals;
		b.hidden = !evals.length;
		b.textContent = String(evals.length);
		b.classList.toggle("ran", this._evalRan);
		const kind = this._friend ? "preview" : "eval";
		this.els.treebtn.title = evals.length ? `${TREE_HINT}\n${evals.map((x) => `${kind}: ${x.label} · ${x.code}`).join("\n")}` : TREE_HINT;
	}
	/** The spinner in the input while the agent works. */
	renderBusy() {
		if (!this.root) return;
		const s = this.els.spin;
		s.hidden = !this._busy;
		s.title = "the agent is working";
		s.setAttribute("aria-label", "the agent is working");
		this.els.input.classList.toggle("pe", this._busy);
	}
	/** A pairing request above the bar. */
	renderAsks() {
		if (!this.root) return;
		const row = this.els.asks;
		row.replaceChildren();
		const p = this._pending;
		if (p) row.append(this.renderAsk(p));
	}
	/**
	* A pairing request, compact: its code, what it asks for, Allow and ✕ —
	* and, for code on a user with more than one page open, a checkbox per
	* page (this one ticked) plus "all pages". Chat is always every page. An agent that did not say what
	* it wants (an older client) gets the two old answers: code (8h) and chat.
	*/
	renderAsk(p) {
		const ask = document.createElement("span");
		ask.className = "ask";
		ask.setAttribute("role", "alertdialog");
		const what = this._friend ? "to run code on the chosen pages, for 1 hour" : p.scope === "eval" ? "to run code on the chosen pages and chat, for 8 hours" : p.scope === "chat" ? "to chat with you, for 30 days" : "to run code on your pages, or to chat";
		const sentence = `${p.label} asks ${what}. Allow only if the agent shows the same code: ${p.code}.`;
		ask.setAttribute("aria-label", sentence);
		ask.title = sentence;
		ask.innerHTML = ICONS.lock;
		const code = document.createElement("b");
		code.textContent = p.code;
		ask.append(code);
		if (p.scope) {
			const tag = document.createElement("span");
			tag.className = "tag";
			tag.textContent = this._friend ? "code · 1h" : p.scope === "eval" ? "code · 8h" : "chat · 30d";
			ask.append(tag);
		}
		if (!this.picked.has(p.pair)) this.picked.set(p.pair, new Set(this._self ? [this._self] : []));
		const picked = this.picked.get(p.pair);
		const pages = () => {
			const cur = this.picked.get(p.pair);
			if (cur === "all") return "all";
			return cur && cur.size ? [...cur] : void 0;
		};
		const btn = (cls, text, title, fn) => {
			const b = document.createElement("button");
			b.type = "button";
			b.className = cls;
			b.textContent = text;
			b.title = title;
			b.setAttribute("aria-label", title);
			b.addEventListener("click", fn);
			ask.append(b);
		};
		if (p.scope || this._friend) btn("y", "Allow", "Allow on the ticked pages", () => this.onAnswer?.("allow", p, { pages: pages() }));
		else {
			btn("y", "8h", "Allow code and chat for 8 hours", () => this.onAnswer?.("allow", p, { pages: pages() }));
			btn("c", "chat", "Chat only, for 30 days", () => this.onAnswer?.("allow", p, {
				pages: pages(),
				scope: "chat"
			}));
		}
		btn("n", "✕", "Deny", () => this.onAnswer?.("deny", p, {}));
		if (this._pages.length < 2 || p.scope === "chat" && !this._friend) return ask;
		const wrap = document.createElement("div");
		wrap.className = "askwrap";
		const list = document.createElement("div");
		list.className = "pagelist";
		const box = (label, checked, on) => {
			const l = document.createElement("label");
			const c = document.createElement("input");
			c.type = "checkbox";
			c.checked = checked;
			c.addEventListener("change", () => on(c.checked));
			l.append(c, document.createTextNode(label));
			list.append(l);
		};
		const all = picked === "all";
		for (const pg of this._pages) box(`${pageHint(pg.label)}${pg.id === this._self ? " (this page)" : ""}`, all || picked.has(pg.id), (v) => {
			const cur = this.picked.get(p.pair);
			const set = cur === "all" ? new Set(this._pages.map((x) => x.id)) : new Set(cur);
			if (v) set.add(pg.id);
			else set.delete(pg.id);
			this.picked.set(p.pair, set);
			this.renderAsks();
		});
		box("all pages, and pages opened later", all, (v) => {
			this.picked.set(p.pair, v ? "all" : new Set(this._self ? [this._self] : []));
			this.renderAsks();
		});
		wrap.append(ask, list);
		return wrap;
	}
	/** A polished line's body (its text, or tapped, the raw STT text) and its sparkle. */
	lineBody(m, onToggle) {
		if (!m.edited || m.raw === void 0) return [document.createTextNode(m.text)];
		const raw = this.rawIds.has(m.id);
		const body = document.createElement("span");
		if (raw) body.className = "raw";
		body.textContent = raw ? m.raw : m.text;
		const mark = document.createElement("button");
		mark.type = "button";
		mark.className = "polished";
		mark.title = this.ui.polished;
		mark.setAttribute("aria-label", this.ui.polished);
		mark.setAttribute("aria-pressed", String(raw));
		mark.innerHTML = ICONS.sparkle;
		mark.addEventListener("click", (ev) => {
			ev.stopPropagation();
			if (!this.rawIds.delete(m.id)) this.rawIds.add(m.id);
			onToggle();
		});
		return [body, mark];
	}
	renderLog() {
		if (!this.root) return;
		const log = this.els.log;
		log.replaceChildren();
		if (this._messages.length === 0) {
			const li = document.createElement("li");
			li.className = "hint";
			li.textContent = `Type here; it is sent ${DEBOUNCE_MS / 1e3} s after you stop.`;
			log.append(li);
		}
		for (const m of this._messages) {
			const li = document.createElement("li");
			li.dataset.from = m.from;
			const who = lineAvatar(m, {
				friend: this._friend,
				user: this._user,
				agentAvatar: this._agentAvatar,
				avatarFor: this.avatarFor
			});
			const node = lineNode(m);
			li.title = node ? `${when(m.at)} · ${who.name} · ${node.subtitle}` : when(m.at);
			const text = document.createElement("span");
			text.className = "text";
			if (node) {
				li.classList.add("node");
				li.dataset.node = node.node;
				li.style.setProperty("--node", node.border);
				const sub = document.createElement("span");
				sub.className = "sub";
				sub.setAttribute("aria-hidden", "true");
				sub.textContent = node.subtitle;
				text.append(sub);
			}
			const sr = document.createElement("span");
			sr.className = "sr";
			sr.textContent = node ? `${who.name} (${node.subtitle}): ` : `${who.name}: `;
			text.append(sr, ...this.lineBody(m, () => {
				this.renderLog();
				this.renderFloatTexts();
			}));
			li.append(avatarEl(who.srcs, who.node, who.name, initialOf(who.initialFrom), who.seed), text);
			log.append(li);
		}
		if (this.open && this.atEnd) this.toEnd();
		this.onColumnScroll();
		this.renderStatus();
	}
	toEnd() {
		const c = this.els.column;
		if (!c || !this.open) return;
		c.scrollTop = c.scrollHeight;
		this.atEnd = true;
	}
	onColumnScroll() {
		const c = this.els.column;
		if (!c) return;
		c.classList.toggle("fade", c.scrollHeight > c.clientHeight + 1 || c.scrollTop > 0);
		this.atEnd = c.scrollHeight - c.scrollTop - c.clientHeight < 4;
	}
	/**
	* After the messages (or open/minimized) changed: what arrived (by id, on
	* this device's clock), what is read, and what floats. Expanded, everything
	* is read and nothing floats; just minimized, the latest floats again;
	* minimized, every new line floats — never the history loading in.
	*/
	messagesChanged(mine = false) {
		const now = Date.now();
		const { fresh, history } = this.arrivals.see(this._messages, now);
		if (this.open || history) this.readSeq = this.arrivals.seq();
		const minimizing = this.wasOpen && !this.open;
		this.wasOpen = this.open;
		if (mine) this.atEnd = true;
		this.renderLog();
		if (!this.root) return;
		if (this.open) return this.clearFloats();
		if (minimizing) {
			this.clearFloats();
			this.frontierOpen = null;
			const last = minimizeFloat(this._messages, now, this.arrivals.at);
			if (last) this.addFloat(last);
			return;
		}
		if (history) return;
		for (const m of fresh) this.addFloat(m);
	}
	clearFloats() {
		for (const f of this.floats.values()) f.life.cancel();
		this.floats.clear();
		this.els.floats?.replaceChildren();
	}
	addFloat(m) {
		const old = this.floats.get(m.id);
		if (old) {
			old.life.cancel();
			old.li.remove();
			this.floats.delete(m.id);
		}
		const li = document.createElement("li");
		li.className = "float";
		li.dataset.from = m.from;
		const f = {
			m,
			li,
			life: createFloatLife({
				ms: dwellMs(m.text),
				reducedMotion: reducedMotion(),
				paused: this.floatHover,
				onPhase: (p) => {
					if (p === "gone") this.dropFloat(m.id);
					else li.classList.toggle("fading", p === "fade");
				}
			})
		};
		this.floats.set(m.id, f);
		this.fillFloat(f.li, m);
		this.els.floats.append(li);
		while (this.floats.size > FLOAT_MAX) this.dropFloat(this.floats.keys().next().value);
		this.placeFloat();
	}
	dropFloat(id) {
		const f = this.floats.get(id);
		if (!f) return;
		f.life.cancel();
		f.li.remove();
		this.floats.delete(id);
		this.placeFloat();
	}
	/** "who: text" (the latest copy: an edit changes it in place), and a polished line's sparkle. */
	fillFloat(li, m0) {
		const m = this._messages.find((x) => x.id === m0.id) ?? m0;
		const who = document.createElement("span");
		who.className = "who";
		who.style.color = m.from !== "agent" ? "oklch(0.55 0.13 250)" : "oklch(0.55 0.14 150)";
		who.textContent = `${m.from !== "agent" ? "you" : m.label || "agent"}:`;
		li.replaceChildren(who, ...this.lineBody(m, () => this.renderFloatTexts()));
	}
	renderFloatTexts() {
		for (const f of this.floats.values()) this.fillFloat(f.li, f.m);
	}
	/** Hovered or touched: every line's timer waits; released, they go on. */
	holdFloats(v) {
		if (this.floatHover === v) return;
		this.floatHover = v;
		for (const f of this.floats.values()) (v ? f.life.pause : f.life.resume)();
	}
	renderFrontier() {
		if (!this.root) return;
		const ul = this.els.frontier;
		ul.replaceChildren();
		if (this.open || !this.treeRoot) return this.placeFloat();
		const lang = globalThis.document?.documentElement.lang || void 0;
		const view = frontierView(frontier(this.treeRoot, { locale: lang }));
		const ui = this.ui;
		for (const r of FRONTIER_ROWS) {
			const line = view?.[r.key];
			if (!line?.text) continue;
			const items = line.items ?? [];
			const group = items.length > 0;
			const expanded = group && this.frontierOpen === r.key;
			const id = r.key === "doing" ? shownAgentId(line.assignee) : null;
			const count = countBadge(line.count);
			const li = document.createElement("li");
			li.dataset.status = r.key;
			if (expanded) li.dataset.expanded = "";
			const row = document.createElement("div");
			row.className = "fl";
			const b = document.createElement("button");
			b.type = "button";
			b.className = "fb";
			const name = r.key === "done" ? ui.lastDone : r.key === "doing" ? ui.nowDoing : ui.upNext;
			b.setAttribute("aria-label", `${name}: ${line.text}${count ? `, ${line.count} ${ui.items}` : ""}`);
			if (group) b.setAttribute("aria-expanded", String(expanded));
			b.addEventListener("mousedown", (e) => e.preventDefault());
			b.addEventListener("click", () => {
				if (!group) return;
				this.frontierOpen = expanded ? null : r.key;
				this.renderFrontier();
			});
			const mk = document.createElement("span");
			mk.className = `m${r.key === "doing" ? " blink" : ""}`;
			mk.setAttribute("aria-hidden", "true");
			mk.textContent = r.mark;
			b.append(mk);
			if (r.key === "doing" && line.assignee) {
				const av = assigneeAvatar(line.assignee);
				av.classList.add("blink");
				b.append(av);
			}
			const t = document.createElement("span");
			t.className = "t";
			t.textContent = line.text;
			b.append(t);
			if (count) {
				const n = document.createElement("span");
				n.className = "n";
				n.textContent = count;
				b.append(n);
			}
			row.append(b);
			if (id) row.append(agentIdEl(id));
			li.append(row);
			if (expanded) li.append(frontierItems(items));
			ul.append(li);
		}
		this.placeFloat();
	}
	/** The float box on the bar's side of the screen, inside the viewport and its safe areas (anchor.ts). */
	placeFloat() {
		const fb = this.els.floatbox;
		if (!fb) return;
		const show = !this.open && this.panel !== "menu" && (this.floats.size > 0 || this.els.frontier.childElementCount > 0 || this.panel === "tree");
		fb.hidden = !show;
		if (!show) return;
		const bar = this.els.bar.getBoundingClientRect();
		const row = this.els.rowbox.getBoundingClientRect();
		const ins = safeInsets();
		const p = placeBox({
			barLeft: bar.left,
			barRight: bar.right,
			boxWidth: fb.getBoundingClientRect().width,
			vw: document.documentElement.clientWidth || innerWidth,
			insetLeft: ins.left,
			insetRight: ins.right
		});
		const next = {
			side: p.side,
			left: p.left - row.left
		};
		if (next.side === this.place.side && next.left === this.place.left && fb.dataset.side) return;
		this.place = next;
		fb.dataset.side = next.side;
		fb.style.left = `${next.left}px`;
	}
	renderInput() {
		if (!this.root) return;
		const warn = this.els.warn;
		warn.hidden = !this._warning || !this.open;
		warn.textContent = this._warning;
		const notice = this.els.notice;
		notice.hidden = !this._notice;
		notice.textContent = this._notice;
		this.els.input.hidden = !!this._notice;
		this.renderStatus();
	}
	renderMenu() {
		if (!this.root) return;
		const menu = this.els.menu;
		menu.hidden = this.panel !== "menu";
		if (menu.hidden) return;
		menu.replaceChildren();
		const status = document.createElement("span");
		status.className = "status";
		status.setAttribute("aria-live", "polite");
		status.textContent = this.status();
		const speak = document.createElement("button");
		speak.type = "button";
		speak.setAttribute("role", "menuitemcheckbox");
		const on = this.speaking || this._micActive;
		speak.setAttribute("aria-checked", String(on));
		speak.innerHTML = ICONS.speaker;
		speak.append(this._micActive ? "Replies read aloud (mic on)" : on ? "Replies read aloud" : "Replies silent");
		speak.addEventListener("click", () => {
			if (this._micActive) return;
			const v = !this.speaking;
			this.write("speak", v ? "1" : "0");
			if (!v) this.stopSpeech("off");
			this.renderMenu();
		});
		const rate = document.createElement("div");
		rate.className = "rate";
		rate.setAttribute("role", "radiogroup");
		rate.setAttribute("aria-label", "Reading speed");
		const lab = document.createElement("span");
		lab.textContent = "Speed";
		rate.append(lab);
		const cur = this.speechRate;
		for (const r of SPEECH_RATES) {
			const b = document.createElement("button");
			b.type = "button";
			b.setAttribute("role", "radio");
			b.setAttribute("aria-checked", String(r === cur));
			b.dataset.rate = String(r);
			b.textContent = `${r}×`;
			b.addEventListener("click", () => {
				setSpeechRate(r, this.rateStore);
				this.renderMenu();
			});
			rate.append(b);
		}
		menu.append(status, speak, rate);
		if (this._treeSource) {
			const tree = document.createElement("button");
			tree.type = "button";
			tree.setAttribute("role", "menuitem");
			tree.textContent = `☰  ${this.treeText.tree}`;
			tree.addEventListener("click", () => this.setPanel("tree"));
			menu.append(tree);
		}
		const min = document.createElement("button");
		min.type = "button";
		min.setAttribute("role", "menuitem");
		min.textContent = this.open ? "–  Minimize" : "+  Restore";
		min.addEventListener("click", () => {
			this.setPanel("none");
			this.setOpen(!this.open);
		});
		menu.append(min);
		for (const x of this._sessions) {
			const row = document.createElement("div");
			row.className = "sess";
			const label = document.createElement("span");
			const where = x.pages === void 0 || x.pages === "all" ? "all pages" : `${x.pages.length} page${x.pages.length === 1 ? "" : "s"}`;
			label.textContent = `${x.scope === "chat" ? "chat" : this._friend ? "preview" : "eval"}: ${x.label} · ${x.code} · ${where}`;
			const end = document.createElement("button");
			end.type = "button";
			end.textContent = "End";
			end.addEventListener("click", () => {
				this.setPanel("none");
				this.onEnd?.(x);
			});
			row.append(label, end);
			menu.append(row);
		}
		if (this._pages.length < 2) return;
		const head = document.createElement("span");
		head.className = "head";
		head.textContent = "Your open pages";
		menu.append(head);
		for (const pg of this._pages) {
			const row = document.createElement("div");
			row.className = "pg";
			const label = document.createElement("span");
			const mine = pg.id === this._self;
			label.textContent = `${pageHint(pg.label)}${mine ? " (this page)" : ""}`;
			label.title = pg.label;
			const end = document.createElement("button");
			end.type = "button";
			end.textContent = mine && this.confirmEnd === pg.id ? "End this page?" : "End";
			end.addEventListener("click", () => {
				if (mine && this.confirmEnd !== pg.id) {
					this.confirmEnd = pg.id;
					return this.renderMenu();
				}
				this.confirmEnd = "";
				this.onEndPage?.(pg.id);
			});
			row.append(label, end);
			menu.append(row);
		}
	}
};
/** The same avatar value: one reference, or lists with the same URLs. */
function same(a, b) {
	if (a === b) return true;
	return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
}
/** An assignee's avatar in the frontier, 16px: their initial on their oklch colour. */
function assigneeAvatar(a) {
	const el = document.createElement("span");
	el.className = "fav";
	el.setAttribute("role", "img");
	el.setAttribute("aria-label", `${a.type === "agent" ? "Agent" : "Person"}: ${a.name}`);
	el.title = a.name;
	const { bg, fg } = avatarColors(`${a.type}:${a.name}`);
	el.style.background = bg;
	el.style.color = fg;
	el.textContent = initialOf(a.name);
	return el;
}
/**
* An agent's id at the line's far right: its last characters, monospace and
* muted. The full id is in the title and label, and a long press on a touch
* screen shows it in a small popover for 2 s.
*/
function agentIdEl(id) {
	const el = document.createElement("span");
	el.className = "id";
	el.title = `agent id: ${id}`;
	el.setAttribute("aria-label", `agent id ${id}`);
	el.textContent = shortId(id);
	let hide;
	const full = document.createElement("span");
	full.className = "full";
	full.setAttribute("role", "tooltip");
	full.textContent = id;
	const press = createLongPress({
		ms: LONG_PRESS_MS,
		onLong: () => {
			clearTimeout(hide);
			el.append(full);
		}
	});
	el.addEventListener("pointerdown", (e) => e.pointerType !== "mouse" && press.down());
	el.addEventListener("pointerup", () => {
		if (press.up()) hide = setTimeout(() => full.remove(), 2e3);
	});
	el.addEventListener("pointerleave", () => press.cancel());
	el.addEventListener("pointercancel", () => press.cancel());
	el.addEventListener("contextmenu", (e) => e.preventDefault());
	return el;
}
/** A frontier group's items: title and breadcrumb, scrolling past about six. */
function frontierItems(items) {
	const ul = document.createElement("ul");
	ul.className = "items";
	for (const it of items) {
		const li = document.createElement("li");
		if (it.assignee) li.append(assigneeAvatar(it.assignee));
		const t = document.createElement("span");
		t.className = "t";
		t.textContent = it.title;
		if (it.path) {
			const p = document.createElement("span");
			p.className = "p";
			p.textContent = it.path;
			t.append(p);
		}
		li.append(t);
		ul.append(li);
	}
	return ul;
}
/**
* One avatar: each picture in turn (no referrer, which Google's need; lazy),
* then the element, then the initial on an oklch circle. Labelled with the
* name (alt / aria-label) and titled with it, and aria-hidden: the line's
* screen-reader text already says who.
*/
function avatarEl(srcs, node, name, letter, seed, failed = 0) {
	let el;
	if (failed < srcs.length) {
		const img = document.createElement("img");
		img.alt = name;
		img.referrerPolicy = "no-referrer";
		img.loading = "lazy";
		img.decoding = "async";
		img.draggable = false;
		img.addEventListener("error", () => img.replaceWith(avatarEl(srcs, node, name, letter, seed, failed + 1)), { once: true });
		img.src = srcs[failed];
		el = img;
	} else {
		el = document.createElement("span");
		el.setAttribute("role", "img");
		el.setAttribute("aria-label", name);
		if (node) el.append(node.cloneNode(true));
		else {
			const { bg, fg } = avatarColors(seed);
			el.style.background = bg;
			el.style.color = fg;
			el.textContent = letter;
		}
	}
	el.className = "av";
	el.title = name;
	el.setAttribute("aria-hidden", "true");
	return el;
}
function defineChatBox(tag = "liagent-chat") {
	if (typeof customElements !== "undefined" && !customElements.get(tag)) customElements.define(tag, ChatBox);
	return ChatBox;
}

//#endregion
export { avatarColors as a, initialOf as c, when as i, lineAvatar as l, defineChatBox as n, avatarSrcs as o, pageHint as r, hashId as s, ChatBox as t, DEBOUNCE_MS as u };
//# sourceMappingURL=box-C0bNKkkl.js.map