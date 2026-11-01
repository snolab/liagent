//#region src/speech-rate.ts
/**
* How fast the agent's replies are read aloud: a per-device setting
* (localStorage `liagent:speech-rate`), picked in the chat's menu. Applied
* from the next utterance, on both outputs (the speech utterance's rate, or a cloud
* voice's playbackRate with the pitch kept).
*/
const SPEECH_RATE_KEY = "liagent:speech-rate";
const SPEECH_RATES = [
	1,
	1.25,
	1.5,
	2
];
const DEFAULT_SPEECH_RATE = 1.5;
const store = () => {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
};
/** The saved rate, if it is one of SPEECH_RATES; else the default. */
function speechRate(s = store()) {
	let raw = null;
	try {
		raw = s?.getItem(SPEECH_RATE_KEY) ?? null;
	} catch {}
	const n = Number(raw);
	return raw !== null && SPEECH_RATES.includes(n) ? n : DEFAULT_SPEECH_RATE;
}
/** Save a rate (one of SPEECH_RATES; anything else is ignored). */
function setSpeechRate(rate, s = store()) {
	if (!SPEECH_RATES.includes(rate)) return;
	try {
		s?.setItem(SPEECH_RATE_KEY, String(rate));
	} catch {}
}

//#endregion
export { speechRate as a, setSpeechRate as i, SPEECH_RATES as n, SPEECH_RATE_KEY as r, DEFAULT_SPEECH_RATE as t };
//# sourceMappingURL=speech-rate-DXeJjRTc.js.map