/**
 * What read-aloud says for a line. The screen always shows `text`; the voice
 * reads the line's own `speak` when the agent gave one (`liagent say
 * --speak`: a clean spoken version, so amounts, links and account paths stay
 * exact on screen while the voice says a natural sentence), else `text` with
 * what a voice should not read dropped (cleanForSpeech): links, paths,
 * ellipses, arrows, markdown marks and emoji.
 *
 * Pure: test/spoken.test.ts.
 */
import { MAX_SPEAK } from "./protocol.ts";

/** The text to read aloud for a line. */
export function spokenText(m: { text: string; speak?: unknown }): string {
  if (typeof m.speak === "string" && m.speak.trim()) return m.speak.trim().slice(0, MAX_SPEAK);
  return cleanForSpeech(m.text);
}

/**
 * `text` without what a voice reads badly: URLs, paths (/a/b, ./x, ~/y),
 * ellipses (a pause instead), arrows, markdown marks (`, *, a heading's #)
 * and emoji. Words, numbers and punctuation stay.
 */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/(^|[\s(（])(?:~|\.{1,2})?\/[\w.~%@:/\-]+/g, "$1 ")
    .replace(/(?:…+|\.{3,})/g, ", ")
    .replace(/[→←↑↓⇒⇐↔➜➡]️?/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[`*]+/g, "")
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/ ([,，。.!！?？])/g, "$1")
    .trim();
}
