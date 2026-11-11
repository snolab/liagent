// liagent/react: React hooks over the headless chat (src/core.ts). React is
// an optional peer: nothing else in liagent imports this file.
//
//   import { useHubChat, useChatState, useDraft } from "liagent/react";
//   function Chat() {
//     const chat = useHubChat({ url: "/api/chat" });
//     const messages = useChatState(chat, (s) => s.messages);
//     const { state, ref } = useDraft(chat);
//     return (
//       <>
//         {messages.map((m) => <p key={m.id}>{m.text}</p>)}  {/* text only, never HTML */}
//         <textarea ref={ref} />
//       </>
//     );
//   }
//
// - useHubChat makes one chat per url (and evalCode), starts it on mount and
//   stops it on unmount; under StrictMode the quick unmount and remount
//   keeps the socket (the chat's stop() waits a microtask). Its function
//   options (label, wanted, onEval) are read fresh on each call, never
//   captured at the first render.
// - useChatState reads through useSyncExternalStore. A selector must return
//   a slice of the state (it keeps its reference), not a new object.

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { type HubOptions, hubTransport } from "./client.ts";
import { type Chat, type ChatOptions, type ChatState, connectVoice, createChat } from "./core.ts";
import { type Draft, type DraftOptions, type DraftState, bindDraft, createDraft } from "./draft.ts";

const whole = (s: ChatState) => s;

/** The chat's state, or a slice of it; re-renders when that changes. */
export function useChatState(chat: Chat): ChatState;
export function useChatState<T>(chat: Chat, select: (s: ChatState) => T): T;
export function useChatState<T>(chat: Chat, select?: (s: ChatState) => T): T | ChatState {
  const pick = select ?? whole;
  const get = () => pick(chat.getState());
  return useSyncExternalStore(chat.subscribe, get, get);
}

export type UseHubChatOptions = HubOptions &
  Pick<ChatOptions, "requireActivation"> & {
    /** Read the agent's live replies aloud through this (liagent/voice's voice()). */
    voice?: { speak(text: string, id?: string): void } | null;
  };

/** A chat on the hub's page socket, for this component's life. */
export function useHubChat(opts: UseHubChatOptions): Chat {
  const latest = useRef(opts);
  latest.current = opts;
  const { url, evalCode, trackPages, requireActivation } = opts;
  const chat = useMemo(
    () =>
      createChat({
        requireActivation,
        transport: hubTransport({
          url,
          evalCode,
          trackPages,
          label: () => {
            const l = latest.current.label;
            return typeof l === "function" ? l() : (l ?? defaultLabel());
          },
          wanted: () => latest.current.wanted?.() ?? true,
          onEval: (r) => latest.current.onEval?.(r),
        }),
      }),
    [url, evalCode, trackPages, requireActivation],
  );
  useEffect(() => {
    chat.start();
    return () => chat.stop();
  }, [chat]);
  const voice = opts.voice;
  useEffect(() => (voice ? connectVoice(chat, voice) : undefined), [chat, voice]);
  return chat;
}

/** hubTransport's own default label, for when the host gives none. */
function defaultLabel() {
  const standalone = matchMedia?.("(display-mode: standalone)").matches ? "pwa " : "";
  return `${location.pathname} ${standalone}${navigator.userAgent}`;
}

/**
 * The draft for `chat` (src/draft.ts): its state, the controller, and a ref
 * that wires a <textarea> or <input> to it.
 */
export function useDraft(
  chat: Chat,
  opts: Omit<DraftOptions, "send"> & { to?: string } = {},
): {
  state: DraftState;
  draft: Draft;
  ref: (el: HTMLTextAreaElement | HTMLInputElement | null) => void;
} {
  const latest = useRef(opts);
  latest.current = opts;
  const draft = useMemo(
    () =>
      createDraft({
        send: (text) => chat.send(text, { to: latest.current.to }),
        hold: () => latest.current.hold?.() ?? false,
      }),
    [chat],
  );
  useEffect(() => () => draft.dispose(), [draft]);
  const state = useSyncExternalStore(draft.subscribe, draft.getState, draft.getState);
  const unbind = useRef<(() => void) | null>(null);
  const ref = useCallback(
    (el: HTMLTextAreaElement | HTMLInputElement | null) => {
      unbind.current?.();
      unbind.current = el ? bindDraft(el, draft) : null;
    },
    [draft],
  );
  return { state, draft, ref };
}
