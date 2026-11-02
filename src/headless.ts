// liagent/core: everything a chat UI needs, with no UI (docs/headless-plan.md).
//
//   import { createChat, hubTransport } from "liagent/core";
//   const chat = createChat({ transport: hubTransport({ url: "/api/chat" }) });
//   chat.subscribe(() => render(chat.getState()));
//   chat.start();
//
// The session and its rules are src/core.ts; the hub's page socket is
// src/client.ts; the display helpers (avatars, times, page hints) are the
// box's own, so a custom UI draws lines the way the box does.

export * from "./core.ts";
export { IDLE_MS, type HubOptions, hubTransport } from "./client.ts";
export { pageHint, when } from "./format.ts";
export {
  type AvatarSrc,
  type LineAvatar,
  type Sender,
  avatarColors,
  avatarSrcs,
  hashId,
  initialOf,
  lineAvatar,
} from "./avatar.ts";
export {
  BURST_CHARS,
  DEBOUNCE_MS,
  ENDS_SENTENCE,
  type KeyInfo,
  afterChange,
  enterSends,
  lineBreakSends,
} from "./input.ts";
