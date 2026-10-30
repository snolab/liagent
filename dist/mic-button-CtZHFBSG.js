import { B as scheduleTick, D as createMic, E as appendDictation, F as micStatus, I as postStt, P as micErrorNote, a as canCapture, d as sileroVad, f as vadFromScripts, g as MIC_ERROR_STRINGS_EN, i as audioCtx, l as micStream, o as energyVad, s as existingCtx } from "./mic-audio-C3Shud_F.js";

//#region src/mic-session.ts
/**
* The mic as one page-wide session, outside any element: the stream, the VAD
* (createMic, src/mic.ts), the transcripts on their way, and the hooks of a
* voice output (MicVoiceLink). It lives on globalThis (MIC_SESSION_KEY), so
* a remounted `<liagent-mic>`, a framework re-render, a client-side route
* change or a second copy of the module finds it still listening and
* re-attaches; disconnecting never stops it — only an explicit "mic off"
* does. One getUserMedia per capture: a live stream is reused.
*
* On a real reload the session is new. If this tab had the mic on
* (sessionStorage MIC_ON_KEY, per tab, surviving a refresh), it tries to
* resume at once: with the microphone permission granted (or the query not
* supported, as on iOS) and the AudioContext running, it turns capture back
* on without a gesture ({path: "auto", ok: true}). Otherwise the button
* waits in a "tap to resume" state ({path: "tap", reason}). Either outcome
* goes to `onResume` and to the view's `resumed`.
*
* Everything that touches the browser is injected (MicDeps), so this is
* tested with fakes (test/mic-session.test.ts).
*/
/** globalThis key of the session. */
const MIC_SESSION_KEY = "__liagentMic";
/** Bumped when the session's shape changes; an older one is migrated, its stream kept. */
const MIC_SESSION_V = 1;
/** sessionStorage: "1" while this tab has the mic on (cleared by an explicit off). */
const MIC_ON_KEY = "liagent:mic";
const live = (s) => !!s && s.getTracks().length > 0 && s.getTracks().every((t) => t.readyState === "live");
function createMicSession(deps, from) {
	const key = deps.storageKey ?? MIC_ON_KEY;
	let stream = from?.stream ?? null;
	let view = {
		state: "off",
		pending: 0,
		interim: "",
		error: null,
		resume: false,
		speaking: false
	};
	let cfg;
	let voice = null;
	let unvoice = null;
	const listeners = /* @__PURE__ */ new Set();
	let sink = null;
	/** Transcripts that landed while nothing was attached (mid-remount): handed over on attach. */
	let held = [];
	let gumCalls = 0;
	const emit = (patch) => {
		view = {
			...view,
			...patch
		};
		for (const f of listeners) f(view);
	};
	const store = {
		on: () => {
			try {
				deps.storage?.set(key, "1");
			} catch {}
		},
		clear: () => {
			try {
				deps.storage?.remove(key);
			} catch {}
		},
		get: () => {
			try {
				return deps.storage?.get(key) === "1";
			} catch {
				return false;
			}
		}
	};
	/** The live stream, or a new one (the only getUserMedia). */
	const ensureStream = async () => {
		if (stream && live(stream)) return stream;
		gumCalls++;
		stream = await deps.getStream(cfg);
		return stream;
	};
	const stopStream = () => {
		for (const t of stream?.getTracks() ?? []) t.stop();
		stream = null;
	};
	const fallback = deps.fallback;
	let prev = "off";
	const mic = createMic({
		load: async (ev) => deps.load(ev, await ensureStream(), cfg),
		fallback: fallback ? async (ev) => fallback(ev, await ensureStream(), cfg) : void 0,
		upload: async (wav, info) => {
			const text = await deps.upload(wav, info, cfg);
			const echo = text && voice?.echoCheck ? voice.echoCheck(text, info.durationMs) : void 0;
			if (!info.partial) deps.onUtterance?.({
				...info,
				wav,
				text,
				echo
			}, cfg);
			if (echo?.drop) {
				if (!info.partial) voice?.echoDropped?.();
				return "";
			}
			return text;
		},
		onState: (s) => {
			const was = prev;
			prev = s;
			emit({
				state: s,
				...s !== "off" ? { resume: false } : {}
			});
			if (voice) {
				voice.setMic(s !== "off");
				if (s === "capturing") voice.userSpeech();
				else if (was === "capturing") voice.userIdle();
			}
			deps.onState?.(s, was);
		},
		onText: (t) => sink ? sink.onText(t) : void held.push(t),
		onPending: (n, interim) => {
			emit({
				pending: n,
				interim
			});
			sink?.onPending(n, interim);
		},
		onError: (e) => emit({ error: e }),
		onProb: (p) => voice?.userFrame?.(p)
	});
	const session = {
		v: MIC_SESSION_V,
		view: () => view,
		stream: () => stream,
		gumCalls: () => gumCalls,
		subscribe(f) {
			listeners.add(f);
			f(view);
			return () => void listeners.delete(f);
		},
		attach(s) {
			sink = s;
			const t = held;
			held = [];
			for (const x of t) s.onText(x);
			s.onPending(view.pending, view.interim);
			return () => {
				if (sink === s) sink = null;
			};
		},
		configure(c) {
			cfg = c;
		},
		config: () => cfg,
		setVoice(link) {
			if (link === voice) return;
			unvoice?.();
			unvoice = null;
			voice = link;
			if (!link) {
				mic.hold(false);
				emit({ speaking: false });
				return;
			}
			const follow = (s) => {
				mic.hold(s.hold);
				if (s.speaking !== view.speaking) emit({ speaking: s.speaking });
			};
			follow(link.state());
			unvoice = link.subscribe(follow);
			if (mic.state() !== "off") link.setMic(true);
		},
		voice: () => voice,
		async toggle() {
			emit({ error: null });
			if (mic.state() === "off") {
				store.on();
				await mic.toggle();
			} else await session.off();
		},
		async off() {
			store.clear();
			emit({ resume: false });
			await mic.off();
			stopStream();
		},
		hold: (on) => mic.hold(on),
		async retire() {
			unvoice?.();
			unvoice = null;
			voice = null;
			listeners.clear();
			sink = null;
			const s = stream;
			stream = null;
			await mic.off();
			return s;
		},
		async autoResume() {
			if (!store.get()) return;
			const done = (r) => {
				emit({
					resumed: r,
					...r.path === "tap" ? { resume: true } : {}
				});
				deps.onResume?.(r);
			};
			const tap = (reason) => done({
				path: "tap",
				reason
			});
			let perm = "unknown";
			try {
				perm = await deps.permission?.() ?? "unknown";
			} catch {}
			if (perm !== "granted" && perm !== "unknown") return tap(`permission ${perm}`);
			let audio = true;
			try {
				audio = await deps.resumeAudio?.() ?? true;
			} catch {
				audio = false;
			}
			if (!audio) return tap("audio context suspended");
			await mic.toggle();
			if (mic.state() === "off") {
				const e = view.error;
				return tap(e?.name || e?.message || "capture did not start");
			}
			done({
				path: "auto",
				ok: true,
				permission: perm
			});
		}
	};
	if (from?.on) mic.toggle();
	return session;
}
/**
* The page's mic session, made once: an element that connects later (a
* remount, another copy of the module) gets the same one. An older version
* is retired and its stream handed to the new session, which resumes
* listening if it was.
*/
function micSession(deps) {
	const g = globalThis;
	const have = g[MIC_SESSION_KEY];
	if (have && have.v === MIC_SESSION_V) return have;
	if (have) {
		const on = (have.view?.().state ?? "off") !== "off";
		const kept = have.stream?.() ?? null;
		have.retire?.();
		const next = createMicSession(deps, {
			stream: kept,
			on
		});
		g[MIC_SESSION_KEY] = next;
		return next;
	}
	const s = createMicSession(deps);
	g[MIC_SESSION_KEY] = s;
	queueMicrotask(() => void s.autoResume());
	return s;
}

//#endregion
//#region src/mic-button.ts
/** Is `x` something the mic can type into? */
const isDictationTarget = (x) => !!x && typeof x.setDraft === "function" && typeof x.setPartial === "function" && typeof x.submit === "function";
/**
* One final transcript into the target: appended to its draft, punctuated,
* and sent at once when it ends a sentence with words in it. True if it went
* out.
*/
function dictate(box, text) {
	const r = appendDictation(box.draft ?? "", text);
	if (r.draft === box.draft) return false;
	box.setDraft(r.draft, { source: "stt" });
	return r.send && box.submit() !== false;
}
const MIC_STRINGS_EN = {
	...MIC_ERROR_STRINGS_EN,
	dictate: "Dictate: listen and type what you say",
	resume: "Tap to resume listening",
	speaking: "Agent speaking; tap to interrupt and talk",
	recording: "Recording; tap to stop listening",
	listening: "Listening; tap to stop",
	rec: "REC",
	noStt: "No STT endpoint: set stt-url"
};
/** The button's label for a view. */
function micLabel(v, status, t = MIC_STRINGS_EN) {
	if (v.state === "off") return v.resume ? t.resume : t.dictate;
	if (status === "speaking") return t.speaking;
	return v.state === "capturing" ? t.recording : t.listening;
}
var NoStt = class extends Error {
	constructor() {
		super("no STT endpoint");
		this.name = "NoStt";
	}
};
/** The browser side of the page's session, made by the first element to connect. */
function browserDeps(storageKey) {
	const ss = () => globalThis.sessionStorage;
	return {
		getStream: (c) => micStream(c?.aec ?? true),
		load: (ev, s, c) => c?.vad ? sileroVad(ev, s, c.vad) : Promise.reject(/* @__PURE__ */ new Error("no VAD source")),
		fallback: (ev, s) => energyVad(ev, s),
		upload: async (wav, info, c) => {
			if (!c?.stt) throw new NoStt();
			const r = await c.stt(wav, info);
			return typeof r === "string" ? r : r.text ?? "";
		},
		onState: (s) => {
			const speaking = globalThis[MIC_SESSION_KEY]?.view().speaking ?? false;
			if (s === "off" && !speaking) existingCtx()?.suspend().catch(() => {});
		},
		onUtterance: (u, c) => c?.onUtterance?.(u),
		storage: {
			get: (k) => ss().getItem(k),
			set: (k, x) => ss().setItem(k, x),
			remove: (k) => ss().removeItem(k)
		},
		storageKey,
		permission: async () => {
			return (await navigator.permissions?.query({ name: "microphone" }))?.state ?? "unknown";
		},
		resumeAudio: async () => {
			const c = audioCtx();
			if (!c) return false;
			if (c.state === "running") return true;
			await Promise.race([c.resume().catch(() => {}), new Promise((r) => setTimeout(r, 800))]);
			return c.state === "running";
		}
	};
}
/** Phosphor "microphone" (MIT, (c) 2023 Phosphor Icons), regular and fill. */
const MIC_PATH = {
	regular: "M128,176a48.05,48.05,0,0,0,48-48V64a48,48,0,0,0-96,0v64A48.05,48.05,0,0,0,128,176ZM96,64a32,32,0,0,1,64,0v64a32,32,0,0,1-64,0Zm40,143.6V240a8,8,0,0,1-16,0V207.6A80.11,80.11,0,0,1,48,128a8,8,0,0,1,16,0,64,64,0,0,0,128,0,8,8,0,0,1,16,0A80.11,80.11,0,0,1,136,207.6Z",
	fill: "M80,128V64a48,48,0,0,1,96,0v64a48,48,0,0,1-96,0Zm128,0a8,8,0,0,0-16,0,64,64,0,0,1-128,0,8,8,0,0,0-16,0,80.11,80.11,0,0,0,72,79.6V240a8,8,0,0,0,16,0V207.6A80.11,80.11,0,0,0,208,128Z"
};
const CSS = `
:host {
  position: relative; display: inline-flex; flex-shrink: 0;
  color: var(--liagent-fg, CanvasText);
  --rec: var(--liagent-mic-rec, oklch(0.6 0.22 25));
  --talk: var(--liagent-mic-talk, oklch(0.62 0.14 250));
}
:host([hidden]) { display: none; }
button {
  all: unset; box-sizing: border-box; position: relative; cursor: pointer;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  width: 40px; height: 32px; border-radius: 999px; font-size: 16px; line-height: 1;
  color: color-mix(in oklch, currentColor 55%, transparent); touch-action: none;
  -webkit-tap-highlight-color: transparent;
}
button::after { content: ""; position: absolute; inset: -4px 0; }
button::before {
  content: ""; position: absolute; inset: 2px 6px; border-radius: 999px; pointer-events: none;
}
button:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }
button[data-state="loading"] { opacity: 0.5; }
button[data-state="listening"], button[data-state="capturing"] { color: var(--rec); }
button[data-state="listening"]::before { box-shadow: 0 0 0 2px color-mix(in oklch, var(--rec) 35%, transparent); }
button[data-state="capturing"]::before { box-shadow: 0 0 0 2px var(--rec); animation: pulse 1.2s ease-in-out infinite; }
button[data-status="speaking"] { color: var(--talk); }
button[data-status="speaking"]::before { box-shadow: 0 0 0 2px var(--talk); animation: pulse 2.4s ease-in-out infinite; }
button[data-resume]::before { border: 2px dashed var(--rec); }
svg { width: 1em; height: 1em; fill: currentColor; }
.rec { font-size: 8px; font-weight: 700; color: var(--rec); }
.rec[hidden] { display: none; }
.note {
  position: absolute; inset-inline-end: 0; bottom: 100%; margin-bottom: 8px;
  white-space: nowrap; font-size: 10px; pointer-events: none; color: oklch(0.6 0.17 45);
}
.note:empty { display: none; }
@keyframes pulse { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { button::before { animation: none !important; } }
`;
const Base = typeof HTMLElement === "undefined" ? class {} : HTMLElement;
const SVG = "http://www.w3.org/2000/svg";
/** The mic button. See the header for its attributes, properties and events. */
var MicElement = class extends Base {
	static observedAttributes = [
		"stt-url",
		"lang",
		"vad-src",
		"ort-src",
		"aec"
	];
	/** The host's own STT call (else a POST to stt-url). */
	stt;
	sttHeaders;
	sttCredentials;
	/** Silero VAD's source (else vad-src/ort-src; else the energy gate). */
	vad;
	strings = {};
	_box = null;
	_voice;
	_session;
	shadow;
	btn;
	path;
	recEl;
	noteEl;
	off = [];
	last = {};
	lastResume;
	get sttUrl() {
		return this.getAttribute("stt-url") ?? "";
	}
	set sttUrl(v) {
		if (v) this.setAttribute("stt-url", v);
		else this.removeAttribute("stt-url");
	}
	get lang() {
		return this.getAttribute("lang") ?? "";
	}
	set lang(v) {
		if (v) this.setAttribute("lang", v);
		else this.removeAttribute("lang");
	}
	get storageKey() {
		return this.getAttribute("storage-key") || MIC_ON_KEY;
	}
	set storageKey(v) {
		this.setAttribute("storage-key", v);
	}
	/** Echo-cancelled barge-in (default: on unless localStorage `liagent:voice-aec` is "0"; `aec="off"` turns it off). */
	get aec() {
		const a = this.getAttribute("aec");
		if (a === null) try {
			return globalThis.localStorage?.getItem("liagent:voice-aec") !== "0";
		} catch {
			return true;
		}
		return a !== "off" && a !== "false" && a !== "0";
	}
	set aec(v) {
		this.setAttribute("aec", v ? "on" : "off");
	}
	/** A soft tick when a spoken sentence is sent. */
	get tick() {
		return this.hasAttribute("tick");
	}
	set tick(v) {
		this.toggleAttribute("tick", v);
	}
	/** The target; null: the closest <liagent-chat>. */
	get box() {
		if (this._box) return this._box;
		const near = this.closest?.("liagent-chat");
		if (isDictationTarget(near)) return near;
		const host = (this.getRootNode?.())?.host;
		return isDictationTarget(host) ? host : null;
	}
	set box(v) {
		this._box = v;
		this.syncActive(true);
	}
	/** The voice output for hands-free replies (undefined: leave the session's as it is). */
	get voice() {
		return this._session?.voice() ?? this._voice ?? null;
	}
	set voice(v) {
		this._voice = v;
		this._session?.setVoice(v);
	}
	/** The page's mic session (undefined until connected where the browser can capture). */
	get session() {
		return this._session;
	}
	get t() {
		return {
			...MIC_STRINGS_EN,
			...this.strings
		};
	}
	config() {
		const url = this.sttUrl;
		const vadSrc = this.getAttribute("vad-src");
		const ortSrc = this.getAttribute("ort-src");
		return {
			stt: this.stt ?? (url ? (wav) => postStt(wav, {
				url,
				lang: this.lang || void 0,
				headers: this.sttHeaders,
				credentials: this.sttCredentials
			}) : void 0),
			vad: this.vad ?? (vadSrc && ortSrc ? vadFromScripts(vadSrc, ortSrc) : void 0),
			aec: this.aec,
			onUtterance: (u) => this.fire("mic-utterance", u)
		};
	}
	attributeChangedCallback() {
		this._session?.configure(this.config());
	}
	connectedCallback() {
		if (!canCapture()) {
			this.hidden = true;
			return;
		}
		this.build();
		const s = this._session = micSession(browserDeps(this.storageKey));
		s.configure(this.config());
		if (this._voice !== void 0) s.setVoice(this._voice);
		this.off.push(s.subscribe((v) => this.render(v)), s.attach({
			onText: (text) => this.onText(text),
			onPending: (n, interim) => this.box?.setPartial(n > 0 && interim ? interim : null)
		}));
		const esc = (e) => {
			if (e.key === "Escape" && s.view().state !== "off") s.off();
		};
		document.addEventListener("keydown", esc);
		this.off.push(() => document.removeEventListener("keydown", esc));
		const box = this.box;
		if (box && typeof box.addEventListener === "function") {
			const out = () => {
				if (s.view().state !== "off") s.voice()?.resume?.();
			};
			box.addEventListener("focusout", out);
			this.off.push(() => box.removeEventListener("focusout", out));
		}
	}
	disconnectedCallback() {
		for (const f of this.off.splice(0)) f();
	}
	/** Turn listening on or off, as a tap does (call it in a gesture). */
	toggle() {
		const s = this._session;
		if (!s) return;
		if (s.view().state === "off") {
			audioCtx()?.resume().catch(() => {});
			s.voice()?.unlock?.();
		}
		s.toggle();
	}
	fire(type, detail, cancelable = false) {
		return this.dispatchEvent(new CustomEvent(type, {
			detail,
			bubbles: true,
			composed: true,
			cancelable
		}));
	}
	onText(text) {
		if (!this.fire("mic-text", { text }, true)) return;
		const box = this.box;
		if (!box || !dictate(box, text)) return;
		this.fire("mic-sent", { text });
		this._session?.voice()?.resume?.();
		this.playTick();
	}
	/** The soft tick, on the mic's AudioContext; never while the agent speaks. */
	playTick() {
		const c = existingCtx();
		if (!this.tick || !c || c.state === "closed" || this._session?.view().speaking) return;
		c.resume().then(() => scheduleTick(c), () => {});
	}
	syncActive(force = false) {
		const on = (this._session?.view().state ?? "off") !== "off";
		if (!force && on === this.last.active) return;
		this.last.active = on;
		const box = this.box;
		if (box) box.micActive = on;
	}
	build() {
		if (this.shadow) return;
		const root = this.shadow = this.attachShadow({ mode: "open" });
		try {
			const sheet = new CSSStyleSheet();
			sheet.replaceSync(CSS);
			root.adoptedStyleSheets = [sheet];
		} catch {
			const st = document.createElement("style");
			st.textContent = CSS;
			root.append(st);
		}
		const note = this.noteEl = document.createElement("span");
		note.className = "note";
		note.setAttribute("role", "alert");
		note.setAttribute("part", "note");
		const btn = this.btn = document.createElement("button");
		btn.type = "button";
		btn.setAttribute("part", "button");
		const svg = document.createElementNS(SVG, "svg");
		svg.setAttribute("viewBox", "0 0 256 256");
		svg.setAttribute("aria-hidden", "true");
		const path = this.path = document.createElementNS(SVG, "path");
		svg.append(path);
		const rec = this.recEl = document.createElement("span");
		rec.className = "rec";
		rec.setAttribute("aria-hidden", "true");
		btn.append(svg, rec);
		btn.addEventListener("pointerdown", (e) => e.preventDefault());
		btn.addEventListener("click", () => {
			const s = this._session;
			if (!s) return;
			const v = s.view();
			if (micStatus(v.state, v.pending, v.speaking) === "speaking" && s.voice()?.interrupt) return s.voice()?.interrupt?.("tap");
			this.toggle();
		});
		root.append(note, btn);
	}
	render(v) {
		const btn = this.btn;
		if (!btn || !this.path || !this.recEl || !this.noteEl) return;
		const t = this.t;
		const status = micStatus(v.state, v.pending, v.speaking);
		btn.dataset.state = v.state;
		btn.dataset.status = status;
		btn.toggleAttribute("data-resume", v.resume && v.state === "off");
		btn.setAttribute("aria-pressed", String(v.state !== "off"));
		btn.setAttribute("aria-label", micLabel(v, status, t));
		btn.title = micLabel(v, status, t);
		this.path.setAttribute("d", v.state === "off" ? MIC_PATH.regular : MIC_PATH.fill);
		this.recEl.textContent = t.rec;
		this.recEl.hidden = v.state !== "capturing";
		const note = v.error ? v.error instanceof NoStt ? t.noStt : micErrorNote(v.error, t) : "";
		this.noteEl.textContent = note;
		if (v.error && v.error !== this.last.error) this.fire("mic-error", {
			error: v.error,
			note
		});
		this.last.error = v.error;
		if (v.state !== this.last.state || status !== this.last.status) {
			this.last.state = v.state;
			this.last.status = status;
			this.fire("mic-state", {
				state: v.state,
				status
			});
		}
		if (v.resumed && v.resumed !== this.lastResume) {
			this.lastResume = v.resumed;
			this.fire("mic-resume", v.resumed);
		}
		this.syncActive();
	}
};
/** Register the element (once) under `tag`. Returns the class. */
function defineMic(tag = "liagent-mic") {
	if (typeof customElements !== "undefined" && !customElements.get(tag)) customElements.define(tag, MicElement);
	return MicElement;
}

//#endregion
export { isDictationTarget as a, MIC_SESSION_KEY as c, micSession as d, dictate as i, MIC_SESSION_V as l, MicElement as n, micLabel as o, defineMic as r, MIC_ON_KEY as s, MIC_STRINGS_EN as t, createMicSession as u };
//# sourceMappingURL=mic-button-CtZHFBSG.js.map