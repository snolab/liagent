import { pickVoice } from "./protocol.js";

//#region src/voice-pick.ts
/**
* Which installed voice reads a reply: the host's preference first, then the
* automatic pick.
*
*   voice({ lang: "ja-JP", prefer: ["Google 日本語", "Microsoft Nanami", "Kyoko"] })
*   box.voicePrefer = { prefer: ["Samantha"] };   // the box's own speechSynthesis path
*
* - `lang` forces the reading language (else it comes from the script, pickLang).
* - `prefer` lists voice names, in order, tried among the voices of that
*   language (same base language: "ja-JP" takes any "ja-*"): an exact
*   `name` first, for each entry in order, then a case-insensitive
*   substring. None installed: the automatic pick.
* - Chrome lists its voices late (getVoices() is empty at first), so the
*   choice is kept per language only until `voiceschanged`, then made again.
*/
const norm = (l) => l.replace(/_/g, "-").toLowerCase();
const base = (l) => norm(l).split("-")[0];
/** The first voice `prefer` names among those of `lang`: exact names in order, then substrings. */
function preferredVoice(voices, lang, prefer) {
	const names = (prefer ?? []).filter((n) => typeof n === "string" && n.trim());
	if (!names.length) return void 0;
	const pool = voices.filter((v) => base(v.lang) === base(lang));
	for (const n of names) {
		const hit = pool.find((v) => v.name === n);
		if (hit) return hit;
	}
	for (const n of names) {
		const want = n.trim().toLowerCase();
		const hit = pool.find((v) => (v.name ?? "").toLowerCase().includes(want));
		if (hit) return hit;
	}
}
/** The voice for `lang`: the preferred one if installed, else `fallback`'s pick. */
function chooseVoice(voices, lang, pref, fallback = pickVoice) {
	return preferredVoice(voices, lang, pref?.prefer) ?? fallback(voices, lang);
}
/** The reading language: the preference's `lang` if set, else `guess` (from the text). */
function readingLang(pref, guess) {
	const l = pref?.lang?.trim();
	return l ? l : guess();
}
/**
* The choice, kept per language and preference until the device's voices
* change. `watch(f)` calls f on each change (speechSynthesis `voiceschanged`)
* and returns its unsubscribe; it is set up on the first pick.
*/
function createVoicePicker(d) {
	const kept = /* @__PURE__ */ new Map();
	let unwatch;
	let watching = false;
	return {
		pick(lang, pref) {
			if (!watching && d.watch) {
				watching = true;
				unwatch = d.watch(() => kept.clear());
			}
			const key = `${norm(lang)}\n${(pref?.prefer ?? []).join("\n")}`;
			if (kept.has(key)) return kept.get(key);
			const list = d.voices();
			const v = chooseVoice(list, lang, pref, d.fallback);
			if (list.length) kept.set(key, v);
			return v;
		},
		reset() {
			kept.clear();
		},
		stop() {
			unwatch?.();
			unwatch = void 0;
			watching = false;
			kept.clear();
		}
	};
}
/** speechSynthesis `voiceschanged`, for createVoicePicker's `watch` (no-op without it). */
function watchVoices(onChange) {
	const s = typeof speechSynthesis === "undefined" ? null : speechSynthesis;
	if (!s || typeof s.addEventListener !== "function") return () => {};
	s.addEventListener("voiceschanged", onChange);
	return () => s.removeEventListener("voiceschanged", onChange);
}

//#endregion
export { watchVoices as a, readingLang as i, createVoicePicker as n, preferredVoice as r, chooseVoice as t };
//# sourceMappingURL=voice-pick-CKunvwiO.js.map