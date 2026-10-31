import { i as crumbs } from "./state-tree-BZCmAknI.js";

//#region src/detent.ts
/** The thing's position for a finger travel: the snapping staircase, then the rubber band. */
function snapDetent(finger, o) {
	const max = finger >= 0 ? o.max : -(o.min ?? -o.max);
	const f = Math.abs(finger);
	const top = max * o.cell;
	const x = f <= top ? o.unit * (f / o.cell - o.snap * Math.sin(2 * Math.PI * f / o.cell) / (2 * Math.PI)) : Math.min(o.stop, max * o.unit + (f - top) * o.stretch);
	return Math.sign(finger) * x;
}
/**
* The level after `t` cells of travel, from level `from`, with hysteresis
* both ways: it moves on only `hysteresis` past a midpoint, so a finger
* resting on a boundary never flickers.
*/
function detentLevel(t, from, o) {
	let k = from;
	while (k < o.max && t > k + .5 + o.hysteresis) k++;
	while (k > o.min && t < k - .5 - o.hysteresis) k--;
	return k;
}

//#endregion
//#region src/tree-nav.ts
/**
* Navigating a tree by detents: a pure reducer, `treeNav(state, event)`.
* Generic: any tree (the chat box's tree view uses it).
*
* The view: at each level the collapsed siblings sit in a row of chips; one
* node is expanded at a time along one branch (an accordion), its subtree
* shown `expanded[id]` levels deep. A focused node takes the gestures.
*
* - Dragging right by k cells expands the focused node one level per cell,
*   up to `maxDetent` (min(3, its subtree's height)); a leaf can't expand.
* - Dragging left collapses one level per cell: first the focused node's own
*   depth, deepest level first; past its own level the focus moves to its
*   parent, whose depth then drops by one; at a top-level chip with nothing
*   expanded there is nothing left to collapse.
* - At either limit the reducer stops: no wrap-around, the SAME state object
*   back (or once, the state with `atLimit` set), so the view can rubber-band.
* - A drag previews (`preview`) and commits only on `dragEnd`.
*
* It is not a counter: the result depends on the path (the focus moves, and
* each node has its own depth), so "expand 2 then collapse 1" and "collapse 1
* then expand 2" can differ.
*/
/** Build a NavIndex from any tree. */
function indexTree(roots, childrenOf, idOf) {
	const ix = {
		roots: [],
		parent: /* @__PURE__ */ new Map(),
		children: /* @__PURE__ */ new Map()
	};
	const go = (n, parent, i) => {
		const id = idOf(n, parent, i);
		ix.parent.set(id, parent);
		ix.children.set(id, childrenOf(n).map((c, j) => go(c, id, j)));
		return id;
	};
	ix.roots = roots.map((r, i) => go(r, null, i));
	return ix;
}
/** Levels below a node: 0 for a leaf. */
function height(ix, id) {
	const kids = ix.children.get(id) ?? [];
	return kids.length ? 1 + Math.max(...kids.map((k) => height(ix, k))) : 0;
}
/** How deep a node can open: min(3, its subtree's height); 0 for a leaf. */
const MAX_DETENT = 3;
function maxDetent(ix, id) {
	return Math.min(MAX_DETENT, height(ix, id));
}
const initialNav = (ix) => ({
	focusId: ix.roots[0] ?? null,
	expanded: {},
	detent: 0
});
/** The ancestors of a node, nearest first. */
function ancestors(ix, id) {
	const out = [];
	for (let p = ix.parent.get(id) ?? null; p !== null; p = ix.parent.get(p) ?? null) out.push(p);
	return out;
}
const topOf = (ix, id) => ancestors(ix, id).at(-1) ?? id;
/** Is a node on screen: a top-level chip, or within an expanded ancestor's depth. */
function isVisible(ix, s, id) {
	const up = ancestors(ix, id);
	if (!up.length) return true;
	if (!isVisible(ix, s, up[0])) return false;
	return up.some((a, i) => (s.expanded[a] ?? 0) >= i + 1);
}
/** Drop depths of nodes no longer on screen, and anything outside `top`'s branch. */
function prune(ix, e, top) {
	const out = {};
	for (const [id, d] of Object.entries(e)) if (d > 0 && (top === null || topOf(ix, id) === top)) out[id] = d;
	for (let changed = true; changed;) {
		changed = false;
		for (const id of Object.keys(out)) if (!isVisible(ix, { expanded: out }, id)) {
			delete out[id];
			changed = true;
		}
	}
	return out;
}
function expandStep(ix, s) {
	const f = s.focusId;
	if (f === null) return {
		s,
		limit: "max"
	};
	const d = s.expanded[f] ?? 0;
	if (d >= maxDetent(ix, f)) return {
		s,
		limit: "max"
	};
	const e = prune(ix, {
		...s.expanded,
		[f]: d + 1
	}, topOf(ix, f));
	return { s: {
		...s,
		expanded: e
	} };
}
function collapseStep(ix, s) {
	const f = s.focusId;
	if (f === null) return {
		s,
		limit: "min"
	};
	const d = s.expanded[f] ?? 0;
	if (d > 0) {
		const e = {
			...s.expanded,
			[f]: d - 1
		};
		return { s: {
			...s,
			expanded: prune(ix, e, topOf(ix, f))
		} };
	}
	const p = ix.parent.get(f) ?? null;
	if (p === null) return {
		s,
		limit: "min"
	};
	const pd = s.expanded[p] ?? 1;
	const e = {
		...s.expanded,
		[p]: Math.max(0, pd - 1)
	};
	return { s: {
		...s,
		focusId: p,
		expanded: prune(ix, e, topOf(ix, p))
	} };
}
/** `n` steps (signed) from `s`, stopping at a limit. */
function steps(ix, s, n) {
	let cur = { s };
	for (let i = 0; i < Math.abs(n); i++) {
		const next = n > 0 ? expandStep(ix, cur.s) : collapseStep(ix, cur.s);
		if (next.limit) return {
			s: cur.s,
			limit: next.limit
		};
		cur = next;
	}
	return cur;
}
/** The same object when nothing changes; else the new one. */
function settle(prev, next, limit) {
	const out = limit ? {
		...next,
		atLimit: limit
	} : next.atLimit ? {
		...next,
		atLimit: void 0
	} : next;
	if (out.focusId === prev.focusId && out.detent === prev.detent && out.atLimit === prev.atLimit && out.base === prev.base && sameDepths(out.expanded, prev.expanded)) return prev;
	return out;
}
const sameDepths = (a, b) => {
	const ka = Object.keys(a);
	return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};
/** Siblings of a node, in order. */
const siblings = (ix, id) => {
	const p = ix.parent.get(id) ?? null;
	return p === null ? ix.roots : ix.children.get(p) ?? [];
};
function treeNav(ix, s, ev) {
	switch (ev.type) {
		case "dragStart": return {
			...s,
			base: s.base ?? {
				...s,
				base: void 0
			},
			detent: 0,
			atLimit: void 0
		};
		case "dragMove": {
			const base = s.base ?? s;
			const r = steps(ix, base, ev.cells);
			return settle(s, {
				...r.s,
				base,
				detent: ev.cells
			}, r.limit);
		}
		case "dragEnd":
			if (!s.base) return s;
			return {
				...s,
				base: void 0,
				detent: 0,
				atLimit: void 0
			};
		case "dragCancel": return s.base ? {
			...s.base,
			base: void 0,
			detent: 0,
			atLimit: void 0
		} : s;
		case "tapChip": {
			if (!ix.parent.has(ev.id)) return s;
			const top = topOf(ix, ev.id);
			const d = s.expanded[ev.id] ?? 0;
			const want = d === 0 && maxDetent(ix, ev.id) > 0 ? 1 : d;
			const e = prune(ix, {
				...s.expanded,
				[ev.id]: want
			}, top);
			return settle(s, {
				...s,
				focusId: ev.id,
				expanded: e,
				base: void 0,
				detent: 0
			});
		}
		case "collapseAll": return settle(s, {
			focusId: s.focusId === null ? null : topOf(ix, s.focusId),
			expanded: {},
			detent: 0
		});
		case "key": {
			const f = s.focusId;
			if (f === null) return s;
			const sib = siblings(ix, f);
			const i = sib.indexOf(f);
			const step = (n) => {
				const r = steps(ix, s, n);
				return settle(s, r.s, r.limit);
			};
			switch (ev.key) {
				case "ArrowRight": return i < sib.length - 1 ? settle(s, {
					...s,
					focusId: sib[i + 1]
				}) : step(1);
				case "ArrowLeft": return i > 0 ? settle(s, {
					...s,
					focusId: sib[i - 1]
				}) : step(-1);
				case "Enter": return step(1);
				case "Escape": return step(-1);
				case "ArrowDown": {
					const kid = (ix.children.get(f) ?? [])[0];
					return kid && (s.expanded[f] ?? 0) > 0 ? settle(s, {
						...s,
						focusId: kid
					}) : s;
				}
				case "ArrowUp": {
					const p = ix.parent.get(f) ?? null;
					return p === null ? s : settle(s, {
						...s,
						focusId: p
					});
				}
				default: return s;
			}
		}
	}
}
/** One detent of the tree button's drag: about the button's width. */
const TREE_DETENT_PX = 40;
/** How many cells a single drag can reach each way. */
const TREE_DRAG_CELLS = 6;
/** The tree drag's feel: the card swipe's snap and hysteresis (detent.ts). */
const TREE_HYSTERESIS = .1;
const TREE_SNAP = .6;
const TREE_STRETCH = .3;
/** Cells of a horizontal drag `dx`, from the cells it was at (hysteresis). */
function dragCells(dx, from) {
	return detentLevel(dx / TREE_DETENT_PX, from, {
		min: -TREE_DRAG_CELLS,
		max: TREE_DRAG_CELLS,
		hysteresis: TREE_HYSTERESIS
	});
}
/**
* Where the tree button's preview sits for a drag `dx`: snapping to the
* detents, and past a limit only rubber-banding (STRETCH of the travel
* beyond `limitCells`), released back to the detent.
*/
function dragOffset(dx, limitCells) {
	const feel = {
		cell: TREE_DETENT_PX,
		unit: TREE_DETENT_PX,
		max: TREE_DRAG_CELLS,
		snap: TREE_SNAP,
		stretch: TREE_STRETCH,
		stop: TREE_DRAG_CELLS * TREE_DETENT_PX
	};
	if (limitCells === void 0) return snapDetent(dx, feel);
	const edge = limitCells * TREE_DETENT_PX;
	const past = dx - edge;
	if (Math.sign(past) !== Math.sign(limitCells || dx) || past === 0) return snapDetent(dx, feel);
	return snapDetent(edge, feel) + past * TREE_STRETCH;
}

//#endregion
//#region src/float-lines.ts
/**
* The minimized chat's floating lines: a message that arrives while the chat is
* minimized floats above the bar for as long as it takes to read it twice,
* then fades. Hovering or touching the lines pauses their timers.
*/
/** Characters per second read in CJK scripts (Han, kana, Hangul). */
const READ_RATE_CJK = 6;
/** Characters per second for everything else (~180 words per minute). */
const READ_RATE_LATIN = 15;
/** A line stays up for this many reading times... */
const DWELL_FACTOR = 2;
/** ...and never less than this. */
const DWELL_MIN_MS = 2500;
/** The slow fade-out once the dwell is over (gone at once under reduced motion). */
const FADE_MS = 1e4;
/** At most this many lines float at once; the oldest goes first. */
const FLOAT_MAX = 6;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** Seconds to read `text` once: CJK characters at 6/s, the rest at 15/s. */
function readTime(text) {
	let cjk = 0;
	let other = 0;
	for (const ch of text.trim()) if (CJK.test(ch)) cjk++;
	else other++;
	return cjk / READ_RATE_CJK + other / READ_RATE_LATIN;
}
/** How long a floating line stays before it fades, in ms. */
function dwellMs(text) {
	return Math.max(DWELL_MIN_MS, Math.round(readTime(text) * 1e3 * DWELL_FACTOR));
}
/**
* One line's countdown: a single setTimeout, stopped by `pause` and restarted
* by `resume` with the time that was left. Clock and timers are injected for
* tests.
*/
function createDwellTimer(d) {
	const now = d.now ?? (() => Date.now());
	const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
	const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t));
	let left = d.ms;
	let started = now();
	let timer = null;
	let done = false;
	const start = () => {
		started = now();
		timer = setTimer(() => {
			timer = null;
			done = true;
			d.onDone();
		}, left);
	};
	start();
	return {
		pause() {
			if (timer === null || done) return;
			clearTimer(timer);
			timer = null;
			left = Math.max(0, left - (now() - started));
		},
		resume() {
			if (timer !== null || done) return;
			start();
		},
		cancel() {
			if (timer !== null) clearTimer(timer);
			timer = null;
			done = true;
		},
		remaining: () => timer === null ? left : Math.max(0, left - (now() - started))
	};
}
/** The latest message floats on minimize only if it arrived at most this long ago. */
const MINIMIZE_FLOAT_MAX_AGE_MS = 10 * 6e4;
/**
* When this widget first saw each message, by id — this device's clock, never
* the message's own `at` (another clock, which may be skewed). New messages
* are told by id, not by the list's length: the host caps its history, so
* once full the list stays the same length as new lines push old ones out.
*/
function createArrivals() {
	const seen = /* @__PURE__ */ new Map();
	/** Arrival order, by id: 1, 2, 3… (never a clock, so never a tie). */
	const order = /* @__PURE__ */ new Map();
	let count = 0;
	let loaded = false;
	return {
		see(messages, now) {
			const fresh = messages.filter((m) => !seen.has(m.id));
			for (const m of fresh) {
				seen.set(m.id, now);
				order.set(m.id, ++count);
			}
			const history = !loaded;
			if (messages.length) loaded = true;
			if (seen.size > 2 * messages.length + 100) {
				const ids = new Set(messages.map((m) => m.id));
				for (const id of seen.keys()) if (!ids.has(id)) {
					seen.delete(id);
					order.delete(id);
				}
			}
			return {
				fresh,
				history
			};
		},
		at: (id) => seen.get(id),
		seqOf: (id) => order.get(id),
		seq: () => count
	};
}
/**
* The minimized bar's unread badge: the agent's messages that arrived after
* `readSeq` (the arrival order when the chat was last open, or the history
* loaded). By arrival, not by list position: a capped list keeps its length.
*/
function countUnread(messages, seqOf, readSeq) {
	return messages.filter((m) => m.from === "agent" && (seqOf(m.id) ?? 0) > readSeq).length;
}
/**
* At the moment the chat is minimized, the latest message (from anyone) is
* treated as unread and floats, unless it arrived here more than
* MINIMIZE_FLOAT_MAX_AGE_MS ago. Its dwell starts then, not when it arrived.
*/
function minimizeFloat(messages, now, arrivedAt) {
	const last = messages.at(-1);
	if (!last) return null;
	const at = arrivedAt(last.id);
	return at !== void 0 && now - at <= MINIMIZE_FLOAT_MAX_AGE_MS ? last : null;
}
function createFloatLife(d) {
	const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
	const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t));
	let phase = "dwell";
	let paused = false;
	let fade = null;
	const set = (p) => {
		phase = p;
		d.onPhase(p);
	};
	const startFade = () => {
		set("fade");
		fade = setTimer(() => {
			fade = null;
			set("gone");
		}, d.fadeMs ?? FADE_MS);
	};
	const dwell = createDwellTimer({
		ms: d.ms,
		onDone: () => d.reducedMotion ? set("gone") : startFade(),
		now: d.now,
		setTimer,
		clearTimer
	});
	const life = {
		pause() {
			if (paused) return;
			paused = true;
			if (phase === "dwell") dwell.pause();
			else if (phase === "fade") {
				clearTimer(fade);
				fade = null;
				set("held");
			}
		},
		resume() {
			if (!paused) return;
			paused = false;
			if (phase === "dwell") dwell.resume();
			else if (phase === "held") startFade();
		},
		cancel() {
			dwell.cancel();
			if (fade !== null) clearTimer(fade);
			fade = null;
		},
		phase: () => phase
	};
	if (d.paused) life.pause();
	return life;
}

//#endregion
//#region src/anchor.ts
const ANCHOR_GUTTER_PX = 8;
/** The bar's side of the screen, by its centre: thirds. */
function anchorSide(barLeft, barRight, vw) {
	const mid = (barLeft + barRight) / 2;
	return mid < vw / 3 ? "left" : mid > 2 * vw / 3 ? "right" : "center";
}
/** The box's left edge (viewport px) for its width, anchored to the bar and clamped. */
function placeBox(d) {
	const g = d.gutter ?? ANCHOR_GUTTER_PX;
	const side = anchorSide(d.barLeft, d.barRight, d.vw);
	const want = side === "left" ? d.barLeft : side === "right" ? d.barRight - d.boxWidth : (d.barLeft + d.barRight) / 2 - d.boxWidth / 2;
	const min = (d.insetLeft ?? 0) + g;
	const max = d.vw - (d.insetRight ?? 0) - g - d.boxWidth;
	return {
		side,
		left: Math.round(max < min ? min : Math.min(max, Math.max(min, want)))
	};
}

//#endregion
//#region src/frontier-view.ts
/**
* The minimized chat's frontier lines: the last thing done, what is in
* progress, and what comes next. The data comes from src/state-tree.ts
* (`frontier`); this file has only the small display rules, so they can be
* tested without a DOM.
*/
const FRONTIER_ROWS = [
	{
		key: "done",
		mark: "✓",
		label: "Last done"
	},
	{
		key: "doing",
		mark: "▶",
		label: "In progress"
	},
	{
		key: "next",
		mark: "›",
		label: "Next"
	}
];
/** Visible characters of an agent id at the line's end. */
const SHORT_ID_LEN = 6;
/** Longer than this, an "id" is more likely a token than a slug: hidden. */
const MAX_ID_LEN = 64;
/** How long a touch must rest on the id to show the full one. */
const LONG_PRESS_MS = 500;
/**
* The agent id to show, or null. Only agents have one shown, and only an
* opaque slug: anything that looks like a host, a path, a pid:port or a
* token (a dot, colon or slash, or over 64 characters) is dropped.
*/
function shownAgentId(a) {
	if (!a || a.type !== "agent" || !a.id) return null;
	const id = a.id.trim();
	if (!id || id.length > MAX_ID_LEN || /[.:/\\]/.test(id)) return null;
	return id;
}
/** The last SHORT_ID_LEN characters, for the line's end. */
const shortId = (id) => id.slice(-SHORT_ID_LEN);
/** The `〔N〕` after a group's summary; nothing for a single item. */
const countBadge = (n) => n && n > 1 ? `〔${n}〕` : "";
/**
* The bar's lines from state-tree.ts frontier(): a group as its summary (or,
* without one, its first item's title) and count, its items with breadcrumbs;
* one item as its title. Undefined when there is nothing to show.
*/
function frontierView(f) {
	const line = (e) => e && {
		text: e.count > 1 && e.summary ? e.summary : e.title,
		count: e.count,
		...e.assignee ? { assignee: e.assignee } : {},
		...e.count > 1 ? { items: e.items.map((it) => ({
			title: it.title,
			path: crumbs(it.path),
			...it.assignee ? { assignee: it.assignee } : {}
		})) } : {}
	};
	const out = {};
	const done = line(f.done);
	const doing = line(f.doing);
	const next = line(f.next);
	if (done) out.done = done;
	if (doing) out.doing = doing;
	if (next) out.next = next;
	return done || doing || next ? out : void 0;
}

//#endregion
//#region src/tap-gesture.ts
/**
* One tap or two (the chat box's grip): a single tap acts only once
* `delayMs` pass without a second; a second tap inside that window cancels it
* and acts as a double tap. Timers are injected for tests.
*/
const DOUBLE_TAP_MS = 280;
function createTapper(d) {
	const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
	const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t));
	let waiting = null;
	return {
		tap() {
			if (waiting !== null) {
				clearTimer(waiting);
				waiting = null;
				return d.onDouble();
			}
			waiting = setTimer(() => {
				waiting = null;
				d.onSingle();
			}, d.delayMs ?? DOUBLE_TAP_MS);
		},
		cancel() {
			if (waiting !== null) clearTimer(waiting);
			waiting = null;
		}
	};
}
/** How long after a drag ends its click is still "the click that ended a drag". */
const DRAG_CLICK_MS = 400;
/**
* Tells the click that ends a drag from a real tap. The flag is cleared by
* the next pointerdown and expires after DRAG_CLICK_MS, so a browser that
* sends no click after a touch drag (iOS) never swallows the next tap.
*/
function createDragFlag(now = Date.now) {
	let endedAt = null;
	return {
		down() {
			endedAt = null;
		},
		dragEnded() {
			endedAt = now();
		},
		wasDrag() {
			const d = endedAt !== null && now() - endedAt < DRAG_CLICK_MS;
			endedAt = null;
			return d;
		}
	};
}
/** A press must move this far before it counts as a drag, and its axis is locked. */
const AXIS_LOCK_PX = 8;
/**
* One press on the mic, told apart by its first AXIS_LOCK_PX of movement:
* under that it stays a tap (the mic toggles); then it locks to an axis for
* the rest of the press — "y" scrubs the chat history, "x" moves the bar.
* `up` says whether the click that follows must be swallowed (any lock).
*/
function createAxisLock(lockPx = AXIS_LOCK_PX) {
	let start = null;
	let axis = null;
	return {
		down(x, y) {
			start = {
				x,
				y
			};
			axis = null;
		},
		move(x, y) {
			if (!start) return null;
			const dx = x - start.x;
			const dy = y - start.y;
			if (!axis) {
				if (Math.hypot(dx, dy) < lockPx) return null;
				axis = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
			}
			return {
				axis,
				dx,
				dy
			};
		},
		up() {
			const a = axis;
			start = null;
			axis = null;
			return a;
		},
		axis: () => axis
	};
}
/** Pixels of vertical drag per message line scrubbed. */
const SCRUB_STEP_PX = 28;
/**
* Where a scrub lands: `back` lines from the newest, from where it started and
* the finger's vertical travel. Finger down = older (as the expanded log's
* swipe: the content follows the finger), clamped to [0, max].
*/
function scrubBack(startBack, dy, max, step = SCRUB_STEP_PX) {
	return Math.max(0, Math.min(max, startBack + Math.trunc(dy / step)));
}
/**
* A press held for `ms` (500 by default) without moving off: `onLong` fires
* once. `down` starts it; `up` or `cancel` (the press ended or moved away)
* stops it. Timers are injected for tests.
*/
function createLongPress(d) {
	const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
	const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t));
	let t = null;
	let fired = false;
	const stop = () => {
		if (t !== null) clearTimer(t);
		t = null;
	};
	return {
		down() {
			stop();
			fired = false;
			t = setTimer(() => {
				t = null;
				fired = true;
				d.onLong();
			}, d.ms ?? 500);
		},
		up() {
			stop();
			return fired;
		},
		cancel: stop
	};
}

//#endregion
//#region src/scroll-handoff.ts
/** A finger moving less than this is still a tap (the caret goes where it lands). */
const SWIPE_SLOP_PX = 6;
/** One wheel "line" (deltaMode 1, as Firefox reports a mouse wheel), in pixels. */
const WHEEL_LINE_PX = 16;
/** Less than this left to scroll counts as none (fractional scrollTop on zoomed pages). */
const EPS = 1;
/** How far `el` can scroll down (positive) and up (negative) from where it is. */
function scrollRoom(el) {
	const max = Math.max(0, el.scrollHeight - el.clientHeight);
	const top = Math.min(max, Math.max(0, el.scrollTop));
	const down = max - top;
	return {
		up: top < EPS ? 0 : top,
		down: down < EPS ? 0 : down
	};
}
/**
* Split one scroll delta between the input and the log: the input takes what
* it has room for in that direction, and the log the rest.
*/
function splitScroll(input, delta) {
	if (!Number.isFinite(delta) || delta === 0) return {
		inputDelta: 0,
		logDelta: 0
	};
	const room = scrollRoom(input);
	const inputDelta = (delta > 0 ? Math.min(delta, room.down) : Math.max(delta, -room.up)) + 0;
	return {
		inputDelta,
		logDelta: delta - inputDelta + 0
	};
}
/** A wheel event's vertical delta in pixels (deltaMode 0 pixels, 1 lines, 2 pages). */
function wheelPixels(deltaY, deltaMode, pagePx) {
	if (deltaMode === 1) return deltaY * WHEEL_LINE_PX;
	if (deltaMode === 2) return deltaY * pagePx;
	return deltaY;
}
/**
* One touch gesture over the input, move by move. Until the finger leaves
* SWIPE_SLOP_PX it is a tap and nothing scrolls. Then each move is split:
* while the input scrolls natively the box leaves it alone (no
* preventDefault) and adds only the log's share; once a move had to be
* cancelled (nothing for the input), the box drives both for the rest of the
* gesture, since the browser no longer scrolls the input by itself then.
*/
function createSwipeHandoff() {
	let y = 0;
	let swiping = false;
	let owned = false;
	return {
		start(clientY) {
			y = clientY;
			swiping = false;
			owned = false;
		},
		move(input, clientY, cancelable) {
			if (!swiping && Math.abs(clientY - y) < SWIPE_SLOP_PX) return null;
			swiping = true;
			const delta = y - clientY;
			y = clientY;
			const { inputDelta, logDelta } = splitScroll(input, delta);
			if (!owned && inputDelta === 0 && cancelable) owned = true;
			if (owned) return {
				inputDelta,
				logDelta,
				prevent: cancelable
			};
			return {
				inputDelta: 0,
				logDelta,
				prevent: false
			};
		}
	};
}

//#endregion
//#region src/ui-strings.ts
const UI_EN = {
	stateTree: "State tree",
	closeTree: "Close the state tree",
	noTreeSource: "No tree source",
	lastDone: "Last done",
	nowDoing: "In progress",
	upNext: "Next",
	needsYou: "needs you",
	items: "items",
	polished: "Polished"
};
const UI_ZH = {
	stateTree: "状态树",
	closeTree: "关闭状态树",
	noTreeSource: "没有状态树来源",
	lastDone: "最近完成",
	nowDoing: "进行中",
	upNext: "下一步",
	needsYou: "等你处理",
	items: "项",
	polished: "已润色"
};
/** The tree's strings in Chinese (tree.ts TreeStrings). */
const TREE_ZH = {
	tree: "状态树",
	back: "返回聊天",
	needsMe: "待我处理",
	needsYou: "等你处理",
	openCount: "{n} 项未完成",
	needsYouCount: "{n} 项等你",
	copy: "复制",
	copied: "已复制",
	loading: "加载中…",
	failed: "无法加载状态树",
	empty: "状态树是空的。",
	nothingNeedsYou: "没有等你处理的事。",
	you: "你",
	lastDone: "最近完成",
	nowDoing: "进行中",
	upNext: "下一步",
	live: "实时数据"
};
/** The page's language is Chinese. */
function isZh(lang = globalThis.document?.documentElement.lang) {
	return /^zh\b/i.test(lang ?? "");
}
/** The box's strings for the page's language. */
const uiStrings = (lang) => isZh(lang) ? UI_ZH : UI_EN;
/** The tree's defaults for the page's language, under the host's own. */
const treeDefaults = (lang) => isZh(lang) ? TREE_ZH : {};

//#endregion
export { dragCells as $, ANCHOR_GUTTER_PX as A, countUnread as B, LONG_PRESS_MS as C, frontierView as D, countBadge as E, FADE_MS as F, minimizeFloat as G, createDwellTimer as H, FLOAT_MAX as I, TREE_DETENT_PX as J, readTime as K, MINIMIZE_FLOAT_MAX_AGE_MS as L, placeBox as M, DWELL_FACTOR as N, shortId as O, DWELL_MIN_MS as P, TREE_STRETCH as Q, READ_RATE_CJK as R, FRONTIER_ROWS as S, SHORT_ID_LEN as T, createFloatLife as U, createArrivals as V, dwellMs as W, TREE_HYSTERESIS as X, TREE_DRAG_CELLS as Y, TREE_SNAP as Z, createAxisLock as _, treeDefaults as a, maxDetent as at, createTapper as b, WHEEL_LINE_PX as c, snapDetent as ct, splitScroll as d, dragOffset as et, wheelPixels as f, SCRUB_STEP_PX as g, DRAG_CLICK_MS as h, isZh as i, isVisible as it, anchorSide as j, shownAgentId as k, createSwipeHandoff as l, DOUBLE_TAP_MS as m, UI_EN as n, indexTree as nt, uiStrings as o, treeNav as ot, AXIS_LOCK_PX as p, MAX_DETENT as q, UI_ZH as r, initialNav as rt, SWIPE_SLOP_PX as s, detentLevel as st, TREE_ZH as t, height as tt, scrollRoom as u, createDragFlag as v, MAX_ID_LEN as w, scrubBack as x, createLongPress as y, READ_RATE_LATIN as z };
//# sourceMappingURL=ui-strings-CBDcKqFQ.js.map