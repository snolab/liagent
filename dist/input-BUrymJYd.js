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

//#endregion
export { lineBreakSends as i, afterChange as n, enterSends as r, DEBOUNCE_MS as t };
//# sourceMappingURL=input-BUrymJYd.js.map