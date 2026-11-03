//#region src/aec.ts
/**
* The mic's echo cancellation switch (localStorage `liagent:voice-aec`, per
* device) and what it selects. Small and free of the mic code, so a host's
* settings page (or the box's menu) can show the switch without loading the
* mic.
*
* - On (the default): echoCancellation, noiseSuppression and autoGainControl.
*   The mic stays open while anything plays; the user can talk over the
*   agent (barge-in, src/voice.ts). Some mobile browsers then route playback
*   as a voice call (a thinner speaker).
* - Off ("0"): no processing at all. Playback stays on the media stream, and
*   the mic holds its capture while the agent speaks (src/voice.ts `hold`)
*   and while the page plays its own audio (src/page-audio.ts), so neither
*   is transcribed.
*
* applyAec writes the switch, tells the page (AEC_EVENT) and reopens an open
* mic at once, so the difference is heard right away; with the mic off it
* applies when it next opens.
*/
const VOICE_AEC_KEY = "liagent:voice-aec";
/** Window event after a change (detail: { on }), for switches shown elsewhere. */
const AEC_EVENT = "liagent-voice-aec";
/** globalThis key of the page's mic session (src/mic-session.ts MIC_SESSION_KEY). */
const MIC_SESSION_GLOBAL = "__liagentMic";
/** The mic with echo cancellation on (the default). */
const AEC_CONSTRAINTS = {
	echoCancellation: true,
	noiseSuppression: true,
	autoGainControl: true,
	channelCount: 1
};
/** Echo cancellation off: no processing at all; capture is held while the page plays. */
const RAW_CONSTRAINTS = {
	echoCancellation: false,
	noiseSuppression: false,
	autoGainControl: false,
	channelCount: 1
};
/** The former name of RAW_CONSTRAINTS. */
const LEGACY_CONSTRAINTS = RAW_CONSTRAINTS;
/** getUserMedia's audio constraints for a mode. */
const micConstraints = (aec = true) => aec ? { ...AEC_CONSTRAINTS } : { ...RAW_CONSTRAINTS };
const store = () => {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
};
/** Echo cancellation on (default on; "0" = off). */
function aecOn() {
	try {
		return store()?.getItem(VOICE_AEC_KEY) !== "0";
	} catch {
		return true;
	}
}
/** Write the switch (never throws). The mic is not touched: see applyAec. */
function setAec(on) {
	try {
		if (on) store()?.removeItem(VOICE_AEC_KEY);
		else store()?.setItem(VOICE_AEC_KEY, "0");
	} catch {}
}
/**
* The switch, from a tap: write it, tell the page, and reopen the mic if it
* is on. "reopened": the new mode is live now; "next-open": the mic is off
* (or an older session cannot reopen), so it applies when it next opens.
*/
async function applyAec(on, g = globalThis) {
	setAec(on);
	try {
		globalThis.dispatchEvent?.(new CustomEvent(AEC_EVENT, { detail: { on } }));
	} catch {}
	const m = g[MIC_SESSION_GLOBAL];
	if (!m || m.view().state === "off" || !m.reopen) return "next-open";
	try {
		return await m.reopen() ? "reopened" : "next-open";
	} catch {
		return "next-open";
	}
}

//#endregion
export { VOICE_AEC_KEY as a, micConstraints as c, RAW_CONSTRAINTS as i, setAec as l, AEC_EVENT as n, aecOn as o, LEGACY_CONSTRAINTS as r, applyAec as s, AEC_CONSTRAINTS as t };
//# sourceMappingURL=aec-B3XPHBsV.js.map