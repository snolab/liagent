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
  /** The + button (its label and tooltip), and the menu's name. */
  attachOpen: string;
  /** The × on what is attached to the next line. */
  attachRemove: string;
  /** The accessible name of the attached selection's quote. */
  attachQuoted: string;
  /** A file attached (its accessible prefix). */
  attachFile: string;
  // Files sent with a line (box.files, src/files.ts).
  /** Big hint over the box while files are dragged over it: let go to attach them to the message. */
  attachDrop: string;
  /** Tooltip of a file chip over the input while it is still being uploaded (a progress bar shows). */
  attachUploading: string;
  /** Small note on a file chip over the input: the upload did not work; remove it and try again. */
  attachFailed: string;
  /** Small note on a file chip over the input: the file is bigger than the host takes, so it was not uploaded. */
  attachTooBig: string;
  /** Screen-reader label of the × on a file chip over the input: takes that file off the message before sending. */
  attachFileRemove: string;
  /** The + menu item, and the panel's title, that lists the files sent in the chat. One word, a noun. */
  files: string;
  /** Muted line in that list when no file has been sent yet. */
  filesEmpty: string;
  /** Muted line at the top of that list: how much is stored. {size} like "12 MB", {n} a count of files. */
  filesUsage: string;
  /** The same with a storage limit: {size} used of {quota} (both like "12 MB"), {n} files. */
  filesUsageQuota: string;
  /** Line in that list when it could not be loaded (or a delete failed). */
  filesFailed: string;
  /** Small tag on a file in that list: the agent has already handled it. Past participle. */
  filesProcessed: string;
  /** Button on a file in that list: deletes that one file for good (asks to confirm first). */
  filesDelete: string;
  /** The question that replaces a file's row after Delete was tapped: it is removed for good. */
  filesDeleteConfirm: string;
  /** The button next to that question that keeps the file. */
  filesKeep: string;
  /** Screen-reader label of the × that closes that list. */
  filesClose: string;
  /** Echo cancellation in the menu, when a mic is in the box. */
  echoOn: string;
  echoOff: string;
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
  attachOpen: "Add or attach",
  attachRemove: "Remove the attachment",
  attachQuoted: "Quoted from the page",
  attachFile: "File",
  attachDrop: "Drop to attach",
  attachUploading: "Uploading…",
  attachFailed: "Upload failed",
  attachTooBig: "Too large",
  attachFileRemove: "Remove this file",
  files: "Files",
  filesEmpty: "Nothing here yet.",
  filesUsage: "{size} stored · {n} files",
  filesUsageQuota: "{size} of {quota} used · {n} files",
  filesFailed: "Could not load the files.",
  filesProcessed: "Processed",
  filesDelete: "Delete",
  filesDeleteConfirm: "Delete for good?",
  filesKeep: "Keep",
  filesClose: "Close the files",
  echoOn: "Echo cancellation on",
  echoOff: "Echo cancellation off",
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
  attachOpen: "添加或附加",
  attachRemove: "移除附件",
  attachQuoted: "引用自页面",
  attachFile: "文件",
  attachDrop: "松手即可附加",
  attachUploading: "上传中…",
  attachFailed: "上传失败",
  attachTooBig: "文件过大",
  attachFileRemove: "移除此文件",
  files: "文件",
  filesEmpty: "这里还没有文件。",
  filesUsage: "已存 {size} · {n} 个文件",
  filesUsageQuota: "已用 {size} / {quota} · {n} 个文件",
  filesFailed: "无法加载文件列表。",
  filesProcessed: "已处理",
  filesDelete: "删除",
  filesDeleteConfirm: "永久删除？",
  filesKeep: "保留",
  filesClose: "关闭文件列表",
  echoOn: "回声消除：开",
  echoOff: "回声消除：关",
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
