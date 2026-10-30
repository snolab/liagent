/**
 * The box's and the tree's own strings in Chinese, picked when the page is in
 * Chinese (`<html lang="zh…">`) until the host passes its own. English
 * otherwise.
 */
import type { TreeStrings } from "./tree.ts";

export type UiStrings = {
  stateTree: string;
  closeTree: string;
  noTreeSource: string;
  lastDone: string;
  nowDoing: string;
  upNext: string;
  needsYou: string;
  items: string;
  /** The mark on a voice line the agent polished (its tooltip and label). */
  polished: string;
};

export const UI_EN: UiStrings = {
  stateTree: "State tree",
  closeTree: "Close the state tree",
  noTreeSource: "No tree source",
  lastDone: "Last done",
  nowDoing: "In progress",
  upNext: "Next",
  needsYou: "needs you",
  items: "items",
  polished: "Polished",
};

export const UI_ZH: UiStrings = {
  stateTree: "状态树",
  closeTree: "关闭状态树",
  noTreeSource: "没有状态树来源",
  lastDone: "最近完成",
  nowDoing: "进行中",
  upNext: "下一步",
  needsYou: "等你处理",
  items: "项",
  polished: "已润色",
};

/** The tree's strings in Chinese (tree.ts TreeStrings). */
export const TREE_ZH: TreeStrings = {
  tree: "状态树",
  back: "返回聊天",
  needsMe: "待我处理",
  needsYou: "等你处理",
  openCount: "{n} 项未完成",
  needsYouCount: "{n} 项等你",
  copy: "复制",
  copied: "已复制",
  loading: "加载中…",
  failed: "无法加载状态树",
  empty: "状态树是空的。",
  nothingNeedsYou: "没有等你处理的事。",
  you: "你",
  lastDone: "最近完成",
  nowDoing: "进行中",
  upNext: "下一步",
  live: "实时数据",
};

/** The page's language is Chinese. */
export function isZh(lang: string | null | undefined = globalThis.document?.documentElement.lang) {
  return /^zh\b/i.test(lang ?? "");
}

/** The box's strings for the page's language. */
export const uiStrings = (lang?: string | null): UiStrings => (isZh(lang) ? UI_ZH : UI_EN);

/** The tree's defaults for the page's language, under the host's own. */
export const treeDefaults = (lang?: string | null): Partial<TreeStrings> =>
  isZh(lang) ? TREE_ZH : {};
