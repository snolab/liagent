# Headless: your own chat UI

`<liagent-chat>` is one way to draw the chat. `liagent/core` is the chat
without it: the hub session, the messages, pairing, sessions, busy, the
outbox, and the rules for when a draft goes out. You draw the rest in your
own style, in any framework or none. The box is built on the same core, so
both behave the same.

1. [The chat](#1-the-chat)
2. [Drawing it](#2-drawing-it)
3. [Actions](#3-actions)
4. [The input](#4-the-input)
5. [Read-aloud](#5-read-aloud)
6. [React](#6-react)
7. [Vue, Svelte, Solid](#7-vue-svelte-solid)
8. [Your own transport](#8-your-own-transport)
9. [Rules every UI keeps](#9-rules-every-ui-keeps)

Runnable examples:

- `examples/headless/` is plain HTML. In `bun run dev`, open
  `/liagent/examples/headless/`, or add `?hub` for the dev hub.
- `examples/react/HeadlessChat.tsx` is the React version, at
  `/liagent/headless-react.html`.

## 1. The chat

```ts
import { createChat, hubTransport } from "liagent/core";

const chat = createChat({ transport: hubTransport({ url: "/api/chat" }) });
chat.start();
```

`hubTransport` takes the same options as `connectHub`:

- `url`;
- `label`, a string or a function asked again on each navigation;
- `wanted()`;
- `evalCode`, off by default;
- `trackPages`;
- `onEval`.

It holds the socket only while the page is visible and `wanted()`, and
reconnects after a network drop.

`start()` is safe to call twice. `stop()` waits a microtask, so a quick
unmount and remount (React StrictMode, a moved element) keeps the socket.
`close()` is for good.

## 2. Drawing it

```ts
chat.subscribe((s) => render(s)); // returns unsubscribe
render(chat.getState());
```

The state is a frozen object. `getState()` returns the same one until
something changes, and each field keeps its reference while its value
does. A store adapter or a selector can compare by reference.

| Field       | What                                                                        |
| ----------- | --------------------------------------------------------------------------- |
| `status`    | `"idle"`, `"connecting"`, `"live"`, `"offline"` or `"closed"`               |
| `messages`  | `ChatMessage[]`, oldest first, at most 200                                  |
| `outbox`    | lines sent and not yet echoed: `{id, text, status: "sending" \| "failed"}`  |
| `pending`   | a pairing waiting for the user's answer (`label`, `code`, `scope`), or null |
| `sessions`  | approved agents (End each with `chat.end(pair)`)                            |
| `listeners` | agents listening now                                                        |
| `busy`      | the agent is working                                                        |
| `pages`     | the user's open pages, and `self`, which one this is                        |
| `nodes`     | state-tree nodes agents listen at                                           |
| `friend`    | this viewer is a friend, not the site's user                                |
| `notice`    | set when this viewer cannot chat                                            |
| `warning`   | a one-line note, for example a rate limit                                   |
| `evalRan`   | code just ran on this page                                                  |

Events: `chat.on(name, fn)` returns an unhook function.

- `message(m, { live })`: a message that arrived now.
- `history(list)`: the log was replaced when the socket connected.
- `edit(e)`: a line was polished in place.
- `announce(text, kind)`: a live reply or a new pairing request, for a
  screen reader.

The display helpers the box uses are exported too:

- `lineAvatar` and `avatarColors`: a line's avatar and its fallback colour;
- `when`: a message's time;
- `pageHint`: a page's path and device.

## 3. Actions

```ts
chat.send(text, { to: "/words" }); // false: not sent, so keep the draft
chat.send(text, { context, attachments }); // what the user attached, and file refs (never bytes)
chat.retry(id);
chat.dismiss(id); // a failed outbox line
chat.allow(pair, { pages: "all" }); // only from the user's tap (see 9)
chat.deny(pair);
chat.end(pair);
chat.endPage(id);
```

## 4. The input

`createDraft` holds the box's rules for when a line goes out:

- 3 s after the last keystroke;
- Enter (Shift+Enter is a newline), but not inside an IME composition;
- on Android, the line break itself;
- at once when dictation drops in a whole sentence.

```ts
import { createDraft, bindDraft } from "liagent/core";

const draft = createDraft({ send: (text) => chat.send(text), hold: () => micOn });
const unbind = bindDraft(textarea, draft); // or call draft.input(), keydown()… yourself
draft.subscribe((d) => drawDrain(d.armedUntil)); // when the pause will send it
```

`hold()` returning true stops the pause from sending (a mic is on); Enter
and `draft.submit()` still send. When a line can't go out, the draft is
kept, and `failed` is true until the next change.

## 5. Read-aloud

Read-aloud is off unless you connect a voice:

```ts
import { voice } from "liagent/voice";
import { connectVoice } from "liagent/core";

connectVoice(chat, voice());
```

It reads only the agent's live replies. It never reads history or lines
marked `quiet`, and never reads while the page is hidden. Voice and mic
keep their own state (`liagent/voice`, `liagent/mic`).

## 6. React

`liagent/react` (React 18 or later, an optional peer):

```tsx
import { useChatState, useDraft, useHubChat } from "liagent/react";

function Chat() {
  const chat = useHubChat({ url: "/api/chat" }); // started on mount, stopped on unmount
  const messages = useChatState(chat, (s) => s.messages);
  const busy = useChatState(chat, (s) => s.busy);
  const { state, ref } = useDraft(chat);
  return (
    <>
      <ul>
        {messages.map((m) => (
          <li key={m.id}>{m.text}</li>
        ))}
      </ul>
      {busy && <p>Working…</p>}
      <textarea ref={ref} aria-invalid={state.failed} />
    </>
  );
}
```

- A selector must return a part of the state, not a new object or array.
- `useHubChat` reads its function options (`label`, `wanted`, `onEval`)
  fresh on each call, so they never go stale. Changing `url` or
  `evalCode` makes a new chat.
- Pass `voice` to read replies aloud.

## 7. Vue, Svelte, Solid

The chat is a plain store, so each needs a few lines:

```ts
// Vue
import { shallowRef, onScopeDispose } from "vue";
export function useChat(chat) {
  const state = shallowRef(chat.getState());
  onScopeDispose(chat.subscribe((s) => (state.value = s)));
  chat.start();
  onScopeDispose(() => chat.stop());
  return state;
}

// Svelte: a readable store
import { readable } from "svelte/store";
export const chatStore = (chat) =>
  readable(chat.getState(), (set) => {
    const off = chat.subscribe(set);
    chat.start();
    return () => (off(), chat.stop());
  });

// Solid
import { from } from "solid-js";
export const chatSignal = (chat) =>
  from((set) => {
    set(chat.getState());
    const off = chat.subscribe(set);
    chat.start();
    return () => (off(), chat.stop());
  });
```

## 8. Your own transport

If your page already holds a socket to the hub, either feed the chat its
frames:

```ts
const chat = createChat({ transport: { start() {}, send: (m) => mySend(m), stop() {} } });
mySocket.onmessage = (e) => chat.receive(JSON.parse(e.data));
```

or write a `Transport`: `start(sink)`, `send(msg) → boolean`, `stop()`,
and optionally `update()`. Call `sink.receive(frame)` for each frame, and
`sink.status("connecting" | "live" | "offline")`. Going offline clears
what the hub said (pending, sessions, pages, busy), and marks unechoed
lines failed.

## 9. Rules every UI keeps

- **Text only.** Message text is untrusted: put it in `textContent` or a
  React text node, never `innerHTML` or `dangerouslySetInnerHTML`.
- **Approvals come from the user's tap.** `allow()` is refused when the
  browser reports no user activation. Call it from a click handler, never
  from a timer, a message or the agent. Typed text in the chat can never
  approve anything.
- **Show who is asking.** Show a pairing request's `label` and `code`, so
  the user can match the code the agent printed.
- **History is never read aloud.** `connectVoice` follows this; if you
  write your own read-aloud, use only `message` events with `live: true`.
- **Eval stays off** unless the hub and `hubTransport({ evalCode: true })`
  both turn it on.
