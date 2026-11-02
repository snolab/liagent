# Plan: headless liagent

Status: proposal, for the owner to review. Nothing here has been built yet.

## Goal

Some projects want their own chat UI, built from scratch in their own
style, but they still want liagent's behaviour. So liagent should ship that
behaviour without any UI: the hub session, the message list, pairing and
sessions, busy, eval, sending the draft, and read-aloud. A project then
draws whatever it likes on top. `<liagent-chat>` stays the default UI, and
it is rebuilt on the same core, so both stay in step.

## Where we are (main, 0.1.5)

Already UI-free and exported:

| Entry              | What                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `liagent/protocol` | the wire, validation, `trimHistory`, `applyEdit`, `draftSource`, `pickLang`                                |
| `liagent/ui`       | pure reducers: tree nav, detents, floating lines, anchoring, echo guard, speech rate, gestures, zh strings |
| `liagent/voice`    | `createVoice` / `voice()`: the read-aloud queue, barge-in, ducking (browser APIs injected)                 |
| `liagent/mic`      | `micSession`, `dictate`: voice input                                                                       |
| `src/input.ts`     | the send rules (`afterChange`, `enterSends`, …), but not exported as an entry                              |
| `src/avatar.ts`    | `lineAvatar`, `avatarColors`, re-exported from `liagent/box`                                               |

What is still tied to the box:

- **`connectHub(box, opts)`** (src/client.ts) takes a `ChatBox` and writes
  into it (`box.live`, `box.pending`, `box.sessions`, `box.push(m)`,
  `box.beat()`, `box.edit(e)`, …). It reads `box.onSend`, `box.onAnswer`
  and `box.onEnd`. Without a box, you can't use it.
- **State rules live in `ChatBox`** (src/box.ts, about 2500 lines): dedupe
  by id, trimming the history, timing out the busy spinner
  (`BUSY_MS`, `BUSY_AFTER_REPLY_MS`), "a reply ends busy", "only live agent
  replies are read aloud", applying edits, the target node, the draft and
  its debounce timer, unread counts, the status text.
- The evidence: `examples/react/HubChat.tsx` rewrites the socket, the
  reconnect, dedupe and busy by hand, just to put the box inside React.

## Design

Three layers, each usable on its own:

```
 ┌───────────────────────────────────────────────────────────┐
 │ views    <liagent-chat> (default)   · your own UI           │
 ├───────────────────────────────────────────────────────────┤
 │ adapters liagent/react: useChat(chat), useDraft(…)          │  thin, optional
 ├───────────────────────────────────────────────────────────┤
 │ core     liagent/core:  createChat({ transport, … })        │  no DOM rendering,
 │          transports:    hubTransport(opts) · your own       │  zero dependencies
 │          controllers:   draft (input rules) · voice · mic   │
 ├───────────────────────────────────────────────────────────┤
 │ wire     liagent/protocol (as today)                        │
 └───────────────────────────────────────────────────────────┘
```

### 1. `liagent/core`: `createChat`, a store with actions

```ts
import { createChat, hubTransport } from "liagent/core";

const chat = createChat({ transport: hubTransport({ url: "/api/chat", evalCode: false }) });

chat.getState(); // an immutable snapshot, a new object only when something changed
chat.subscribe(() => render(chat.getState())); // returns unsubscribe
chat.on("message", (m, { live }) => {}); // also "edit", "eval", "error"

chat.send("hi", { to: "/words" }); // → boolean (false: not connected; keep the draft)
chat.allow(pair, { pages: "all" });
chat.deny(pair);
chat.end(pair);
chat.endPage(id);
chat.update(); // re-check wanted()
chat.close();
```

The snapshot (`ChatState`) holds everything a UI draws:
`status` ("connecting" | "live" | "offline" | "closed"), `messages`,
`pending`, `sessions`, `listeners`, `pages`, `self`, `nodes`, `busy`,
`evalRan`, `friend`, `notice`, `warning`. Two derived helpers stay
outside the snapshot, so it stays plain data: `statusText(state, strings)` and
`unread(state, seenCount)`.

What moves out of `ChatBox` into the core: dedupe by id, `trimHistory`,
`applyEdit`, the busy beat and its timeout, "a reply ends busy", and the
rule that a message is `live` (heard now) or history (never read aloud).
Read-aloud itself stays out of the core: the box, or the host, subscribes
`chat.on("message")` and calls `voice().speak(...)` when `live` is true.

The shape follows `subscribe` + `getState`, so React's
`useSyncExternalStore`, Svelte stores, Vue `shallowRef` and Solid signals
all wrap it in a few lines.

### 2. Transports

`hubTransport(opts)` is today's `connectHub` with the box removed: the
socket only while the page is visible, the idle drop, reconnect rules
(none after a 4xxx code or a refusal), the tab's page id in
sessionStorage, tracking client-side navigation, and eval (still off unless
`evalCode: true`). A transport is a small interface:

```ts
type Transport = {
  start(sink: { message(msg: unknown): void; status(s: Status): void }): void;
  send(msg: PageMessage): boolean;
  update?(): void;
  stop(): void;
};
```

A host with its own socket (like HubChat.tsx) writes a 20-line transport,
or calls `chat.receive(msg)` itself, and all the state rules still apply.

### 3. Controllers (headless behaviour, any input element)

- **Draft**: `createDraft({ onSend: (t) => chat.send(t) })` returns
  `{ draft, armedUntil, set(text), key(e), beforeInput(e), compositionStart/End(), submit() }`.
  It wraps src/input.ts: the 3 s debounce, Enter, IME, Android 229,
  dictation bursts, and keeping the draft when sending fails.
  `bindDraft(textarea, draft)` wires a plain `<textarea>` in one call.
- **Voice / mic**: already headless (`liagent/voice`, `liagent/mic`).
  Document them as part of headless mode, and give the core one hook:
  `connectVoice(chat, voice())`.
- **Avatars and time**: `lineAvatar`, `avatarColors`, `when`, `pageHint` are
  exported from `liagent/core` too, so a custom UI does not import the box.

### 4. The box on top

`ChatBox` gets a `chat` property. `connectHub(box, opts)` stays, with the
same signature, as
`box.chat = createChat({ transport: hubTransport(opts) })`. Every property
the box has today (`messages`, `push`, `beat`, `live`, …) keeps working.
Without a `chat`, the box makes a local one, so "your own transport" with
`onSend`/`push` still works too. No breaking change. The box keeps only
rendering, gestures, dragging, the menu and theming.

### 5. Adapters

- `liagent/react`: `useChat(chat)` (useSyncExternalStore), `useDraft(chat)`,
  `useHubChat(opts)` (creates and closes the chat in an effect, safe under
  StrictMode's double effects). `react` is an optional peer dependency, and
  nothing else imports it.
- Vue, Svelte, Solid: a recipe of a few lines each in docs/headless.md, plus a
  runnable example, rather than packages. We add a package only if users ask.
- `examples/headless/`: a plain-HTML chat built from scratch on
  `liagent/core`, and `HubChat.tsx` rewritten to `useHubChat`, which should
  come out much shorter.

### Rules the core keeps, whatever the UI

These are part of the contract, written into docs/headless.md and tested
in the core:

- **Approvals come from the user.** `allow()` is meant for a user's tap.
  The core checks `navigator.userActivation?.isActive` where the browser
  has it, and refuses otherwise (a host can opt out for tests). A UI must
  never call `allow()` from a message, a timer or the agent.
- **Text only.** Message text is untrusted. The docs say never to put it
  in `innerHTML` or `dangerouslySetInnerHTML`, and the example shows
  `textContent`.
- **History is never read aloud**: only `live` messages reach voice.
- **Eval stays off** unless both the hub and `hubTransport({ evalCode: true })` turn it on.

## Lessons from other headless libraries

The full survey, with sources, is [headless-survey.md](headless-survey.md).
It covers the Vercel AI SDK `useChat`, assistant-ui, CopilotKit, Stream
Chat, TanStack, Downshift, React Aria, Headless UI, Radix, Zag/Ark and
Lexical. Here is what it changes in the design above:

- **Stable snapshot references, per slice** (Stream, TanStack Query).
  `getState()` returns the same object until something changes, and
  `state.messages` keeps its reference until the messages change. Then
  selectors and `useSyncExternalStore` don't loop or re-render everything.
- **No config captured at construction** (AI SDK fixed stale closures
  three times). `hubTransport` takes functions (`label`, `wanted`), as
  `connectHub` does today. `chat.setOptions()` updates callbacks, and the
  React hooks keep the latest callbacks in a ref.
- **An idempotent lifecycle** (StrictMode; a custom element moved in the
  DOM). `start()` is safe to call twice, and `stop()` is deferred by a
  microtask, so an unmount followed at once by a mount keeps the socket.
  Today's box only re-adds its listeners on re-attach; the core will keep
  that property.
- **Reconnect on `pageshow`** as well as `visibilitychange`, because iOS
  freezes background sockets (AI SDK #22035). Inject the clock and timers
  for tests.
- **Optimistic sends in the core, not the UI** (Stream keeps them in its
  React SDK only). `send()` adds an `outbox` entry, `sending` until the
  hub echoes it, or `failed` when the socket refuses it. Every UI then
  shows "not sent, draft kept" the same way.
- **Freeze the message shape before 0.2.0.** The most expensive churn we
  found was AI SDK v4 → v5 (`content` → `parts`, `append` →
  `sendMessage`). Before we publish the core, we review `ChatMessage` and
  the action names once, and add new fields only after that.
- **Actions only; the snapshot is read-only** (Stream: a raw write is
  overwritten).
- **The element as a well-behaved React 19 component.** Rich data goes
  through properties, primitives through attributes, and events as
  lowercase `CustomEvent`s (`liagent-message`, `liagent-send`). Nothing
  touches `window` or `customElements` at import.
- **Accessibility stays in the element by default.** aria-live is set for
  replies and pairing prompts. The core emits an `announce` event, so a
  custom UI can give the same cues (Downshift v9 removed its live-region
  helpers and left that work to every user).
- **One package, with subpath exports, released together.** That way the
  core and the adapters never drift apart (Sendbird), and the headless
  entry is plain to find (CopilotKit's is not).
- **No `asChild`, render props or compound components.** Plain functions
  in the core, and slots and CSS parts on the element (Radix's Slot broke
  under React 19 and RSC).
- **`useSyncExternalStore` is fine for us, for now.** liagent sends whole
  lines. If we stream partial replies later, the core throttles message
  notifications and never throttles status (AI SDK #18525, #21874).

## Steps and estimates (agent time)

| #   | Step                                                                                                                | Agent time |
| --- | ------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | `liagent/core`: `createChat`, the snapshot, actions, events, the outbox; unit tests with a fake transport and clock | ~2 h       |
| 2   | `hubTransport` from client.ts; `connectHub` re-implemented on it; the hub tests stay green                          | ~1 h       |
| 3   | `ChatBox` reads from `chat` (state rules removed from box.ts); the demo checked in a browser                        | ~1.5 h     |
| 4   | `createDraft` / `bindDraft`, `connectVoice`                                                                         | ~1 h       |
| 5   | `liagent/react` hooks, `examples/headless`, HubChat rewritten, docs/headless.md, README, SKILL                      | ~1.5 h     |
| 6   | Release (0.2.0: new entries, no breaking change)                                                                    | ~0.5 h     |

About 7.5 agent hours in all, as a few PRs: 1–3 (core, no API change for
current users), then 4–5, then the release.

## Questions for the owner

1. **Name.** Is `liagent/core` with `createChat` OK? (Alternatives:
   `liagent/headless`, `createSession`.)
2. **React hooks in the package** (`liagent/react`, react as an optional
   peer), or only as an example to copy, the way `LiagentChat.tsx` is today?
   I recommend shipping it, since hooks are what was asked for.
3. **Gate `allow()` on user activation?** I recommend yes, with an opt-out.
4. **Voice and mic in the core snapshot**, or kept as their own stores, as now?
   I recommend keeping them separate and linking them with `connectVoice`.
