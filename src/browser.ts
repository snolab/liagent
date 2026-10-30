// The browser bundle (dist/liagent.js): the box, its hub client, the mic
// button and the shared protocol in one standalone ES module with no dependencies.
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
  loadTree,
  watchTree,
  type TreeSource,
  type TreeStrings,
} from "./tree.ts";
export * from "./state-tree.ts";
export {
  type DictationTarget,
  MicElement,
  type MicStrings,
  type MicVoiceLink,
  type SttHandler,
  type VadConfig,
  type VadSource,
  defineMic,
  dictate,
  micSession,
  postStt,
  vadFromScripts,
} from "./mic-button.ts";
