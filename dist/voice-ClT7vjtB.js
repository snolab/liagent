import { pickLang } from "./protocol.js";
import { a as speechRate } from "./speech-rate-DXeJjRTc.js";
import { a as watchVoices, i as readingLang, n as createVoicePicker } from "./voice-pick-CKunvwiO.js";
import { O as encodeWav, s as existingCtx } from "./mic-audio-Cjoq2AxZ.js";
import { a as echoScore, r as ECHO_WINDOW_MS } from "./echo-BQF2eImg.js";

//#region src/voice-out.ts
/**
* How the agent's voice leaves the page, and how the mic is opened:
*
* - `liagent:voice-out` (localStorage) picks the output: "speech" (the
*   default: the device's own speechSynthesis) or "cloud" (each sentence
*   fetched from the host's TTS endpoint and played through one `<audio>`
*   element routed through the mic's AudioContext and a GainNode — page
*   audio, so the browser's echo canceller has it as its reference, and the
*   gain ducks it; iOS ignores `element.volume`). "cloud" needs a TTS URL
*   from the host (`voice({ tts })`); without one it is "speech".
* - `liagent:voice-aec` (default on) opens the mic with echoCancellation,
*   noiseSuppression and autoGainControl and keeps it open while the agent
*   speaks. "0": capture is held while the agent speaks instead.
*
* createCloudOut takes its browser pieces injected (fetch, the element, the
* AudioContext), so it is tested with fakes in test/voice-out.test.ts.
*/
const VOICE_OUT_KEY = "liagent:voice-out";
const VOICE_AEC_KEY = "liagent:voice-aec";
/** A clip resumed after an interruption starts this much before where it stopped. */
const RESUME_REWIND_S = .3;
const ignore = () => {};
/** Clips (blob URLs) kept for replays and resumes. */
const CLIP_CACHE = 64;
const read = (k) => {
	try {
		return globalThis.localStorage?.getItem(k) ?? null;
	} catch {
		return null;
	}
};
/** The output asked for on this device: "cloud" only when set so. */
const outMode = () => read(VOICE_OUT_KEY) === "cloud" ? "cloud" : "speech";
/** Echo-cancelled barge-in (default on; "0" = capture held while the agent speaks). */
const aecOn = () => read(VOICE_AEC_KEY) !== "0";
/** A base URL as a TtsUrl: `?lang=<base language>&text=<text>` added to its query. */
function ttsUrlFrom(src) {
	if (typeof src === "function") return src;
	return (text, lang) => `${src}${src.includes("?") ? "&" : "?"}lang=${encodeURIComponent(lang.split(/[-_]/)[0] ?? lang)}&text=${encodeURIComponent(text)}`;
}
/** Why a sentence cannot be fetched at all (null: try the endpoint). */
function cloudSkip(text, lang, lim = {}) {
	const langs = lim.langs ? new Set(lim.langs) : null;
	if (langs && !langs.has(lang.toLowerCase().split(/[-_]/)[0] ?? "")) return "lang";
	if (!text.trim()) return "empty";
	if (lim.maxText !== void 0 && text.length > lim.maxText) return "long";
	return null;
}
/**
* Cloud replies: one `<audio>` element for the whole page (unlocked once in
* a gesture, so iOS lets later sentences play), routed through the
* AudioContext and one GainNode. A sentence that cannot be fetched or played
* calls `onfail` (the session reads it with speechSynthesis instead).
*/
function createCloudOut(d) {
	const toUrl = d.toUrl ?? ((b) => URL.createObjectURL(b));
	const revoke = d.revoke ?? ((u) => URL.revokeObjectURL(u));
	/** Read each time: the page's output may switch endpoints. */
	const lim = () => ({
		langs: d.langs,
		maxText: d.maxText
	});
	const clips = /* @__PURE__ */ new Map();
	let el = null;
	let gain = null;
	let wired = false;
	/** Bumped by every play and stop: the element's events for older ones are ignored. */
	let turn = 0;
	const element = () => {
		if (!el) {
			el = d.element();
			el.preload = "auto";
		}
		if (!wired) {
			const ctx = d.ctx();
			if (ctx) {
				wired = true;
				try {
					const g = ctx.createGain();
					ctx.createMediaElementSource(el).connect(g);
					g.connect(ctx.destination);
					gain = g;
				} catch {
					gain = null;
				}
			}
		}
		return el;
	};
	const fetchClip = (text, lang) => {
		const key = `${lang}\n${text}`;
		const have = clips.get(key);
		if (have) return have;
		const url = d.url();
		const p = url ? d.fetch(url(text, lang)).then(async (r) => {
			const why = r.headers.get("X-Voice");
			if (!r.ok) throw new Error(`http ${r.status}${why ? ` ${why}` : ""}`);
			return toUrl(await r.blob());
		}) : Promise.reject(/* @__PURE__ */ new Error("no tts url"));
		clips.set(key, p);
		p.catch(() => clips.delete(key));
		if (clips.size > CLIP_CACHE) {
			const first = clips.entries().next().value;
			if (first) {
				clips.delete(first[0]);
				first[1].then(revoke, ignore);
			}
		}
		return p;
	};
	const ramp = (level, ms) => {
		const ctx = d.ctx();
		if (gain && ctx) {
			const now = ctx.currentTime;
			gain.gain.cancelScheduledValues(now);
			gain.gain.setValueAtTime(gain.gain.value, now);
			gain.gain.linearRampToValueAtTime(level, now + ms / 1e3);
		} else if (el) el.volume = level;
	};
	const setLevel = (level) => {
		const ctx = d.ctx();
		if (gain && ctx) {
			gain.gain.cancelScheduledValues(ctx.currentTime);
			gain.gain.setValueAtTime(level, ctx.currentTime);
		} else if (el) el.volume = level;
	};
	return {
		unlock() {
			const a = element();
			if (!a.paused) return;
			a.src = silentWav();
			a.play().then(() => a.pause(), ignore);
		},
		gain: () => gain,
		prepare(text, lang) {
			if (!cloudSkip(text, lang, lim())) fetchClip(text, lang).catch(ignore);
		},
		play(s, ev) {
			const me = ++turn;
			const live = () => me === turn;
			const fail = (why) => void Promise.resolve().then(() => live() && ev.onfail?.(why));
			const pb = {
				route: "audio",
				stop() {
					if (!live()) return {};
					turn++;
					const a = el;
					if (!a) return { at: s.at };
					a.pause();
					return { at: Math.max(0, a.currentTime - RESUME_REWIND_S) };
				},
				volume: (level, ms) => live() && ramp(level, ms)
			};
			const skip = cloudSkip(s.text, s.lang, lim());
			if (skip) {
				fail(skip);
				return pb;
			}
			fetchClip(s.text, s.lang).then((url) => {
				if (!live()) return;
				const a = element();
				d.ctx()?.resume?.().catch(ignore);
				setLevel(s.volume);
				a.onended = () => live() && ev.onend();
				a.onerror = () => live() && ev.onerror();
				a.onloadedmetadata = () => {
					if (!live()) return;
					a.onloadedmetadata = null;
					a.currentTime = s.at;
					const rate = s.rate ?? 1;
					a.defaultPlaybackRate = rate;
					a.playbackRate = rate;
					a.preservesPitch = true;
					a.webkitPreservesPitch = true;
					a.play().catch((e) => {
						if (live()) ev.onfail?.(`play ${e?.name ?? "error"}`);
					});
				};
				a.src = url;
				a.load();
			}, (e) => live() && ev.onfail?.(String(e?.message ?? e)));
			return pb;
		}
	};
}
/** 10 ms of silence (8 kHz WAV): what unlock() plays in the gesture. */
let silent = "";
const silentWav = () => {
	if (silent) return silent;
	let bin = "";
	for (const b of encodeWav(new Float32Array(80), 8e3)) bin += String.fromCharCode(b);
	return silent = `data:audio/wav;base64,${btoa(bin)}`;
};
const CLOUD_KEY = "__liagentCloudOut";
/**
* The page's cloud output (null outside a browser), on fetch, new Audio()
* and the page's AudioContext. `tts` (and `limits`) set the endpoint; a
* later call with another one switches to it.
*/
function cloudOut(tts, limits) {
	const g = globalThis;
	let h = g[CLOUD_KEY];
	if (!h) {
		if (typeof Audio === "undefined" || typeof fetch === "undefined") return null;
		const holder = {
			url: null,
			lim: limits ?? {},
			out: null
		};
		holder.out = createCloudOut({
			url: () => holder.url,
			fetch: (u) => fetch(u, { credentials: "same-origin" }),
			element: () => new Audio(),
			ctx: () => existingCtx(),
			get langs() {
				return holder.lim.langs;
			},
			get maxText() {
				return holder.lim.maxText;
			}
		});
		h = g[CLOUD_KEY] = holder;
	}
	if (tts !== void 0) h.url = tts ? ttsUrlFrom(tts) : null;
	if (limits) h.lim = limits;
	return h.out;
}
/** The cloud output has an endpoint to fetch from. */
const cloudReady = () => !!globalThis[CLOUD_KEY]?.url;

//#endregion
//#region src/voice.ts
/**
* Hands-free voice out: the one place that decides when agent replies are
* read aloud, how loud, and how the mic treats them. The page has one
* session (`voice()`, kept on globalThis), so every copy of the module — a
* bundled box, a hot-loaded one — reads through the same queue.
*
*   import { voice } from "liagent/voice";
*   const v = voice({ tts: "/api/tts" });   // tts: only for the "cloud" output
*   box.voice = v;                           // the box calls v.speak(text, id) / v.stop(why)
*   mic.voice = v;                           // <liagent-mic>: ducking, barge-in, the echo guard
*
* - Replies go in a FIFO queue, one utterance per sentence (sentences longer
*   than CHUNK_MAX are cut at a clause or a space); a new reply waits behind
*   the one being read and never cuts it off.
* - Output (src/voice-out.ts, `liagent:voice-out`): the device's
*   speechSynthesis ("speech", the default; the most natural installed voice,
*   voiceQuality), or "cloud": each sentence from the host's TTS endpoint,
*   played through the page's own audio so the echo canceller hears it. A
*   sentence the cloud cannot voice is read by speechSynthesis instead.
* - The voice (src/voice-pick.ts): `lang` forces the language (else from the
*   script), `prefer` names the voices to try first; the choice is made
*   again after speechSynthesis `voiceschanged`.
* - The speed (src/speech-rate.ts, `liagent:speech-rate`) applies from the
*   next utterance, on both outputs.
* - Mic on: every reply is read, whatever the read-aloud toggle says (the
*   toggle itself is never changed, so it is "restored" when the mic stops).
*   Mic off: a reply is read only with the toggle on (`liagent:speak`, the
*   box's) and `here()` (default: this tab is visible).
* - Echo (`liagent:voice-aec`, default on): the mic stays open while the
*   agent speaks — echo cancellation, then the text guard (src/echo.ts)
*   drops what leaks through. The user speaking over the agent ducks it to
*   DUCK_LEVEL; speech that goes on for BARGE_IN_MS (and sounds like speech:
*   isBargeIn) is a barge-in and pauses the reading. With
*   `liagent:voice-aec` = "0": `hold` is true while an utterance plays (and
*   RESUME_TAIL_MS after), and the mic holds its capture.
* - An interruption (a barge-in, a tap on the mic, typing) stops the utterance
*   and remembers where: the clip's time (cloud), else the last word boundary
*   the browser reported, else the start of that sentence. Speech or a tap
*   resumes once the user's line was sent, or after IDLE_RESUME_MS of quiet;
*   typing waits for resume() (a send, or a blur). `stop()` clears the queue.
*
* Everything browser-shaped is injected, so this is tested with fakes
* (test/voice-session.test.ts). Event-driven only: utterance and clip
* events and one-shot timers, never polling.
*/
/** Capture resumes this long after the last utterance ends (the room's echo; hold mode). */
const RESUME_TAIL_MS = 400;
/** An interruption with nothing said (or nothing more) resumes the reading after this. */
const IDLE_RESUME_MS = 1500;
/** While the user talks over the agent, the agent plays this loud… */
const DUCK_LEVEL = .25;
/** …reached over this long (cloud; speechSynthesis takes it from its next sentence)… */
const DUCK_ATTACK_MS = 80;
/** …and back to full over this long once the user stops. */
const DUCK_RELEASE_MS = 200;
/** The user talking over the agent this long is a barge-in: the reading pauses. */
const BARGE_IN_MS = 1500;
/**
* …and only if it sounds like speech: the VAD's mean speech probability over
* that window reaches this (above Silero's own 0.5 start threshold, since the
* echo that leaks through tends to score lower). Weaker speech keeps the
* agent ducked and is judged again after another BARGE_IN_MS.
*/
const BARGE_IN_PROB = .7;
/** Sentences are cut to at most this many characters (a TTS endpoint's usual limit). */
const CHUNK_MAX = 200;
/** localStorage: the read-aloud toggle ("0" = replies silent), the box's own key. */
const SPEAK_KEY = "liagent:speak";
/** globalThis key of the shared session. */
const VOICE_SESSION_KEY = "__liagentVoice";
/** The session's version: a copy on the page with another one is replaced. */
const V = 1;
/** Message ids already read, so a replayed message is not read twice. */
const SPOKEN_IDS = 200;
const CJK_STOP = "。．！？";
const LATIN_STOP = ".!?";
const CLOSERS = "」』）】〕〉》\"'”’)]";
/**
* A reply as sentences: cut after 。．！？ (with any closing quotes or
* brackets), after . ! ? followed by a space or the end (so 3.14 and e.g.
* mid-word stay whole), and at every newline. Blank pieces are dropped.
*/
function sentences(text) {
	const out = [];
	let cur = "";
	const push = () => {
		const t = cur.trim();
		if (t) out.push(t);
		cur = "";
	};
	for (let i = 0; i < text.length; i++) {
		const c = text[i] ?? "";
		if (c === "\n" || c === "\r") {
			push();
			continue;
		}
		cur += c;
		const cjk = CJK_STOP.includes(c);
		if (!cjk && !LATIN_STOP.includes(c)) continue;
		while (i + 1 < text.length && (CJK_STOP + LATIN_STOP + CLOSERS).includes(text[i + 1] ?? "\n")) cur += text[++i];
		if (cjk || i + 1 >= text.length || /\s/.test(text[i + 1] ?? "")) push();
	}
	push();
	return out;
}
const CLAUSE = /[、，,;；:：]/;
/** A sentence in pieces of at most `max` chars: after the last clause mark, else a space, else hard. */
function chunk(s, max = CHUNK_MAX) {
	const out = [];
	let rest = s.trim();
	while (rest.length > max) {
		const head = rest.slice(0, max);
		let cut = -1;
		for (let i = head.length - 1; i > max / 3; i--) if (CLAUSE.test(head[i] ?? "")) {
			cut = i + 1;
			break;
		}
		if (cut < 0) {
			const sp = head.lastIndexOf(" ");
			cut = sp > max / 3 ? sp + 1 : max;
		}
		out.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trim();
	}
	if (rest) out.push(rest);
	return out;
}
/** A barge-in, by the VAD's speech probabilities over the window (none known, as with the energy VAD: yes). */
function isBargeIn(probs, min = BARGE_IN_PROB) {
	if (!probs.length) return true;
	return probs.reduce((a, b) => a + b, 0) / probs.length >= min;
}
/**
* How natural a voice sounds, higher is better. iOS lists its Eloquence
* voices (Eddy, Flo, Grandma, …) and the novelty ones (Bahh, Bubbles,
* Zarvox, …) first for most languages, and marks every voice `default`, so
* "the first voice of the language" sounds robotic or silly there. Prefer
* Premium/Enhanced (and Siri), then the regular named voice.
*/
function voiceQuality(v) {
	const uri = (v.voiceURI ?? "").toLowerCase();
	if (uri.includes("eloquence") || uri.includes("speech.synthesis.voice.")) return 0;
	if (uri.includes("premium")) return 4;
	if (uri.includes("enhanced")) return 3;
	if (uri.includes("siri")) return 3;
	return 2;
}
/**
* An installed voice for `lang`: the exact locale first, then the same
* language; among those the most natural (voiceQuality), the default first.
*/
function pickNaturalVoice(voices, lang) {
	const norm = (l) => l.replace(/_/g, "-").toLowerCase();
	const want = norm(lang);
	const base = want.split("-")[0];
	const exact = voices.filter((v) => norm(v.lang) === want);
	const same = voices.filter((v) => norm(v.lang).split("-")[0] === base);
	const pool = exact.length ? exact : same;
	const best = Math.max(-1, ...pool.map(voiceQuality));
	const top = pool.filter((v) => voiceQuality(v) === best);
	return top.find((v) => v.default) ?? top[0];
}
const WHYS = [
	"speech",
	"tap",
	"typing"
];
function createVoice(d) {
	const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
	const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t));
	const now = d.now ?? (() => Date.now());
	const cloud = () => d.cloud?.() ?? null;
	const mode = () => d.mode?.() === "cloud" && cloud() ? "cloud" : "speech";
	const aec = () => d.aec?.() ?? true;
	let log = d.log ?? (() => {});
	let mic = false;
	let speaking = false;
	const queue = [];
	/** Interruptions under way; the reading waits while any is. */
	const pauses = /* @__PURE__ */ new Set();
	/** The sentence playing: how, (speech) the char of the last word boundary heard, and its record. */
	let current = null;
	let tail;
	let idle;
	/** Bumped whenever the utterance playing is dropped: its late events are ignored. */
	let epoch = 0;
	/** The agent's volume: 1, or DUCK_LEVEL while the user talks over it. */
	let level = 1;
	/** Ducked: the barge-in timer, and the speech probabilities heard since it was armed. */
	let duck = null;
	const said = [];
	const spokenIds = [];
	const subs = /* @__PURE__ */ new Set();
	const state = () => ({
		mic,
		speaking,
		hold: speaking && !aec(),
		ducked: !!duck,
		queued: queue.length,
		paused: pauses.size > 0
	});
	const emit = () => {
		const s = state();
		for (const f of subs) f(s);
	};
	const focusRule = () => d.enabled() && (d.here?.() ?? true);
	const canSpeak = () => !!d.synth() || mode() === "cloud";
	const ended = () => {
		if (current && current.said.end === void 0) current.said.end = now();
	};
	/** Read one sentence with speechSynthesis (from its last word boundary). */
	const speech = (head, ev, e) => {
		const s = d.synth();
		if (!s) return null;
		const from = head.from;
		const u = d.utter(head.text.slice(from), head.lang);
		if (level !== 1) u.volume = level;
		u.rate = d.rate?.() ?? 1;
		u.onboundary = (b) => {
			if (e !== epoch || !current) return;
			if (b.name && b.name !== "word") return;
			current.mark = from + Math.max(0, b.charIndex | 0);
		};
		u.onend = () => ev.onend();
		u.onerror = () => ev.onerror();
		s.speak(u);
		return {
			route: "speech",
			stop: () => {
				s.cancel();
				return {};
			},
			volume: () => {}
		};
	};
	/** Speak the head of the queue, if nothing is playing and nothing waits (the caller emits). */
	const next = () => {
		if (current || pauses.size || !canSpeak()) return;
		const head = queue[0];
		if (!head) return;
		const e = epoch;
		const done = () => {
			if (e !== epoch) return;
			ended();
			current = null;
			queue.shift();
			next();
			if (!current) {
				clearTimer(tail);
				tail = setTimer(() => {
					if (e !== epoch || current) return;
					speaking = false;
					emit();
				}, RESUME_TAIL_MS);
			}
			emit();
		};
		const info = {
			lang: head.lang,
			chars: head.text.length
		};
		const ev = {
			onend: done,
			onerror: done,
			onfail: (reason) => {
				if (e !== epoch || !current) return;
				log({
					ev: "voice-out",
					out: "cloud",
					route: "speech",
					fallback: reason,
					...info
				});
				const p = speech(head, ev, e);
				if (!p) return done();
				current.p = p;
			}
		};
		const rec = {
			text: head.text,
			start: now()
		};
		const c = mode() === "cloud" ? cloud() : null;
		current = {
			p: null,
			mark: head.from,
			said: rec
		};
		const p = c ? c.play({
			text: head.text,
			lang: head.lang,
			at: head.at,
			volume: level,
			rate: d.rate?.() ?? 1
		}, ev) : speech(head, ev, e);
		if (!p) {
			current = null;
			return;
		}
		current.p = p;
		said.push(rec);
		if (said.length > 50) said.shift();
		log({
			ev: "voice-out",
			out: c ? "cloud" : "speech",
			route: p.route,
			...info,
			volume: level,
			at: head.at || void 0,
			from: head.from || void 0
		});
		const after = queue[1];
		if (c && after) c.prepare?.(after.text, after.lang);
		clearTimer(tail);
		speaking = true;
	};
	/** Drop the utterance playing (keeping where it got to) and release the mic at once. */
	const halt = (keepPlace) => {
		epoch++;
		clearTimer(tail);
		if (current) {
			ended();
			const place = current.p.stop();
			const head = queue[0];
			if (keepPlace && head) if (current.p.route === "audio") head.at = place.at ?? head.at;
			else {
				head.from = current.mark;
				head.at = 0;
			}
			current = null;
		}
		speaking = false;
	};
	const setLevel = (l, ms) => {
		level = l;
		current?.p.volume(l, ms);
	};
	/** Back to full volume: ramped (the user stopped) or at once (the reading stopped). */
	const unduck = (ms) => {
		if (!duck) return;
		clearTimer(duck.timer);
		duck = null;
		setLevel(1, ms);
	};
	const armBarge = () => {
		const dk = duck;
		if (!dk) return;
		clearTimer(dk.timer);
		dk.timer = setTimer(() => {
			if (duck !== dk) return;
			const probs = dk.probs;
			dk.probs = [];
			const prob = probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : void 0;
			if (!isBargeIn(probs)) {
				log({
					ev: "voice-duck-hold",
					prob
				});
				return armBarge();
			}
			log({
				ev: "voice-barge-in",
				prob
			});
			api.interrupt("speech");
		}, BARGE_IN_MS);
	};
	const resume = () => {
		clearTimer(idle);
		if (!pauses.size) return;
		pauses.clear();
		next();
		emit();
	};
	const clear = () => {
		halt(false);
		unduck(0);
		clearTimer(idle);
		queue.length = 0;
		pauses.clear();
		emit();
	};
	const api = {
		v: V,
		state,
		subscribe(f) {
			subs.add(f);
			return () => void subs.delete(f);
		},
		setLog(f) {
			log = f;
		},
		log: (ev) => log(ev),
		mode,
		aec,
		shouldSpeak: () => mic || focusRule(),
		readAloud: () => mic || d.enabled(),
		setMic(on) {
			if (mic === on) return;
			mic = on;
			if (!on && !focusRule()) return clear();
			emit();
		},
		reply(text) {
			if (!canSpeak() || !api.shouldSpeak()) return false;
			const lang = readingLang({ lang: d.lang?.() }, () => pickLang(text));
			const add = sentences(text).flatMap((s) => chunk(s)).map((t) => ({
				text: t,
				lang,
				from: 0,
				at: 0
			}));
			const first = add[0];
			if (!first) return false;
			const c = mode() === "cloud" ? cloud() : null;
			if (c && !queue.length) c.prepare?.(first.text, lang);
			queue.push(...add);
			next();
			emit();
			return true;
		},
		speak(text, id) {
			if (id) {
				if (spokenIds.includes(id)) return;
				spokenIds.push(id);
				if (spokenIds.length > SPOKEN_IDS) spokenIds.shift();
			}
			api.reply(text);
		},
		stop(why) {
			if (why && WHYS.includes(why)) return api.interrupt(why);
			clear();
		},
		unlock() {
			d.unlock?.();
		},
		userSpeech() {
			if (current && aec()) {
				if (!duck) {
					duck = {
						timer: void 0,
						probs: []
					};
					setLevel(DUCK_LEVEL, DUCK_ATTACK_MS);
					log({
						ev: "voice-duck",
						route: current.p.route
					});
					emit();
				}
				armBarge();
				return;
			}
			api.interrupt("speech");
		},
		userFrame(prob) {
			duck?.probs.push(prob);
		},
		interrupt(why) {
			if (!queue.length && !current) {
				unduck(0);
				if (speaking) {
					halt(false);
					emit();
				}
				return;
			}
			halt(true);
			unduck(0);
			pauses.add(why);
			clearTimer(idle);
			if (why === "tap") idle = setTimer(resume, IDLE_RESUME_MS);
			emit();
		},
		userIdle() {
			if (duck) {
				unduck(DUCK_RELEASE_MS);
				emit();
				return;
			}
			if (!pauses.has("speech") && !pauses.has("tap")) return;
			clearTimer(idle);
			idle = setTimer(resume, IDLE_RESUME_MS);
		},
		resume,
		echoCheck(transcript, durationMs = 0) {
			const t = now();
			const from = t - durationMs;
			const recent = said.filter((r) => (r.end ?? t) >= from - ECHO_WINDOW_MS).map((r) => r.text);
			const during = said.some((r) => r.start <= t && (r.end ?? t) >= from);
			return {
				...echoScore(transcript, recent),
				during
			};
		},
		echoDropped() {
			if (pauses.size === 1 && pauses.has("speech")) resume();
		}
	};
	return api;
}
const synth = () => typeof speechSynthesis === "undefined" ? null : speechSynthesis;
/** Whether agent replies are read aloud on this device (on unless turned off; the box's toggle). */
const speechEnabled = (key = SPEAK_KEY) => {
	try {
		return globalThis.localStorage?.getItem(key) !== "0";
	} catch {
		return true;
	}
};
/** The default `here`: this tab is visible. */
function speakHere() {
	return typeof document !== "undefined" && document.visibilityState === "visible";
}
/**
* Utterances still playing are kept here: Chrome may garbage-collect one
* nothing references, and then its `end` never fires.
*/
const alive = /* @__PURE__ */ new Set();
/** The page's voice session, shared by every copy of this module; `opts` (re)configure it. */
function voice(opts) {
	const g = globalThis;
	const have = g[VOICE_SESSION_KEY];
	if (have && have.v === V && have.configure) {
		if (opts) have.configure(opts);
		return have;
	}
	let o = { ...opts };
	const picker = createVoicePicker({
		voices: () => typeof speechSynthesis === "undefined" ? [] : speechSynthesis.getVoices(),
		watch: watchVoices,
		fallback: pickNaturalVoice
	});
	if (typeof speechSynthesis !== "undefined") speechSynthesis.getVoices();
	if (o.tts !== void 0) cloudOut(o.tts, o.ttsLimits);
	const v = createVoice({
		synth,
		enabled: () => (o.enabled ?? speechEnabled)(),
		here: () => (o.here ?? speakHere)(),
		cloud: () => cloudReady() ? cloudOut() : null,
		mode: () => (o.mode ?? outMode)(),
		aec: () => (o.aec ?? aecOn)(),
		rate: () => (o.rate ?? speechRate)(),
		lang: () => o.lang,
		unlock: () => {
			if ((o.mode ?? outMode)() === "cloud" && cloudReady()) cloudOut()?.unlock();
		},
		log: o.log,
		utter: (text, lang) => {
			const u = new SpeechSynthesisUtterance(text);
			u.lang = lang;
			const pick = picker.pick(lang, { prefer: o.prefer });
			if (pick) u.voice = pick;
			alive.add(u);
			u.addEventListener("end", () => alive.delete(u));
			u.addEventListener("error", () => alive.delete(u));
			return u;
		}
	});
	const out = Object.assign(v, { configure(next) {
		o = {
			...o,
			...next
		};
		if (next.tts !== void 0 || next.ttsLimits) cloudOut(o.tts ?? null, o.ttsLimits);
		if (next.log) v.setLog(next.log);
		if ("prefer" in next || "lang" in next) picker.reset();
	} });
	g[VOICE_SESSION_KEY] = out;
	return out;
}

//#endregion
export { aecOn as C, createCloudOut as D, cloudSkip as E, outMode as O, VOICE_OUT_KEY as S, cloudReady as T, speechEnabled as _, DUCK_LEVEL as a, RESUME_REWIND_S as b, RESUME_TAIL_MS as c, chunk as d, createVoice as f, speakHere as g, sentences as h, DUCK_ATTACK_MS as i, ttsUrlFrom as k, SPEAK_KEY as l, pickNaturalVoice as m, BARGE_IN_PROB as n, DUCK_RELEASE_MS as o, isBargeIn as p, CHUNK_MAX as r, IDLE_RESUME_MS as s, BARGE_IN_MS as t, VOICE_SESSION_KEY as u, voice as v, cloudOut as w, VOICE_AEC_KEY as x, voiceQuality as y };
//# sourceMappingURL=voice-ClT7vjtB.js.map