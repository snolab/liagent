// The browser bundle (dist/liagent.js): the box, its hub client, the mic
// button, the hands-free voice and the shared protocol in one standalone ES module with no dependencies.
//
//   const { defineChatBox, connectHub } = await import("https://…/liagent.js");
//   defineChatBox();

export { ChatBox, defineChatBox } from "./box.ts";
export { connectHub, type HubConnection, type HubOptions } from "./client.ts";
export * from "./protocol.ts";
export { DEBOUNCE_MS } from "./input.ts";
export {
  DEFAULT_QUIET_HOURS,
  QUIET_HOURS_KEY,
  type QuietHours,
  type Silence,
  type SpeakMeta,
  inQuietWindow,
  quietHours,
  quietNow,
  setQuietHours,
  silenceFor,
} from "./quiet-hours.ts";
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
export {
  type OutMode,
  type TtsSource,
  type Voice,
  type VoiceHook,
  type VoiceOptions,
  type VoicePreference,
  type VoiceState,
  chooseVoice,
  createVoice,
  pickNaturalVoice,
  preferredVoice,
  voice,
  voiceQuality,
} from "./voice.ts";
