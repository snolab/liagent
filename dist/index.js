import { APPROVAL_MS, BUSY_AFTER_REPLY_MS, BUSY_MS, CHAT_HISTORY, CHAT_MS, EVAL_GRANT_MS, MAX_CHAT, MAX_CODE, MAX_LABEL, MAX_RESULT, PAGES_GONE_MS, PAGE_DEBOUNCE_MS, PENDING_MS, chatText, cleanLabel, compile, isPageId, matchesTarget, parseControllerMessage, parsePageMessage, pickLang, pickVoice, shortCode, summarize, trimHistory } from "./protocol.js";
import { t as DEBOUNCE_MS } from "./input-BUrymJYd.js";
import { ChatBox, defineChatBox } from "./box.js";
import { connectHub } from "./client.js";

export { APPROVAL_MS, BUSY_AFTER_REPLY_MS, BUSY_MS, CHAT_HISTORY, CHAT_MS, ChatBox, DEBOUNCE_MS, EVAL_GRANT_MS, MAX_CHAT, MAX_CODE, MAX_LABEL, MAX_RESULT, PAGES_GONE_MS, PAGE_DEBOUNCE_MS, PENDING_MS, chatText, cleanLabel, compile, connectHub, defineChatBox, isPageId, matchesTarget, parseControllerMessage, parsePageMessage, pickLang, pickVoice, shortCode, summarize, trimHistory };