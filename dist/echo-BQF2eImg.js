//#region src/echo.ts
/**
* The text-level echo guard: with the
* mic left open while the agent speaks, what leaks past the browser's echo
* canceller comes back from STT as the agent's own words. A transcript that
* closely matches a sentence the agent spoke in the last ECHO_WINDOW_MS is
* dropped. Pure functions, tested in test/echo-guard.test.ts.
*/
/** Dropped from this similarity (Dice over character n-grams) to one recent agent sentence. */
const ECHO_SIMILARITY = .6;
/** Agent sentences still playing, or ended at most this long before the utterance, count. */
const ECHO_WINDOW_MS = 1e4;
/**
* Shorter transcripts (normalized) are dropped only when they equal a whole
* sentence: "OK" or "はい" said by the user must not vanish because the
* agent's sentence contained it.
*/
const ECHO_MIN_CHARS = 4;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** Case, width, punctuation, symbols and spaces gone: "Hello, World!" → "helloworld". */
function normalizeEcho(s) {
	return s.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");
}
/** Character n-grams with counts (the whole string when it is shorter than n). */
function grams(s, n) {
	const out = /* @__PURE__ */ new Map();
	const chars = [...s];
	if (chars.length && chars.length < n) out.set(s, 1);
	for (let i = 0; i + n <= chars.length; i++) {
		const g = chars.slice(i, i + n).join("");
		out.set(g, (out.get(g) ?? 0) + 1);
	}
	return out;
}
/** Dice coefficient of two n-gram bags: 2·|A∩B| / (|A|+|B|), in [0, 1]. */
function dice(a, b) {
	let na = 0;
	let nb = 0;
	let both = 0;
	for (const c of a.values()) na += c;
	for (const c of b.values()) nb += c;
	for (const [g, c] of a) both += Math.min(c, b.get(g) ?? 0);
	return na + nb ? 2 * both / (na + nb) : 0;
}
/**
* How much `transcript` looks like the agent's own speech: compared with each
* recent sentence, and each pair of consecutive ones (a transcript can span
* a sentence break). Bigrams for CJK, trigrams otherwise, after normalizeEcho.
*/
function echoScore(transcript, spoken) {
	const t = normalizeEcho(transcript);
	const none = {
		score: 0,
		against: null,
		drop: false
	};
	if (!t || !spoken.length) return none;
	const n = CJK.test(t) ? 2 : 3;
	const short = [...t].length < ECHO_MIN_CHARS;
	const cands = [...spoken];
	for (let i = 0; i + 1 < spoken.length; i++) cands.push(`${spoken[i]} ${spoken[i + 1]}`);
	const tg = grams(t, n);
	let best = none;
	for (const c of cands) {
		const nc = normalizeEcho(c);
		if (!nc) continue;
		let score;
		if (nc === t || !short && nc.includes(t)) score = 1;
		else if (short) score = 0;
		else score = dice(tg, grams(nc, n));
		if (score > best.score) best = {
			score,
			against: c,
			drop: false
		};
	}
	return {
		...best,
		score: Math.round(best.score * 1e3) / 1e3,
		drop: best.score >= ECHO_SIMILARITY
	};
}

//#endregion
export { echoScore as a, dice as i, ECHO_SIMILARITY as n, grams as o, ECHO_WINDOW_MS as r, normalizeEcho as s, ECHO_MIN_CHARS as t };
//# sourceMappingURL=echo-BQF2eImg.js.map