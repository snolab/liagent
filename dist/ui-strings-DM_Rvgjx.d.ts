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
export { isZh as a, UiStrings as i, UI_EN as n, treeDefaults as o, UI_ZH as r, uiStrings as s, TREE_ZH as t };
//# sourceMappingURL=ui-strings-DM_Rvgjx.d.ts.map