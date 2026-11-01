import { o as TreeStrings } from "./tree-CZ50sZNq.js";

//#region src/ui-strings.d.ts
type UiStrings = {
  stateTree: string;
  closeTree: string;
  noTreeSource: string;
  lastDone: string;
  nowDoing: string;
  upNext: string;
  needsYou: string;
  items: string; /** The mark on a voice line the agent polished (its tooltip and label). */
  polished: string;
};
declare const UI_EN: UiStrings;
declare const UI_ZH: UiStrings;
/** The tree's strings in Chinese (tree.ts TreeStrings). */
declare const TREE_ZH: TreeStrings;
/** The page's language is Chinese. */
declare function isZh(lang?: string | null | undefined): boolean;
/** The box's strings for the page's language. */
declare const uiStrings: (lang?: string | null) => UiStrings;
/** The tree's defaults for the page's language, under the host's own. */
declare const treeDefaults: (lang?: string | null) => Partial<TreeStrings>;
//#endregion
//#region src/speak-rules.d.ts
/**
 * Which agent lines are read aloud. Every line is shown in the log; this
 * decides only whether it is also spoken. There is no time of day in it.
 *
 * 1. A quiet line (`quiet: true`, `liagent say --quiet`: FYI, progress,
 *    notices) is never read, even with a mic on.
 * 2. A hidden page (another tab, the app in the background, the screen
 *    locked: `document.visibilityState` "hidden") never speaks; browsers
 *    would not let it. The box also stops a reading under way when the page
 *    hides.
 *
 * Everything else is read by the usual rules (read-aloud on, or a mic on).
 * Pure: test/speak-rules.test.ts.
 */
/** What a line says about being read aloud (ChatMessage's `quiet`). */
type SpeakMeta = {
  quiet?: unknown;
};
/** Quiet: `say --quiet`. Only boolean true counts. */
declare const isQuiet: (m: SpeakMeta) => boolean;
/** Why a line is not read aloud; null = read it (by the usual rules). */
type Silence = "hidden" | "quiet";
/** The rules: a quiet line, then a hidden page. */
declare function silenceFor(m: SpeakMeta, at: {
  hidden: boolean;
}): Silence | null;
/** The page is hidden or the screen is locked (true without a document: never speak there). */
declare const pageHidden: () => boolean;
/**
 * Per-device setting names an older version saved (under the box's
 * storage-key) that mean nothing now. The box removes them when it attaches.
 */
declare const RETIRED_SETTINGS: readonly ["quiet-hours"];
//#endregion
export { pageHidden as a, UI_EN as c, isZh as d, treeDefaults as f, isQuiet as i, UI_ZH as l, Silence as n, silenceFor as o, uiStrings as p, SpeakMeta as r, TREE_ZH as s, RETIRED_SETTINGS as t, UiStrings as u };
//# sourceMappingURL=speak-rules-C7HEK7mJ.d.ts.map