# Embedding the chat box

`<liagent-chat>` is a custom element with no dependencies: one ES module,
about 25 kB minified. It renders into its own shadow root at a fixed
position, so it fits any page and any framework. This guide covers:

1. [Loading it](#1-loading-it)
2. [Plain HTML, with a hub](#2-plain-html-with-a-hub)
3. [Your own transport](#3-your-own-transport)
4. [React](#4-react), including [replacing a hand-rolled chat box](#replacing-a-hand-rolled-chat-box)
5. [Vue, Svelte, Angular, Solid and Preact](#5-vue-svelte-angular-solid-and-preact)
6. [Reference](#6-reference): properties, callbacks, attributes, theming
7. [Security notes](#7-security-notes)
8. [Voice input](#8-voice-input): `<liagent-mic>`, your STT endpoint, Silero VAD

## 1. Loading it

The module defines nothing until you call `defineChatBox()`, and it is safe
to import during server rendering: the element class only extends
`HTMLElement` when one exists.

**As a dependency** (`bun add liagent`; the hub is `liagent/hub`):

```ts
const { defineChatBox, connectHub } = await import("liagent");
```

**From a hosted `liagent.js`** (a dev server, or your own static copy): import
it at run time. Tell your bundler to leave the URL alone, and keep the URL in
a variable so it is not resolved at build time:

```ts
const src = "https://example.com/static/liagent.js";
const mod = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ src);
mod.defineChatBox();
```

A cross-origin import needs `Access-Control-Allow-Origin` on the script, and
your CSP must allow its origin in `script-src` (see [7](#7-security-notes)).
The dev server (`bun run dev`) sends `Access-Control-Allow-Origin: *` and
`no-store`, and rebuilds the bundle on every request. Reloading the page picks
up your edits.

## 2. Plain HTML, with a hub

If your site runs the hub (`liagent/hub`, see the README), `connectHub` does
everything else. It holds the socket while the page is visible, and it shows
history, live messages, pairing requests, sessions and the busy spinner. It
also reads replies aloud.

```html
<script type="module">
  const { defineChatBox, connectHub } = await import("/static/liagent.js");
  defineChatBox();
  const box = document.createElement("liagent-chat");
  box.style.setProperty("--liagent-bg", "white"); // your page colour
  document.body.append(box);
  const hub = connectHub(box, {
    url: "/api/chat", // the hub's page socket, same origin or absolute
    evalCode: false, // true: run code an approved agent sends (eval hubs)
    wanted: () => true, // e.g. only in your debug mode; call hub.update() when it changes
  });
</script>
```

`hub.close()` drops the socket for good.

The page's label, which agents see, defaults to its path plus the user agent.
Pass `label` (a string, or a function asked again after each navigation) to
change it. The tab keeps a page id in `sessionStorage` and sends it on every
reconnect, so an app switch or a reload keeps the agents allowed on it.
Client-side navigation (`history.pushState`, `replaceState`,
back/forward) is reported to the hub after 300 ms, so agents hear
`page-changed`. Pass `trackPages: false` to turn that off.

## 3. Your own transport

The box knows nothing about sockets. Give it messages and state, and take its
callbacks:

```ts
box.onSend = (text) => mySend(text); // return false if it could not go out: the draft is kept
box.messages = history; // shown, never read aloud
box.push(message); // one live message; an agent's is read aloud
box.live = true; // the connection dot
box.listeners = 1; // "agent listening (1)"
box.beat(); // one busy beat from the agent: a spinner for 12 s, or until its reply
box.pages = state.pages; // the user's open pages, and which one this is:
box.self = state.self; //   offered as checkboxes when allowing, and ended from the menu
box.onAnswer = (type, pair, { pages, scope }) => myAnswer(type, pair, pages, scope);
box.onEndPage = (id) => myEndPage(id);
```

A message is `{ id, from: "owner" | "agent" | "friend", label, text, at }`
(`"owner"` is the wire's name for the user who owns the site).
The log shows `label` for an agent and "you" for everyone else. It renders
text only and never parses HTML.

## 4. React

Copy [`examples/react/LiagentChat.tsx`](../examples/react/LiagentChat.tsx)
into your app. It is a client component (React 19) that does three things:

- loads the bundle with your `load()`;
- creates the element (so `storageKey` and `defaultOpen` are set before it
  connects);
- hands it your props as element properties on every render.

The element is fixed-positioned and the wrapper renders `display: contents`,
so where you mount it doesn't matter.

```tsx
"use client";
import { useRef } from "react";
import { LiagentChat, type LiagentChatHandle } from "./LiagentChat";

const src = process.env.NEXT_PUBLIC_LIAGENT_URL!; // or use () => import("liagent")

export function Chat(props: {
  live: boolean;
  listeners: number;
  messages: ChatMessage[];
  onSend: (t: string) => boolean;
}) {
  const chat = useRef<LiagentChatHandle>(null);
  // When a reply arrives live: chat.current?.speak(reply.text)
  return (
    <LiagentChat
      ref={chat}
      load={() => import(/* webpackIgnore: true */ /* turbopackIgnore: true */ src)}
      storageKey="myapp:chat"
      style={{ "--liagent-bg": "var(--background)" }}
      {...props}
    />
  );
}
```

[`examples/react/HubChat.tsx`](../examples/react/HubChat.tsx) is a complete
page component that owns the hub socket and renders `<LiagentChat>`. Run it
with `bun run dev` and open `/liagent/react.html`.

### Replacing a hand-rolled chat box

`<LiagentChat>` takes the same props as a typical hand-rolled
`<DebugChat>`. In the component that holds the socket:

| Before                                                                               | After                                                                        |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `import { DebugChat, speakReply } from "./DebugChat"`                                | `import { LiagentChat, type LiagentChatHandle } from "./LiagentChat"`        |
| `<DebugChat live listeners messages onSend …/>`                                      | `<LiagentChat ref={chat} load={…} live listeners messages onSend …/>`        |
| `sessions`, `onEnd`, `pending`, `onAnswer`, `evalRan`, `friend`, `notice`, `warning` | the same names                                                               |
| `speakReply(m.text)` for a live agent message                                        | `chat.current?.speak(m.text)`                                                |
| a spinner of your own                                                                | `chat.current?.beat()` on each `{type:"busy"}` from the hub                  |
| a pairing prompt with page choice                                                    | `pages={state.pages} self={state.self}`; `onAnswer(type, p, {pages, scope})` |
| ending one of the user's pages                                                       | `onEndPage={(id) => send({type: "end-page", id})}`                           |
| the default-open rule (e.g. collapsed on one route)                                  | `defaultOpen={!location.pathname.startsWith("/route")}`                      |
| per-device keys (`app:chat-open`, `-speak`, `-pos`)                                  | `storageKey="app:chat"` → `app:chat:open`, `:speak`, `:pos`                  |

The storage key layout differs, so each device starts once from the default
open state, with read-aloud on and the box at its home position.

## 5. Vue, Svelte, Angular, Solid and Preact

The rules are the same everywhere:

- **Define the element before the framework renders it.** Frameworks set a
  binding as a property only when the element already has that property.
- **Bind data as properties, not attributes:** `messages`, `pending`,
  `sessions` and the rest are arrays and objects.
- **Set the callbacks on the element itself.** Several frameworks treat any
  `on*` binding as an event listener, or refuse it outright.
- **Or use `connectHub`:** hand it the element once it is mounted, and it
  sets every property and callback itself.

Each snippet below has a complete, runnable page under `examples/<name>/`.
Run `bun run dev` and open `/liagent/examples/<name>/` for a fake agent, or
add `?hub` to use the dev hub. The pages load their framework from esm.sh
at a pinned version, so they need no build.

| Framework  | Data props                | Callbacks (`onSend`, `onAnswer`, `onEnd`)                 | Example                                             |
| ---------- | ------------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| Plain HTML | `box.messages = …`        | `box.onSend = …`                                          | [examples/html](../examples/html/index.html)        |
| React 19   | the wrapper sets them     | the wrapper sets them                                     | [examples/react](../examples/react/LiagentChat.tsx) |
| Vue 3      | `:messages.prop="…"`      | `:onSend.prop="send"`                                     | [examples/vue](../examples/vue/index.html)          |
| Svelte 5   | `{messages}`              | through `bind:this` (`on*` are events)                    | [examples/svelte](../examples/svelte/index.html)    |
| Angular    | `[messages]="messages()"` | through `@ViewChild` (`on*` bindings are refused, NG0306) | [examples/angular](../examples/angular/index.html)  |
| Solid      | `prop:messages={…}`       | `prop:onSend={send}` (`() => send` in `solid-js/html`)    | [examples/solid](../examples/solid/index.html)      |
| Preact     | `messages={…}`            | through a ref (`on*` are events)                          | [examples/preact](../examples/preact/index.html)    |

### Vue 3

Tell the template compiler that `liagent-` tags are custom elements, then
bind with `.prop`:

```ts
// vite.config.ts
vue({ template: { compilerOptions: { isCustomElement: (tag) => tag.startsWith("liagent-") } } });
// or, compiling in the browser: app.config.compilerOptions.isCustomElement = …
```

```vue
<script setup lang="ts">
import { onMounted, ref } from "vue";
import { connectHub } from "liagent";
const messages = ref([]);
const send = (text: string) => mySend(text); // true if it went out
const box = ref<HTMLElement>();
// With a hub instead: onMounted(() => connectHub(box.value, { url: "/api/chat" }));
</script>

<template>
  <liagent-chat
    ref="box"
    storage-key="myapp:chat"
    :live.prop="live"
    :messages.prop="messages"
    :pending.prop="pending"
    :onSend.prop="send"
    :onAnswer.prop="answer"
    :onEnd.prop="end"
  />
</template>
```

### Svelte 5

Data props are set as properties. Attributes named `on…` are event listeners
in Svelte 5, so set the callbacks through `bind:this`:

```svelte
<script>
  import { onMount } from "svelte";
  let box = $state();
  let messages = $state([]);
  onMount(() => {
    box.onSend = (text) => mySend(text);
    box.onAnswer = (type, pair, answer) => myAnswer(type, pair, answer);
    box.onEnd = (pair) => myEnd(pair);
    // With a hub instead: connectHub(box, { url: "/api/chat" });
  });
</script>

<liagent-chat bind:this={box} storage-key="myapp:chat" live={true} {messages} {pending} {sessions}></liagent-chat>
```

### Angular

Add `CUSTOM_ELEMENTS_SCHEMA`. Property bindings work for data, but Angular
refuses any `on*` binding (NG0306), so set the callbacks from a `@ViewChild`:

```ts
@Component({
  selector: "app-chat",
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `<liagent-chat
    #box
    storage-key="myapp:chat"
    [live]="live()"
    [messages]="messages()"
    [pending]="pending()"
    [sessions]="sessions()"
  ></liagent-chat>`,
})
export class ChatComponent implements AfterViewInit {
  @ViewChild("box") box!: ElementRef<HTMLElement & Record<string, unknown>>;
  messages = signal<ChatMessage[]>([]);
  send = (text: string) => mySend(text); // arrow fields keep `this`
  ngAfterViewInit() {
    const el = this.box.nativeElement;
    el.onSend = this.send;
    el.onAnswer = this.answer;
    el.onEnd = this.end;
    // With a hub instead: connectHub(el, { url: "/api/chat" });
  }
}
```

### Solid

Use `prop:` for everything, so each value is set as a property. In JSX,
declare the tag's props in a `declare module "solid-js"` block:

```tsx
<liagent-chat
  storage-key="myapp:chat"
  prop:live={live()}
  prop:messages={messages()}
  prop:onSend={send}
  prop:onAnswer={answer}
  prop:onEnd={end}
/>
// With a hub instead: <liagent-chat ref={(el) => onMount(() => connectHub(el, { url: "/api/chat" }))} />
```

In `solid-js/html` (no build), a function value is read as a reactive
getter: pass a callback as `prop:onSend=${() => send}`, and a signal as the
signal itself.

### Preact

Data props are set as properties. Props named `on…` are event listeners in
Preact, so set the callbacks through a ref:

```jsx
function Chat() {
  const box = useRef(null);
  const [messages, setMessages] = useState([]);
  useEffect(() => {
    box.current.onSend = (text) => mySend(text);
    box.current.onAnswer = (type, pair, answer) => myAnswer(type, pair, answer);
    box.current.onEnd = (pair) => myEnd(pair);
    // With a hub instead: connectHub(box.current, { url: "/api/chat" });
  }, []);
  return <liagent-chat ref={box} storage-key="myapp:chat" live={true} messages={messages} />;
}
```

### A note on React 19

React 19 also sets custom-element props as properties when the element has
them, and treats `on…` props as events. The wrapper in
[examples/react](../examples/react/LiagentChat.tsx) sidesteps both: it
creates the element itself and assigns every prop and callback in a layout
effect.

## 6. Reference

**Properties** (set them; each re-renders only its own part of the box):

| Property      | Type                            | Meaning                                                                                                                                                                                                                                             |
| ------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messages`    | `ChatMessage[]`                 | The log (the last 200). Replacing it never reads aloud.                                                                                                                                                                                             |
| `live`        | `boolean`                       | Connected: the green dot, and the status text.                                                                                                                                                                                                      |
| `listeners`   | `number`                        | Agents listening, in the status.                                                                                                                                                                                                                    |
| `sessions`    | `PairInfo[]`                    | Approved agents: an icon each for eval, and a line with End in the menu.                                                                                                                                                                            |
| `pending`     | `PairInfo \| null`              | A pairing request: its code, what it asks for (`chat · 30d` or `code · 8h`), Allow and ✕, plus page checkboxes for code (eval) when several pages are open; chat always covers every page. An older agent that names no scope gets `8h · chat · ✕`. |
| `pages`       | `PageInfo[]`                    | The user's open pages (the hub's `state.pages`).                                                                                                                                                                                                    |
| `self`        | `string`                        | Which of them this page is (`state.self`).                                                                                                                                                                                                          |
| `evalRan`     | `boolean`                       | Code just ran here: the eval icons pulse.                                                                                                                                                                                                           |
| `busy`        | `boolean`                       | The spinner, set by hand (`beat()` is the timed way).                                                                                                                                                                                               |
| `friend`      | `boolean`                       | A friend's page, not the user's: no chat grant offered, sessions say "preview".                                                                                                                                                                     |
| `notice`      | `string`                        | Replaces the input (say, "Chat is not available").                                                                                                                                                                                                  |
| `warning`     | `string`                        | One line above the input (say, a rate limit).                                                                                                                                                                                                       |
| `defaultOpen` | `boolean`                       | Open or collapsed on first visit. Set it before attaching.                                                                                                                                                                                          |
| `placeholder` | `string`                        | The input's placeholder.                                                                                                                                                                                                                            |
| `agentAvatar` | `string \| string[] \| Element` | The agent's avatar: your app's logo. URLs are tried in order; an element is cloned onto each line. Unset: the agent name's initial.                                                                                                                 |
| `userAvatar`  | `string \| string[]`            | The user's picture on their own lines, URLs in fallback order (your app's avatar, then the provider's `user.image`).                                                                                                                                |
| `userName`    | `string`                        | The user's name: the initial of their fallback avatar.                                                                                                                                                                                              |
| `userId`      | `string`                        | A stable id, or its hash (never an email): the fallback avatar's colour.                                                                                                                                                                            |
| `nodes`       | `string[]`                      | The state-tree nodes agents listen at (the hub's `state.nodes`): what typing `@/` offers.                                                                                                                                                           |

**Methods:**

- `push(message)`: appends one live message, deduplicated by id. An agent's
  is read aloud and ends the spinner.
- `beat()`: one busy beat. The spinner shows for 12 s unless another beat
  renews it or a reply ends it, and a beat within 1.5 s after a reply is
  ignored.
- `speak(text)`: reads text aloud if the device has read-aloud on.
- `submit()`: sends the draft now.
- `setTarget(path)`: addresses the next lines to a state-tree node
  (`"/"` = back to the main thread), shown as a removable chip; `target`
  reads it. Meant for a state tree's selection. Typing `@/words › prefetch `
  at the start of the input does the same.

**Callbacks:**

- `onSend(text, to?) → boolean`: `to` is the state-tree node the line is
  addressed to (absent = the main thread).
- `onAnswer("allow" | "deny", pair, { pages?, scope? })`: `pages` holds the
  ticked page ids, or `"all"`. `scope` is `"chat"` only when an older agent's
  prompt was answered with the 30-day chat button.
- `onEnd(pair)`: End on an agent's session in the menu.
- `onEndPage(id)`: End on one of the user's pages in the menu. Ending this
  page takes a second tap.
- `avatarFor(message) → { id?, name?, avatar? } | null`: the avatar for a
  line that is not the agent's. Its pictures are tried first, then the
  line's own `sender` (a hub may set one on each message), then, on the
  user's own lines, `userAvatar`.

**Avatars:** every line starts with an avatar (18px; `--liagent-avatar`).
Pictures load with `referrerPolicy="no-referrer"` (Google's need it) and
`loading="lazy"`, at a fixed size. One that fails to load falls through to
the next, then to the element, then to the name's initial on
`oklch(0.7 0.12 <hue>)`. The hue comes from a hash of the id, or of the
thread if there is no id, and the letter is near-black or white, whichever
contrasts more (at least 4.5:1). The avatar has `alt` / `aria-label` and a
`title` set to the name, and is hidden from screen readers, which read the
name from a visually hidden span instead.

**Attributes:**

- `storage-key`: the localStorage prefix. Default `liagent`.
- `collapsed`: the same as `defaultOpen = false`.
- `placeholder`
- `agent-avatar`, `user-avatar`, `user-name`: the same as the properties
  (read once, when attached).

**Theming** (CSS custom properties on the element):

| Variable           | Default                    | Used for                                                                               |
| ------------------ | -------------------------- | -------------------------------------------------------------------------------------- |
| `--liagent-bg`     | `Canvas`                   | The halo behind the text, and the translucent input (55%). Set it to your page colour. |
| `--liagent-fg`     | `CanvasText`               | Text                                                                                   |
| `--liagent-agent`  | `oklch(0.55 0.14 150)`     | The spinner                                                                            |
| `--liagent-avatar` | `18px`                     | Avatar size                                                                            |
| `--liagent-z`      | `40`                       | z-index                                                                                |
| `--liagent-width`  | `min(20rem, 100vw - 1rem)` | Box width                                                                              |

**Behaviour:** the header of [`src/box.ts`](../src/box.ts) covers it. When a
draft is sent is in [`src/input.ts`](../src/input.ts):

- 3 s after typing stops;
- on Enter, but not Shift+Enter, and never during IME composition;
- on Android, on the line break itself;
- at once, when dictation inserts more than 10 characters that end a sentence.

## 7. Security notes

- **Cross-site WebSocket hijacking:** `routeChat` refuses a page socket
  whose `Origin` is not the request's own origin, before it calls
  `identify`. So a site the user visits cannot open your hub's socket with
  their cookie and act as them. If your pages live on another origin than
  the hub (`app.example.com` vs `api.example.com`), list it:
  `routeChat(req, env.CHAT, { identify, allowedOrigins: ["https://app.example.com"] })`.
  Prefer `SameSite=Lax` or `Strict` session cookies too.

- **The page side is your site's call.** The hub accepts only pages that
  your `identify(req)` vouches for. An agent can do nothing until the user
  approves it in the box, on the pages they choose, after matching the
  short code its terminal shows.
- **Eval is off by default** on both ends: the hub needs `chatHub({ eval: true })`,
  and `connectHub` needs `evalCode: true`. With both on, an approved agent
  runs arbitrary code in the pages the user allowed. Keep it to debug sessions.
- **CSP:** a hosted `liagent.js` needs its origin in `script-src`, and the
  hub's socket needs it in `connect-src`. The box styles its shadow root with
  a constructed stylesheet (`adoptedStyleSheets`), which `style-src` does not
  block, so it needs no `'unsafe-inline'`. Only browsers without constructed
  stylesheets fall back to a `<style>` element.
- **Logs:** the hub logs one JSON line per event (pairings, messages,
  evals) with lengths and labels, but no message text or code, unless you
  make it with `chatHub({ logContent: true })`.
- **Prompt injection:** with `liagent listen --to <agent>`, every message is
  typed into a coding agent, and friends' messages too: any signed-in user
  can put text in front of the user's agent. Nothing reaches a shell
  (delivery goes through `ay send` with no shell in between), but the text
  is a prompt. The agent's skill (SKILL.md) treats friends' messages as
  untrusted and never acts on them beyond replying. If your site lets
  strangers sign in, consider not delivering friends' threads to an agent
  at all (run `listen` without `--to` and read the JSON lines), or keep
  the friends feature off by not identifying non-owners in `identify`.
- **Text only:** the box sets message text with `textContent`, so a message
  can never inject markup.

## 8. Voice input

`<liagent-mic>` (`liagent/mic`, also in `liagent.js`) is a mic button that
dictates into the box. One tap turns listening on, and another tap or
Escape turns it off. While it listens, a voice-activity detector (VAD) cuts
speech into utterances. Each utterance is sent to your STT endpoint as soon
as it ends, and the requests run in parallel. Transcripts land in the draft
in the order they were spoken. A long utterance (over 3 s) also sends
rolling partial chunks every 2.5 s, overlapping by 1.5 s. Their text shows
dimmed until the final transcript replaces it. A final transcript with
words in it is punctuated (`。`/`？` for CJK, `.`/`?` otherwise) and sent at
once, so a short "OK" or "好" goes out too. Partials are never sent. An
utterance is capped at 30 s; past that it is cut and sent, and listening
goes on.

```html
<liagent-chat>
  <liagent-mic slot="mic" stt-url="/api/stt" lang="en"></liagent-mic>
</liagent-chat>
<script type="module">
  const { defineChatBox, defineMic } = await import("/static/liagent.js");
  defineChatBox();
  defineMic();
</script>
```

The button hides itself where the browser cannot capture (no
`getUserMedia` or no Web Audio). It drives the closest `<liagent-chat>`, or
whatever you assign to `mic.box`.

### The STT endpoint

liagent has no speech-to-text backend. You run one, or point the mic at one
you already have. The default request is:

```
POST <stt-url>[?lang=<lang>]
content-type: audio/wav
<body: one utterance, RIFF WAV, 16 kHz, mono, 16-bit PCM>
```

- `lang` is the `lang` attribute, a hint such as `en` or `ja-JP`. With no
  `lang`, the endpoint should detect the language.
- Credentials: `same-origin` by default (your session cookie goes along).
  Set `mic.sttCredentials = "include"` for a cookie on another origin, and
  `mic.sttHeaders = { authorization: "Bearer …" }` for a token.
- Partial chunks are separate requests of the same shape, often one every
  2.5 s while someone talks, so budget your rate limit for them.

It answers JSON:

```json
{ "text": "Fix the swipe please.", "model": "whisper-large-v3-turbo", "ms": 412, "language": "en" }
```

Only `text` is read (a missing `text` counts as silence). The other fields
reach `mic-utterance` listeners only if you use your own `mic.stt`. Errors
are non-2xx statuses with an optional `{ "error": "message" }`:

| Status | The mic                                                                      |
| ------ | ---------------------------------------------------------------------------- |
| 401    | turns listening off; the note says "Sign in to use the mic"                  |
| 429    | keeps listening; the note says to try again; partials stop until the next on |
| other  | keeps listening; that utterance is skipped ("Transcription failed (502)")    |

A minimal endpoint on Cloudflare Workers AI:

```ts
// POST /api/stt: authenticate and rate limit first, as for any paid route.
const audio = new Uint8Array(await req.arrayBuffer());
if (!audio.byteLength || audio.byteLength > 5_000_000) return new Response(null, { status: 413 });
const lang = new URL(req.url).searchParams.get("lang") ?? undefined;
let bin = "";
for (const b of audio) bin += String.fromCharCode(b);
const out = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
  audio: btoa(bin),
  ...(lang ? { language: lang.split("-")[0] } : {}),
});
return Response.json({ text: out.text ?? "", language: out.transcription_info?.language });
```

Speaking another protocol (multipart, an SDK, a socket) is a function
instead of a URL:

```ts
import { SttError } from "liagent/mic";

mic.stt = async (wav, { partial, durationMs }) => {
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");
  form.append("model", "whisper-1");
  const r = await fetch("/api/openai-proxy/audio/transcriptions", { method: "POST", body: form });
  if (!r.ok) throw new SttError(r.status, await r.text()); // 401 and 429 act as above
  return (await r.json()).text; // a string, or { text, … }
};
```

Keep provider keys on your server: proxy the request, never put a key in
the page.

### Silero VAD (optional)

Out of the box an energy threshold cuts the utterances. It works anywhere
and needs nothing, but noise can fool it. For a real VAD, hand over Silero
([`@ricky0123/vad-web`](https://github.com/ricky0123/vad)). liagent never
imports it itself, so it stays out of your bundle until the mic is first
turned on.

```ts
// From your bundle (bun add @ricky0123/vad-web onnxruntime-web), serving their assets:
mic.vad = {
  load: () => import("@ricky0123/vad-web"),
  baseAssetPath: "/vad/", // silero_vad_v5.onnx, vad.worklet.bundle.min.js
  onnxWASMBasePath: "/ort/", // onnxruntime-web's *.wasm
  options: { positiveSpeechThreshold: 0.5 }, // any other MicVAD option
};
```

Or load the UMD builds by `<script>` from pinned URLs:

```html
<liagent-mic
  slot="mic"
  stt-url="/api/stt"
  vad-src="https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/"
  ort-src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/"
></liagent-mic>
```

If Silero fails to load (blocked wasm, an offline CDN, a CSP refusal), the
mic falls back to the energy gate. A refused microphone is reported, and
the fallback is not tried. With a CSP, allow the asset origin in
`script-src` and `connect-src`, and add `'wasm-unsafe-eval'`.

### The box contract (`DictationTarget`)

The mic types into anything with this shape. `<liagent-chat>` is one, and
your own input can be another:

```ts
interface DictationTarget {
  readonly draft: string; // read before each transcript is appended
  setDraft(next: string, opts?: { source?: "stt" }): void; // the dictated draft
  setPartial(text: string | null): void; // dimmed live text after the draft; null = none left
  submit(): boolean | void; // send now; false = it did not go out
  micActive: boolean; // set while listening: no send by the typing debounce meanwhile
}
```

To handle transcripts yourself instead, listen for `mic-text` and call
`preventDefault()`. `dictate(target, text)` and `appendDictation(draft, text)`
are exported for that.

### Reference

| Attribute / property             | Meaning                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| `stt-url` / `sttUrl`             | The STT endpoint (above).                                                                     |
| `lang` / `lang`                  | The language hint (`?lang=`).                                                                 |
| `.stt`                           | `(wav, info) => Promise<string \| { text }>`, used instead of `stt-url`.                      |
| `.sttHeaders`, `.sttCredentials` | For the default request.                                                                      |
| `vad-src`, `ort-src` / `.vad`    | Silero's source (above). None: the energy gate.                                               |
| `aec`                            | `off`: no echo-cancelled barge-in; capture is held while the agent speaks (with a voice).     |
| `tick`                           | A soft two-tone tick when a spoken sentence is sent (Web Audio; silent on a muted iPhone).    |
| `storage-key`                    | The sessionStorage key of the reload flag (`liagent:mic`), read when the session is made.     |
| `.box`                           | The `DictationTarget` (default: the closest `<liagent-chat>`).                                |
| `.voice`                         | A `MicVoiceLink`: a voice output that reads replies hands-free (ducking, barge-in, the echo). |
| `.strings`                       | The labels and error notes (`MIC_STRINGS_EN` lists them), e.g. translated.                    |
| `.session`                       | The page's mic session: `view()`, `toggle()`, `off()`, `subscribe(f)`.                        |

Events (they bubble and cross shadow roots):

| Event           | `detail`                                                                        |
| --------------- | ------------------------------------------------------------------------------- |
| `mic-state`     | `{ state: "off" \| "loading" \| "listening" \| "capturing", status }`           |
| `mic-text`      | `{ text }`: a final transcript, before it is typed; cancelable                  |
| `mic-sent`      | `{ text }`: a spoken sentence went out                                          |
| `mic-error`     | `{ error, note }`                                                               |
| `mic-resume`    | `{ path: "auto", ok: true, permission }` or `{ path: "tap", reason }`           |
| `mic-utterance` | `{ wav, seq, durationMs, text, echo? }`: each final utterance, if you keep them |

**One session per page.** The stream, the VAD and the transcripts still in
flight live on `globalThis`, not in the element. Removing the element,
re-rendering it, or loading a second copy of the module re-attaches to the
same session and keeps listening. Only a tap, Escape or `mic.session.off()`
stops it. Transcripts that arrive while no element is attached are handed
to the next one.

**Reloads.** While the mic is on, the tab keeps `liagent:mic` in
sessionStorage. After a reload it resumes without a gesture when the
microphone permission is granted (or cannot be queried, as on iOS) and audio
can start. Otherwise the button shows a dashed ring and "Tap to resume
listening". Either way it fires `mic-resume`.

**Privacy.** Audio goes only to the endpoint you configure, one utterance at
a time. Nothing is recorded while the mic is off. The button shows a red
ring and REC while it captures.
