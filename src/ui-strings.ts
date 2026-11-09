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
  /** The empty log's hint ({s}: seconds). */
  hintType: string;
  /** The input's placeholder while the mark is held. */
  dragHint: string;
  /** Placeholder when a node is aimed at. */
  messageNode: string;
  /** Placeholder. */
  messageAgent: string;
  /** The input's accessible name. */
  messageAgentLabel: string;
  /** The box's accessible name. */
  chatWithAgent: string;
  /** The mark's tooltip. */
  markHint: string;
  /** The tree button's tooltip. */
  treeHint: string;
  /** Placeholder with no agent listening. */
  agentOfflineWaits: string;
  /** Accessible name of the pairing requests. */
  asksLabel: string;
  /** Accessible name of the @/ node list. */
  nodesLabel: string;
  /** The × on the aimed node. */
  toMainThread: string;
  /** Status. */
  statusUnavailable: string;
  /** Status. */
  statusNotConnected: string;
  /** Status. */
  statusReconnecting: string;
  /** Status ({n}: agents). */
  statusListening: string;
  /** Status. */
  statusAgentOffline: string;
  /** The spinner's label. */
  agentWorking: string;
  /** A code request's pages, when the host grants all. */
  askWhereAll: string;
  /** A code request's pages. */
  askWhereChosen: string;
  /** What a friend's preview asks. */
  askFriend: string;
  /** What an eval request asks. */
  askEval: string;
  /** What a chat request asks. */
  askChat: string;
  /** What an older agent asks. */
  askOld: string;
  /** A request's full sentence (tooltip, label). */
  askSentence: string;
  /** Request tag. */
  tagCode1h: string;
  /** Request tag. */
  tagCode8h: string;
  /** Request tag. */
  tagChat30d: string;
  /** Button. */
  allow: string;
  /** Allow's tooltip (all-pages). */
  allowAllTitle: string;
  /** Allow's tooltip. */
  allowTickedTitle: string;
  /** An older agent's code button. */
  allow8h: string;
  /** Its tooltip (all-pages). */
  allow8hAllTitle: string;
  /** Its tooltip. */
  allow8hTitle: string;
  /** An older agent's chat button. */
  chatOnly: string;
  /** Its tooltip. */
  chatOnlyTitle: string;
  /** The ✕'s label. */
  deny: string;
  /** Page tick. */
  pagesAllLater: string;
  /** After this page's name. */
  thisPage: string;
  /** Screen-reader prefix of your line. */
  you: string;
  /** Screen-reader prefix of an agent line with no label. */
  agentName: string;
  /** The speed group's label. */
  speedLabel: string;
  /** Its visible label. */
  speed: string;
  /** Menu. */
  readAloudMic: string;
  /** Menu. */
  readAloud: string;
  /** Menu. */
  silent: string;
  /** Menu. */
  minimize: string;
  /** Menu. */
  restore: string;
  /** The mark's label. */
  minimizeChat: string;
  /** The mark's label. */
  restoreChat: string;
  /** The mark's label with unread lines. */
  restoreChatNew: string;
  /** A session's kind. */
  sessChat: string;
  /** A session's kind. */
  sessPreview: string;
  /** A session's kind. */
  sessEval: string;
  /** A session's pages. */
  allPages: string;
  /** A session's pages. */
  pagesOne: string;
  /** A session's pages. */
  pagesN: string;
  /** Ends a session or a page. */
  end: string;
  /** Menu heading. */
  openPages: string;
  /** Second tap on this page's End. */
  endThisPage: string;
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
  hintType: "Type here; it is sent {s} s after you stop.",
  dragHint: "drag: move · tap: minimize · double-tap: menu",
  messageNode: "Message {node}…",
  messageAgent: "Message the agent…",
  messageAgentLabel: "Message the agent",
  chatWithAgent: "Chat with the agent",
  markHint: "Tap: minimize or restore · double-tap: menu · drag: move the chat",
  treeHint:
    "Tap: show or hide the state tree · drag right: open the focused node deeper · drag left: fold it · arrow keys: move",
  agentOfflineWaits: "Agent offline — your message waits for it…",
  asksLabel: "Agent connections",
  nodesLabel: "Nodes to address",
  toMainThread: "Send to the main thread instead",
  statusUnavailable: "chat unavailable",
  statusNotConnected: "not connected — your draft is kept",
  statusReconnecting: "reconnecting…",
  statusListening: "agent listening ({n})",
  statusAgentOffline: "agent offline · messages wait until it is back",
  agentWorking: "the agent is working",
  askWhereAll: "on all your pages, including pages opened later,",
  askWhereChosen: "on the chosen pages",
  askFriend: "to run code {where} for 1 hour",
  askEval: "to run code {where} and chat, for 8 hours",
  askChat: "to chat with you, for 30 days",
  askOld: "to run code on your pages, or to chat",
  askSentence: "{label} asks {what}. Allow only if the agent shows the same code: {code}.",
  tagCode1h: "code · 1h",
  tagCode8h: "code · 8h",
  tagChat30d: "chat · 30d",
  allow: "Allow",
  allowAllTitle: "Allow on all your pages, including pages opened later",
  allowTickedTitle: "Allow on the ticked pages",
  allow8h: "8h",
  allow8hAllTitle: "Allow code on all your pages and chat, for 8 hours",
  allow8hTitle: "Allow code and chat for 8 hours",
  chatOnly: "chat",
  chatOnlyTitle: "Chat only, for 30 days",
  deny: "Deny",
  pagesAllLater: "all pages, and pages opened later",
  thisPage: " (this page)",
  you: "you",
  agentName: "agent",
  speedLabel: "Reading speed",
  speed: "Speed",
  readAloudMic: "Replies read aloud (mic on)",
  readAloud: "Replies read aloud",
  silent: "Replies silent",
  minimize: "–  Minimize",
  restore: "+  Restore",
  minimizeChat: "Minimize chat",
  restoreChat: "Restore chat",
  restoreChatNew: "Restore chat, {n} new",
  sessChat: "chat",
  sessPreview: "preview",
  sessEval: "eval",
  allPages: "all pages",
  pagesOne: "1 page",
  pagesN: "{n} pages",
  end: "End",
  openPages: "Your open pages",
  endThisPage: "End this page?",
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
  hintType: "在这里输入，停止输入 {s} 秒后自动发送。",
  dragHint: "拖动：移动 · 轻点：最小化 · 双击：菜单",
  messageNode: "发给 {node}…",
  messageAgent: "给 agent 发消息…",
  messageAgentLabel: "给 agent 发消息",
  chatWithAgent: "与 agent 聊天",
  markHint: "轻点：最小化或还原 · 双击：菜单 · 拖动：移动聊天框",
  treeHint: "轻点：显示或隐藏状态树 · 向右拖：展开当前节点 · 向左拖：折叠 · 方向键：移动",
  agentOfflineWaits: "agent 离线，消息会等它回来…",
  asksLabel: "agent 连接",
  nodesLabel: "可发送的节点",
  toMainThread: "改发到主线程",
  statusUnavailable: "聊天不可用",
  statusNotConnected: "未连接，草稿已保留",
  statusReconnecting: "重新连接中…",
  statusListening: "agent 在听（{n}）",
  statusAgentOffline: "agent 离线 · 消息会等它回来",
  agentWorking: "agent 正在工作",
  askWhereAll: "在你所有页面（包括之后打开的）上",
  askWhereChosen: "在选中的页面上",
  askFriend: "{where}运行代码，1 小时",
  askEval: "{where}运行代码并聊天，8 小时",
  askChat: "和你聊天，30 天",
  askOld: "在你的页面上运行代码，或聊天",
  askSentence: "{label} 请求{what}。只有 agent 显示同样的代码 {code} 时才允许。",
  tagCode1h: "代码 · 1 小时",
  tagCode8h: "代码 · 8 小时",
  tagChat30d: "聊天 · 30 天",
  allow: "允许",
  allowAllTitle: "在你所有页面上允许（包括之后打开的）",
  allowTickedTitle: "在勾选的页面上允许",
  allow8h: "8 小时",
  allow8hAllTitle: "在你所有页面上允许代码和聊天，8 小时",
  allow8hTitle: "允许代码和聊天，8 小时",
  chatOnly: "聊天",
  chatOnlyTitle: "只聊天，30 天",
  deny: "拒绝",
  pagesAllLater: "所有页面，以及之后打开的页面",
  thisPage: "（本页）",
  you: "你",
  agentName: "agent",
  speedLabel: "朗读速度",
  speed: "语速",
  readAloudMic: "朗读回复（麦克风开着）",
  readAloud: "朗读回复",
  silent: "不朗读回复",
  minimize: "–  最小化",
  restore: "+  还原",
  minimizeChat: "最小化聊天",
  restoreChat: "还原聊天",
  restoreChatNew: "还原聊天，{n} 条新消息",
  sessChat: "聊天",
  sessPreview: "预览",
  sessEval: "eval",
  allPages: "所有页面",
  pagesOne: "1 个页面",
  pagesN: "{n} 个页面",
  end: "结束",
  openPages: "你打开的页面",
  endThisPage: "结束本页？",
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
