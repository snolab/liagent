// The browser bundle (dist/liagent.js): the box, its hub client and the
// shared protocol in one standalone ES module with no dependencies.
//
//   const { defineChatBox, connectHub } = await import("https://…/liagent.js");
//   defineChatBox();

export { ChatBox, defineChatBox } from "./box.ts";
export { connectHub, type HubConnection, type HubOptions } from "./client.ts";
export * from "./protocol.ts";
export { DEBOUNCE_MS } from "./input.ts";
export {
  StateTreeElement,
  defineStateTree,
  frontierLines,
  liveTreeSource,
  loadTree,
  watchTree,
  type LiveTreeOptions,
  type TreeSource,
  type TreeValue,
  type TreeStrings,
} from "./tree.ts";
export * from "./state-tree.ts";
export {
  overlayProgress,
  progressFeed,
  type FeedOptions,
  type OverlayOptions,
  type ProgressFeed,
} from "./progress-tree.ts";
