//#region src/mic.ts
/**
* The mic, without the browser: a listening mode in which a voice-activity
* detector cuts speech into utterances, each one sent to the host's STT
* endpoint as soon as it ends. Requests run in parallel; transcripts are
* appended in the order spoken. A long utterance also sends rolling partial
* chunks, whose text shows dimmed until the final one replaces it. Nothing is
* sent as a chat message here: the text lands in the draft, and the rules
* below (appendDictation) say when it goes out. The VAD, the upload and the
* timers are injected, so all of this is tested with fakes (test/mic.test.ts);
* src/mic-audio.ts has the browser pieces and src/mic-button.ts the element.
*/
/** Longest utterance: past this it is cut and sent, and listening goes on. */
const MAX_UTTERANCE_MS = 3e4;
/** The VADs hand over 16 kHz mono. */
const RATE = 16e3;
/** Partials: one every PARTIAL_EVERY_MS of speech, once it is PARTIAL_MIN_MS long… */
const PARTIAL_EVERY_MS = 2500;
const PARTIAL_MIN_MS = 3e3;
/** …each chunk overlapping the one before by this much, so a word cut at its edge is heard whole. */
const PARTIAL_OVERLAP_MS = 1500;
/** Shown in the input for an utterance still being transcribed. */
const PENDING_MARK = "…";
/**
* `speaking`: the agent's reply is being read while the mic is on. Capturing
* wins: with echo cancellation the user can talk over the agent.
*/
function micStatus(state, pending, speaking = false) {
	if (state === "capturing") return "capturing";
	if (speaking && state === "listening") return "speaking";
	if (pending > 0) return "transcribing";
	if (state === "off") return "idle";
	return state;
}
/** A non-2xx answer from the STT endpoint. */
var SttError = class extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
		this.name = "SttError";
	}
};
const nameOf = (e) => e?.name;
/** getUserMedia refused or found nothing: the fallback needs the mic too, so it is not tried. */
function isMicDenied(e) {
	const n = nameOf(e);
	return n === "NotAllowedError" || n === "SecurityError" || n === "NotFoundError";
}
const MIC_ERROR_STRINGS_EN = {
	denied: "Microphone permission denied",
	noMic: "No microphone found",
	signIn: "Sign in to use the mic",
	tooMuch: "Too much speech for now; try again in a minute",
	failed: "Transcription failed ({status})",
	other: "Mic: {message}"
};
/** The short note by the button for an error. */
function micErrorNote(e, t = MIC_ERROR_STRINGS_EN) {
	const s = {
		...MIC_ERROR_STRINGS_EN,
		...t
	};
	const n = nameOf(e);
	if (n === "NotAllowedError" || n === "SecurityError") return s.denied;
	if (n === "NotFoundError") return s.noMic;
	if (e instanceof SttError) {
		if (e.status === 401) return s.signIn;
		if (e.status === 429) return s.tooMuch;
		return s.failed.replace("{status}", String(e.status));
	}
	return s.other.replace("{message}", String(e?.message ?? e).slice(0, 100));
}
/**
* Utterances in flight, in the order they were spoken. `take()` hands back
* the text of every finished one that has nothing unfinished before it.
*/
var UtteranceQueue = class {
	next = 0;
	head = 0;
	done = /* @__PURE__ */ new Map();
	partials = /* @__PURE__ */ new Map();
	add() {
		return this.next++;
	}
	resolve(seq, text) {
		if (seq < this.head) return;
		this.done.set(seq, text);
		this.partials.delete(seq);
	}
	/** Interim text for one not yet resolved (ignored once it is). */
	partial(seq, text) {
		if (seq >= this.head && !this.done.has(seq)) this.partials.set(seq, text);
	}
	getPartial(seq) {
		return this.partials.get(seq) ?? "";
	}
	/** Text now in order (failed ones are skipped), joined with joinText. */
	take() {
		let out = "";
		while (this.done.has(this.head)) {
			const t = this.done.get(this.head);
			this.done.delete(this.head++);
			if (t) out = joinText(out, t);
		}
		return out;
	}
	/** Utterances still being transcribed. */
	pending() {
		return this.next - this.head;
	}
	/**
	* What the input shows, dimmed, after the draft: for each utterance not yet
	* taken, its text (done, waiting on an earlier one), its partial, or
	* PENDING_MARK (one mark for a run of them).
	*/
	interim() {
		let out = "";
		let mark = false;
		for (let s = this.head; s < this.next; s++) {
			const t = this.done.has(s) ? this.done.get(s) ?? "" : this.partials.get(s) || PENDING_MARK;
			if (t === PENDING_MARK && mark) continue;
			mark = t === PENDING_MARK;
			out = joinText(out, t);
		}
		return out;
	}
};
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}。、！？]/u;
/** Append `b` to `a`: a space between them, except between CJK characters or at a line start. */
function joinText(a, b) {
	const t = b.trim();
	if (!t) return a;
	if (!a || /\s$/.test(a)) return a + t;
	return CJK.test(a.at(-1) ?? "") && CJK.test(t[0] ?? "") ? a + t : `${a} ${t}`;
}
/** A draft ending a sentence (any script's full stop, ! or ?). */
const ENDS_SENTENCE = /[。．.!?！？]$/;
/**
* Spoken (or IME-dictated) sentences go out at once from this many characters
* (trimmed): typing arrives a character at a time, so 3 at once is dictation.
*/
const AUTO_SEND_MIN = 3;
/**
* Typed text that arrived at once (an outside dictation IME): AUTO_SEND_MIN
* or more characters since the draft last settled, and the draft now ends a
* sentence. Then it is sent at once.
*/
function isDictationBurst(settledLen, draft) {
	return draft.length - settledLen >= AUTO_SEND_MIN && ENDS_SENTENCE.test(draft.trim());
}
const QUESTION_CJK = /(?:吗|嗎|呢|么|麼|吧|か|かな|かしら|の|でしょう|ですか|ますか|니까|나요|까요)$/u;
const QUESTION_LATIN = /^(?:what|why|how|when|where|who|whom|whose|which|can|could|do|does|did|is|are|was|were|will|would|should|shall|may|might|have|has|had)\b/i;
const TRAILING_PUNCT = /[\p{P}\s]+$/u;
/**
* Spoken text always ends a sentence ("auto-punctuate, then commit"): Whisper
* usually adds the stop itself; when it doesn't, add one that fits the text —
* 。/？ for CJK, ./? otherwise, a question by its particle or opening word.
* Text that already ends in any punctuation (…, ～, quotes) is left alone.
*/
function punctuate(text) {
	const t = text.trim();
	if (!t || /[\p{P}～]$/u.test(t)) return t;
	const bare = t.replace(TRAILING_PUNCT, "");
	if (CJK.test(t)) return t + (QUESTION_CJK.test(bare) ? "？" : "。");
	return t + (QUESTION_LATIN.test(bare) ? "?" : ".");
}
/** Letters or digits in any script: something was actually said. */
const SPOKEN = /[\p{L}\p{N}]/u;
/**
* A final transcript lands in the draft, punctuated, and is committed at once
* (shown, then sent) whenever it carries any words — a short "好" or "OK"
* too. Partials never come here; typing never does (see isDictationBurst).
*/
function appendDictation(draft, text) {
	const said = punctuate(text);
	if (!said) return {
		draft,
		send: false
	};
	const next = joinText(draft, said);
	return {
		draft: next,
		send: SPOKEN.test(said) && ENDS_SENTENCE.test(next.trim())
	};
}
/** Words (or, in CJK text, characters), and their keys: lowercased, without punctuation. */
function tokens(s) {
	const cjk = CJK.test(s);
	const raw = cjk ? [...s.replace(/\s+/g, "")] : s.split(/\s+/).filter(Boolean);
	return {
		raw,
		key: raw.map((w) => w.toLowerCase().replace(/[\p{P}\p{S}]/gu, "")),
		cjk
	};
}
/**
* Two overlapping chunks' transcripts as one: the longest run of words that
* ends `a` and starts `b` is kept once ("the quick brown" + "brown fox" →
* "the quick brown fox"). With no overlap they are just joined.
*/
function mergeOverlap(a, b) {
	const A = tokens(a.trim());
	const B = tokens(b.trim());
	for (let k = Math.min(A.key.length, B.key.length); k > 0; k--) {
		const end = A.key.slice(-k);
		if (end.join("") && end.every((w, i) => w === B.key[i])) return joinText(a.trim(), B.raw.slice(k).join(B.cjk ? "" : " "));
	}
	return joinText(a.trim(), b);
}
/** Linear resampling to `to` Hz (the fallback VAD records at the device's rate). */
function resample(input, from, to) {
	if (from === to) return input;
	const n = Math.max(1, Math.round(input.length * to / from));
	const out = new Float32Array(n);
	const step = from / to;
	const last = input.length - 1;
	for (let i = 0; i < n; i++) {
		const x = i * step;
		const j = Math.floor(x);
		const a = input[Math.min(j, last)] ?? 0;
		out[i] = a + ((input[Math.min(j + 1, last)] ?? 0) - a) * (x - j);
	}
	return out;
}
/** 16-bit PCM WAV, mono: what every STT model takes, and every browser can make. */
function encodeWav(samples, rate = RATE) {
	const buf = /* @__PURE__ */ new ArrayBuffer(44 + samples.length * 2);
	const v = new DataView(buf);
	const str = (o, s) => {
		for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
	};
	str(0, "RIFF");
	v.setUint32(4, 36 + samples.length * 2, true);
	str(8, "WAVE");
	str(12, "fmt ");
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true);
	v.setUint16(22, 1, true);
	v.setUint32(24, rate, true);
	v.setUint32(28, rate * 2, true);
	v.setUint16(32, 2, true);
	v.setUint16(34, 16, true);
	str(36, "data");
	v.setUint32(40, samples.length * 2, true);
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
		v.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true);
	}
	return new Uint8Array(buf);
}
/** The RMS level of a frame, for the energy fallback. */
function rms(frame) {
	let sum = 0;
	for (const x of frame) sum += x * x;
	return Math.sqrt(sum / (frame.length || 1));
}
function concat(chunks) {
	const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
	let o = 0;
	for (const c of chunks) {
		all.set(c, o);
		o += c.length;
	}
	return all;
}
/**
* The energy-threshold VAD the mic falls back to when Silero is not given or
* cannot load: feed it frames; it says when speech starts (two frames over
* `on`) and ends (`hangMs` under `off`), keeping a frame of audio from before
* the start.
*/
function energyGate(opts) {
	const on = opts.on ?? .02;
	const off = opts.off ?? .01;
	const hang = (opts.hangMs ?? 700) * opts.rate / 1e3;
	const min = (opts.minMs ?? 250) * opts.rate / 1e3;
	let loud = 0;
	let quiet = 0;
	let speaking = false;
	let pre = [];
	let chunks = [];
	const cut = () => {
		const all = concat(chunks);
		speaking = false;
		chunks = [];
		quiet = 0;
		loud = 0;
		return all.length < min ? "misfire" : all;
	};
	return {
		push(frame) {
			const level = rms(frame);
			if (!speaking) {
				pre = [...pre.slice(-1), frame];
				loud = level > on ? loud + 1 : 0;
				if (loud < 2) return null;
				speaking = true;
				chunks = pre;
				pre = [];
				return "start";
			}
			chunks.push(frame);
			quiet = level < off ? quiet + frame.length : 0;
			return quiet >= hang ? cut() : null;
		},
		flush() {
			return speaking ? cut() : null;
		}
	};
}
/**
* Listening mode. `toggle()` turns it on (loading the VAD, or the fallback if
* that fails, unless the mic itself was refused) and off. Each utterance is
* encoded and uploaded at once; its transcript (in order) goes to `onText`,
* and `onPending` counts those still out, with the interim text to show
* dimmed. A capture longer than MAX_UTTERANCE_MS is cut and sent. A 401 turns
* listening off; a 429 on a partial stops partials until the next turn-on.
*/
function createMic(d) {
	const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
	const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t));
	const q = new UtteranceQueue();
	let state = "off";
	let vad = null;
	let cap;
	/** Bumped on every toggle, so a VAD that finishes loading after "off" is dropped. */
	let gen = 0;
	/** The utterance being captured: its frames, and its seq once a partial reserved one. */
	let live = [];
	let liveLen = 0;
	let sincePartial = 0;
	let cur = null;
	let partialBusy = false;
	let partialsOn = d.partials !== false;
	/** The agent is speaking (hold): capture stops, and anything heard is dropped. */
	let held = false;
	/** Set by a hold: speech that began before it is dropped, even if it ends after. */
	let tainted = false;
	/** VAD pause/start calls, in order. */
	let ctl = Promise.resolve();
	const toMs = (n) => Math.round(n / RATE * 1e3);
	const toSamples = (ms) => ms * RATE / 1e3;
	const set = (s) => {
		state = s;
		d.onState(s);
	};
	const pending = () => d.onPending(q.pending(), q.interim());
	const report = () => {
		const t = q.take();
		if (t) d.onText(t);
		pending();
	};
	const resetLive = () => {
		live = [];
		liveLen = 0;
		sincePartial = 0;
	};
	/** An utterance whose seq a partial reserved ended in nothing. */
	const dropCur = () => {
		if (cur === null) return;
		q.resolve(cur, null);
		cur = null;
		report();
	};
	const fail = (e) => {
		d.onError?.(e);
		if (e instanceof SttError && e.status === 401) off();
	};
	const sendPartial = () => {
		const seq = cur ?? (cur = q.add());
		const n = Math.min(liveLen, sincePartial + toSamples(PARTIAL_OVERLAP_MS));
		const chunk = concat(live).subarray(liveLen - n);
		sincePartial = 0;
		partialBusy = true;
		pending();
		d.upload(encodeWav(chunk), {
			seq,
			durationMs: toMs(n),
			partial: true
		}).then((text) => q.partial(seq, mergeOverlap(q.getPartial(seq), text)), (e) => {
			if (e instanceof SttError && e.status === 429) partialsOn = false;
			if (e instanceof SttError && e.status === 401) fail(e);
		}).finally(() => {
			partialBusy = false;
			pending();
		});
	};
	const events = (g) => ({
		onSpeechStart() {
			if (g !== gen || held) return;
			tainted = false;
			set("capturing");
			resetLive();
			clearTimer(cap);
			cap = setTimer(() => void vad?.flush(), MAX_UTTERANCE_MS);
		},
		onFrame(frame, prob) {
			if (g !== gen || state !== "capturing") return;
			if (prob !== void 0) d.onProb?.(prob);
			live.push(frame);
			liveLen += frame.length;
			sincePartial += frame.length;
			if (partialsOn && !partialBusy && liveLen >= toSamples(PARTIAL_MIN_MS) && sincePartial >= toSamples(PARTIAL_EVERY_MS)) sendPartial();
		},
		onMisfire() {
			if (g !== gen || held) return;
			clearTimer(cap);
			resetLive();
			dropCur();
			if (state === "capturing") set("listening");
		},
		onSpeechEnd(audio) {
			if (held || tainted) return;
			clearTimer(cap);
			const mine = g === gen;
			if (mine && state === "capturing") set("listening");
			const seq = mine && cur !== null ? cur : q.add();
			if (mine) {
				cur = null;
				resetLive();
			}
			pending();
			d.upload(encodeWav(audio), {
				seq,
				durationMs: toMs(audio.length),
				partial: false
			}).then((text) => q.resolve(seq, text), (e) => {
				q.resolve(seq, null);
				fail(e);
			}).finally(report);
		}
	});
	const on = async () => {
		const g = ++gen;
		partialsOn = d.partials !== false;
		set("loading");
		let v;
		try {
			v = await d.load(events(g));
		} catch (e) {
			if (!d.fallback || isMicDenied(e)) {
				if (g === gen) set("off");
				d.onError?.(e);
				return;
			}
			try {
				v = await d.fallback(events(g));
			} catch (e2) {
				if (g === gen) set("off");
				d.onError?.(e2);
				return;
			}
		}
		if (g !== gen) return void v.destroy();
		vad = v;
		if (!held) await v.start();
		set("listening");
	};
	async function off() {
		if (state === "off") return;
		gen++;
		clearTimer(cap);
		const v = vad;
		vad = null;
		const reserved = cur;
		cur = null;
		resetLive();
		set("off");
		if (v) {
			await v.flush();
			await v.destroy();
		}
		if (reserved !== null) {
			cur = reserved;
			dropCur();
		}
	}
	/**
	* Hold capture while the agent speaks (on), resume it (off). Speech being
	* captured is dropped, partials stop, and the VAD is paused; what it hands
	* over meanwhile (a submit-on-pause) is dropped too.
	*/
	function hold(on) {
		if (held === on) return;
		held = on;
		if (on) {
			tainted = true;
			clearTimer(cap);
			resetLive();
			dropCur();
			if (state === "capturing") set("listening");
		}
		const v = vad;
		if (v) ctl = ctl.then(() => on ? v.pause() : v.start()).catch(() => {});
	}
	return {
		toggle: () => state === "off" ? on() : off(),
		hold,
		held: () => held,
		off,
		state: () => state
	};
}
/** The URL with `lang` added to its query, when a hint is given. */
function sttUrl(url, lang) {
	if (!lang) return url;
	const at = url.indexOf("#");
	const path = at < 0 ? url : url.slice(0, at);
	const hash = at < 0 ? "" : url.slice(at);
	return `${path}${path.includes("?") ? "&" : "?"}lang=${encodeURIComponent(lang)}${hash}`;
}
/**
* POST one recording to the host's STT endpoint: the raw audio as the body
* (16 kHz mono 16-bit PCM WAV) and its type as `content-type`. Answers the
* endpoint's JSON (`text` defaults to ""). Throws SttError on non-2xx, with
* the JSON's `error` as its message when there is one.
*/
async function postStt(wav, req, f = fetch) {
	const r = typeof req === "string" ? { url: req } : req;
	const res = await f(sttUrl(r.url, r.lang), {
		method: "POST",
		body: wav,
		headers: {
			"content-type": r.type ?? "audio/wav",
			...r.headers
		},
		credentials: r.credentials ?? "same-origin"
	});
	const out = await res.json().catch(() => ({}));
	if (!res.ok) throw new SttError(res.status, out.error ?? `stt ${res.status}`);
	return {
		...out,
		text: typeof out.text === "string" ? out.text : ""
	};
}
/** The send tick: two soft sine tones, this loud at their peak, this long in all. */
const TICK_GAIN = .08;
const TICK_MS = 80;
/**
* A short, soft "tick" when a spoken sentence goes out (opt-in on the
* element: the `tick` attribute): two sine tones (the second a fifth up,
* 30 ms later) through one gain with a 5 ms attack and an exponential decay,
* TICK_MS long, peaking at TICK_GAIN. Web Audio only — no <audio> element —
* so iOS keeps it silent when the ringer is muted.
*/
function scheduleTick(ctx, at = ctx.currentTime) {
	const end = at + TICK_MS / 1e3;
	const g = ctx.createGain();
	g.gain.setValueAtTime(1e-4, at);
	g.gain.linearRampToValueAtTime(TICK_GAIN, at + .005);
	g.gain.exponentialRampToValueAtTime(1e-4, end);
	g.connect(ctx.destination);
	const tones = [[880, at], [1320, at + .03]];
	for (const [hz, t] of tones) {
		const o = ctx.createOscillator();
		o.type = "sine";
		o.frequency.setValueAtTime(hz, t);
		o.connect(g);
		o.start(t);
		o.stop(end);
	}
	return end;
}

//#endregion
//#region src/mic-audio.ts
/**
* The mic's browser pieces: the stream's constraints, the page's one
* AudioContext, Silero VAD (@ricky0123/vad-web, loaded only when the host
* gives a source for it) and the energy-gate fallback that needs nothing.
*
* liagent has no runtime dependencies, so vad-web is never imported here.
* The host hands over a loader:
*
*   mic.vad = { load: () => import("@ricky0123/vad-web"),
*               baseAssetPath: "/vad/", onnxWASMBasePath: "/ort/" };
*   mic.vad = vadFromScripts(VAD_DIST_URL, ORT_DIST_URL);   // UMD bundles by <script>
*
* Without one, or when it fails to load (blocked wasm, offline CDN), the
* energy gate (src/mic.ts energyGate) cuts the utterances instead.
*/
/** The mic with echo cancellation on (the default: the user may talk over the agent). */
const AEC_CONSTRAINTS = {
	echoCancellation: true,
	noiseSuppression: true,
	autoGainControl: true,
	channelCount: 1
};
/** Echo cancellation's "off" mode: capture is held while the agent speaks; no auto gain. */
const LEGACY_CONSTRAINTS = {
	echoCancellation: true,
	noiseSuppression: true,
	channelCount: 1
};
const micConstraints = (aec = true) => aec ? { ...AEC_CONSTRAINTS } : { ...LEGACY_CONSTRAINTS };
/** What the browser actually applied to the mic track (no device ids), for a host's debug log. */
let applied = null;
function noteTrack(stream) {
	try {
		const { echoCancellation, noiseSuppression, autoGainControl, sampleRate, channelCount } = stream.getAudioTracks()[0]?.getSettings?.() ?? {};
		applied = {
			echoCancellation,
			noiseSuppression,
			autoGainControl,
			sampleRate,
			channelCount
		};
	} catch {
		applied = null;
	}
}
const appliedSettings = () => applied;
/**
* The page's one AudioContext for voice: the energy fallback records through
* it, the send tick plays on it, and cloud replies play through it. Made on
* the mic tap (a gesture, which iOS needs). Kept on globalThis, so every copy
* of the module shares it.
*/
const CTX_KEY = "__liagentAudio";
function audioCtx() {
	const g = globalThis;
	const have = g[CTX_KEY];
	if (have) return have;
	const Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
	return Ctx ? g[CTX_KEY] = new Ctx() : null;
}
/** The AudioContext if one was made (never makes one). */
const existingCtx = () => globalThis[CTX_KEY] ?? null;
/** The browser can capture: getUserMedia and Web Audio. */
const canCapture = () => typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && !!(globalThis.AudioContext ?? globalThis.webkitAudioContext);
/** The mic stream, with the constraints for `aec`; what was applied is noted. */
async function micStream(aec = true) {
	const s = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(aec) });
	noteTrack(s);
	return s;
}
const loadScript = (src) => new Promise((resolve, reject) => {
	if (document.querySelector(`script[src="${CSS.escape(src)}"]`)) return resolve();
	const s = document.createElement("script");
	s.src = src;
	s.async = true;
	s.onload = () => resolve();
	s.onerror = () => {
		s.remove();
		reject(/* @__PURE__ */ new Error(`could not load ${src}`));
	};
	document.head.append(s);
});
const dir = (u) => u.endsWith("/") ? u : `${u}/`;
/**
* vad-web from its UMD builds, by <script> tags: `vadBase` is vad-web's dist
* directory (bundle.min.js, the model, the worklet) and `ortBase`
* onnxruntime-web's (ort.wasm.min.js and the wasm). E.g. pinned on a CDN:
*
*   vadFromScripts("https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/",
*                  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/")
*
* The page's CSP must allow both origins (script-src, connect-src, and
* 'wasm-unsafe-eval').
*/
function vadFromScripts(vadBase, ortBase) {
	const vad = dir(vadBase);
	const ort = dir(ortBase);
	return {
		baseAssetPath: vad,
		onnxWASMBasePath: ort,
		load: async () => {
			await loadScript(`${ort}ort.wasm.min.js`);
			await loadScript(`${vad}bundle.min.js`);
			const g = globalThis.vad;
			if (!g?.MicVAD) throw new Error("vad-web did not load");
			return g;
		}
	};
}
const vadConfig = (s) => typeof s === "function" ? { load: s } : s;
/**
* Silero on the session's stream (never stops it): ends an utterance after
* ~0.8 s of silence; each frame's speech probability goes to onFrame.
*/
async function sileroVad(ev, stream, src) {
	const c = vadConfig(src);
	const m = await c.load();
	const mod = "MicVAD" in m ? m : m.default;
	if (!mod?.MicVAD) throw new Error("vad-web: no MicVAD");
	const v = await mod.MicVAD.new({
		...c.baseAssetPath ? { baseAssetPath: c.baseAssetPath } : {},
		...c.onnxWASMBasePath ? { onnxWASMBasePath: c.onnxWASMBasePath } : {},
		model: c.model ?? "v5",
		submitUserSpeechOnPause: true,
		startOnLoad: false,
		...c.options,
		getStream: async () => stream,
		pauseStream: async () => {},
		resumeStream: async () => stream,
		onSpeechStart: ev.onSpeechStart,
		onSpeechEnd: ev.onSpeechEnd,
		onVADMisfire: ev.onMisfire,
		onFrameProcessed: (p, frame) => ev.onFrame?.(frame, p?.isSpeech)
	});
	return {
		start: () => v.start(),
		pause: () => v.pause(),
		flush: async () => {
			await v.pause();
			await v.start();
		},
		destroy: () => v.destroy()
	};
}
/** The fallback: an energy threshold on the raw signal (energyGate), on the session's stream. */
async function energyVad(ev, stream) {
	const ctx = audioCtx();
	if (!ctx) throw new Error("no Web Audio");
	const src = ctx.createMediaStreamSource(stream);
	const node = ctx.createScriptProcessor(2048, 1, 1);
	const gate = energyGate({ rate: ctx.sampleRate });
	let on = false;
	const emit = (r) => {
		if (r === "start") ev.onSpeechStart();
		else if (r === "misfire") ev.onMisfire();
		else if (r) ev.onSpeechEnd(resample(r, ctx.sampleRate, RATE));
	};
	node.onaudioprocess = (e) => {
		if (!on) return;
		const frame = new Float32Array(e.inputBuffer.getChannelData(0));
		const r = gate.push(frame);
		if (r === "start") emit(r);
		ev.onFrame?.(resample(frame, ctx.sampleRate, RATE));
		if (r !== "start") emit(r);
	};
	src.connect(node);
	node.connect(ctx.destination);
	return {
		start: () => {
			on = true;
			return ctx.resume();
		},
		pause: () => {
			on = false;
			emit(gate.flush());
		},
		flush: () => emit(gate.flush()),
		destroy: () => {
			on = false;
			node.disconnect();
			src.disconnect();
		}
	};
}

//#endregion
export { isDictationBurst as A, scheduleTick as B, TICK_GAIN as C, createMic as D, appendDictation as E, micStatus as F, postStt as I, punctuate as L, joinText as M, mergeOverlap as N, encodeWav as O, micErrorNote as P, resample as R, SttError as S, UtteranceQueue as T, sttUrl as V, PARTIAL_EVERY_MS as _, canCapture as a, PENDING_MARK as b, micConstraints as c, sileroVad as d, vadFromScripts as f, MIC_ERROR_STRINGS_EN as g, MAX_UTTERANCE_MS as h, audioCtx as i, isMicDenied as j, energyGate as k, micStream as l, ENDS_SENTENCE as m, LEGACY_CONSTRAINTS as n, energyVad as o, AUTO_SEND_MIN as p, appliedSettings as r, existingCtx as s, AEC_CONSTRAINTS as t, noteTrack as u, PARTIAL_MIN_MS as v, TICK_MS as w, RATE as x, PARTIAL_OVERLAP_MS as y, rms as z };
//# sourceMappingURL=mic-audio-C3Shud_F.js.map