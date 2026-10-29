import { APPROVAL_MS, BUSY_AFTER_REPLY_MS, BUSY_MS, CHAT_HISTORY, CHAT_MS, ChatMessage, ControllerMessage, EVAL_GRANT_MS, HubState, MAX_CHAT, MAX_CODE, MAX_LABEL, MAX_RESULT, PAGES_GONE_MS, PAGE_DEBOUNCE_MS, PENDING_MS, PageInfo, PageMessage, PairInfo, Scope, chatText, cleanLabel, compile, isPageId, matchesTarget, parseControllerMessage, parsePageMessage, pickLang, pickVoice, shortCode, summarize, trimHistory } from "./protocol.js";
import { ChatBox, defineChatBox } from "./box.js";
import { HubConnection, HubOptions, connectHub } from "./client.js";

//#region src/input.d.ts
/** Typing pauses this long before the draft is sent. */
declare const DEBOUNCE_MS = 3000;
//#endregion
export { APPROVAL_MS, BUSY_AFTER_REPLY_MS, BUSY_MS, CHAT_HISTORY, CHAT_MS, ChatBox, ChatMessage, ControllerMessage, DEBOUNCE_MS, EVAL_GRANT_MS, type HubConnection, type HubOptions, HubState, MAX_CHAT, MAX_CODE, MAX_LABEL, MAX_RESULT, PAGES_GONE_MS, PAGE_DEBOUNCE_MS, PENDING_MS, PageInfo, PageMessage, PairInfo, Scope, chatText, cleanLabel, compile, connectHub, defineChatBox, isPageId, matchesTarget, parseControllerMessage, parsePageMessage, pickLang, pickVoice, shortCode, summarize, trimHistory };
//# sourceMappingURL=index.d.ts.map