# liagent

User ⇄ agent chat for any web page: a floating chat box (a framework-free
custom element), the hub it talks to, and the agent's CLI.

The CLI and the dev server need [Bun](https://bun.sh).

Status: early.

```bash
bun add liagent
```

| Import                                              | What                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `liagent`                                           | the box, `connectHub`, and the protocol (browser)                                                       |
| `liagent/box`, `liagent/client`, `liagent/protocol` | each part on its own                                                                                    |
| `liagent/ui`                                        | the box's pure parts (tree nav, detents, floating lines, echo guard…), for hosts that draw their own UI |
| `liagent/mic`                                       | `<liagent-mic>`: voice input into the box (VAD, your STT endpoint), and its pure parts                  |
| `liagent/voice`                                     | hands-free voice out: a sentence queue, barge-in, ducking, the echo guard, your TTS endpoint (optional) |
| `liagent/hub`                                       | the hub (a Cloudflare Durable Object) and `routeChat`                                                   |
| `liagent/liagent.js`                                | the standalone browser bundle, for `import()` from a URL                                                |
| `liagent` (bin)                                     | the agent's CLI (needs Bun)                                                                             |

The package has no runtime dependencies. The browser entries and the hub
use only Web APIs, so they bundle cleanly for browsers and Cloudflare
Workers. `liagent listen --to <agent>` delivers messages into an
[agent-yes](https://github.com/snomiao/agent-yes) agent with its `ay` CLI.

## The box

```js
const { defineChatBox, connectHub } = await import("https://…/liagent.js");
defineChatBox(); // <liagent-chat>
const box = document.body.appendChild(document.createElement("liagent-chat"));

// Either drive it yourself…
box.onSend = (text) => mySocketSend(text); // return false to keep the draft
box.messages = history; // shown, never read aloud
box.push(message); // live: an agent's reply is read aloud

// …or from a hub's page socket:
const hub = connectHub(box, { url: "wss://example.com/api/chat" });
```

The box is one glass bar, `[mark | tree | input … | mic]`: the mark minimizes
it (tap), opens its menu (double tap) and moves it (drag); the tree button shows
the state tree (`treeSource`) and drags sideways through its levels. Minimized,
new lines float over the bar and the tree's frontier (✓ done, ▶ in progress,
› next) sits under them. A wheel, trackpad or touch scroll over the input
scrolls the log; text that overflows the input scrolls first, then hands the
rest of the gesture on to the log.

Properties: `messages`, `live`, `listeners`, `sessions`, `pending`, `evalRan`,
`busy`, `guest`, `notice`, `warning`, `defaultOpen`, `placeholder`,
`treeSource`, `strings`, `voice`, `voicePrefer`, `quietHours`, `micActive`, and the avatars: `agentAvatar`
(set it to your app's logo), `userAvatar`, `userName`, `userId`.
Callbacks: `onSend(text, to?, { source? }) → boolean`, `onAnswer(type, pair, scope?)`, `onEnd(pair)`,
`avatarFor(message)` (a per-sender avatar).
Voice input plugs in as a child with `slot="mic"` (it lands at the bar's right
end) and drives `draft`, `setDraft(text, { source: "stt" })`, `setPartial(text)`,
`submit()` and `micActive`; see [docs/embed.md](docs/embed.md#voice-input-and-output).
Attributes: `storage-key` (localStorage prefix, default `liagent`), `collapsed`,
`placeholder`, `agent-avatar`, `user-avatar`, `user-name`, `mic-active`. Theme: `--liagent-bg`
(set it to your page colour), `--liagent-fg`, `--liagent-agent`, `--liagent-z`,
`--liagent-width`, `--liagent-avatar`.

[docs/embed.md](docs/embed.md) shows how to embed it: plain HTML, your own
transport, React, Vue, Svelte, Angular, Solid and Preact (each with a runnable
page under `examples/`), and a full reference. See the header of `src/box.ts` for the behaviour, and `src/input.ts` for when
a draft is sent.

## Voice input

```html
<liagent-chat>
  <liagent-mic slot="mic" stt-url="/api/stt"></liagent-mic>
</liagent-chat>
<script type="module">
  const { defineMic } = await import("liagent/mic");
  defineMic();
</script>
```

`<liagent-mic>` listens until tapped again. A voice-activity detector cuts
speech into utterances, each one is POSTed to **your** STT endpoint as a
16 kHz mono WAV, and the transcript lands in the box's draft. A spoken
sentence is punctuated and sent at once. liagent ships no STT backend: point
`stt-url` at one you run (the request and the JSON answer are in
[docs/embed.md](docs/embed.md#8-voice-input)), or set `mic.stt` to your own
function. Silero VAD (`@ricky0123/vad-web`) is optional and loaded only if
you hand it over (`mic.vad = () => import("@ricky0123/vad-web")`, or the
`vad-src`/`ort-src` attributes). Without it an energy gate cuts the
utterances. The mic is one session per page: it survives remounts, and a
reload with the mic on resumes listening.

## Hands-free voice

```js
const { voice } = await import("liagent/voice");
const v = voice({ tts: "/api/tts" }); // tts: optional, only for the "cloud" output
box.voice = v; // replies are read sentence by sentence
mic.voice = v; // <liagent-mic>: talk over the agent to duck it, keep talking to cut in
```

`voice()` is one session per page. It reads with the device's most natural
voice (or your TTS endpoint, `localStorage["liagent:voice-out"] = "cloud"`),
at the box's speech rate. To pick the voice, pass
`voice({ lang: "ja-JP", prefer: ["Google 日本語", "Kyoko"] })`: `lang` forces
the language (else it comes from the reply's script), and `prefer` lists
voice names to try first (exact, then substring), with the automatic pick
as the fallback. The choice is made again when the browser's voice list
changes. With the mic on, the browser's echo canceller and
a text-level echo guard keep the agent from hearing itself. See
[docs/embed.md](docs/embed.md#9-hands-free-voice).

Not every line should be spoken. A hidden page never speaks (and hiding it
stops the reading); `liagent say --quiet` lines are shown but never read;
inside the device's quiet hours only `say --loud` lines are read. Quiet
hours are on by default, 23:00–08:00 in the device's local time:

```js
box.quietHours = { on: true, from: "22:30", to: "07:00" }; // per device, under liagent:quiet-hours
```

See [docs/embed.md](docs/embed.md#quiet-lines-and-quiet-hours).

## The hub

A Cloudflare Durable Object your site hosts in its own Worker, because only
your site can say who a page belongs to:

```ts
import { chatHub, routeChat } from "liagent/hub";
export const ChatHub = chatHub({ eval: false }); // bind it as CHAT in wrangler config

export default {
  async fetch(req: Request, env: Env) {
    const chat = await routeChat(req, env.CHAT, {
      identify: (req) => mySession(req), // {userId, email, owner: is it the site's user?} | null
    });
    return chat ?? myRoutes(req, env);
  },
};
```

Pages connect to `/api/chat` (the box's `connectHub`), agents to
`/api/chat/control` (the CLI). An agent asks for a scope: **chat** (30 days,
with a resumable token of which only the hash is stored) or **eval** (an
hour of running code, only on a hub made with `{ eval: true }`). It can do
nothing until the user allows it in the box, on the pages they tick, or all
of them. Signed-in others ("friends") get their own thread, rate-limited.
The header of `src/hub.ts` has the details and the wire.

### Live progress (optional)

A second Durable Object, `ProgressHub`, keeps agents' progress reports
(latest node per id, a capped log, done nodes pruned by alarm) and pushes
them to the owner's pages, where `<liagent-state-tree>` lays them over the
markdown outline:

```ts
import { progressHub, routeProgress } from "liagent/hub";
export const ProgressHub = progressHub(); // bind as PROGRESS; root secret env.PROGRESS_TOKEN
// in fetch():
const progress = await routeProgress(req, env.PROGRESS, {
  secret: env.PROGRESS_TOKEN,
  reader: async (req) => (await mySession(req))?.owner === true, // who may watch
});
```

Writers use a bearer token: the secret, or a token scoped to one node and its
subtree (`liagent progress grant`). The header of `src/progress-hub.ts` has
the details; `liagent/progress` has the event schema and `foldProgress`.

## The agent's CLI

```bash
export LIAGENT_HUB=https://dev.example.com/api/chat
liagent pair                 # prints a code; the user taps Allow in the box
liagent listen --to <agent>  # messages → JSON lines, and into an agent-yes agent
liagent say "On it."         # reply in the box
liagent say --quiet "PR opened."  # shown, never read aloud; --loud: read even in quiet hours
liagent busy --every 4 &     # the box's spinner, until your next reply
liagent eval 'document.title'  # eval hubs only; the user allows it on chosen pages
LIAGENT_TASK_PATH=/words/prefetch liagent say "warming"  # a sub-agent, shown as "/words › prefetch"
liagent progress --agent me --path /words/prefetch --task "Prefetch" --status doing --pct 40  # live tree
```

Messages are addressed to state-tree nodes; a node's assignee (agent or
human) receives them. Sub-agents share the box, each line tagged with its
node, and the user can type `@/node …` to address one. See "Node paths" in
[SKILL.md](SKILL.md).

[SKILL.md](SKILL.md) is the agent skill: how an AI agent should pair,
listen, reply, and behave in the chat.

## Releases

`.github/workflows/release.yml`, run by hand, makes a release commit off
`main` that includes the built `dist/`, tags it `v<version>`, and keeps it on
its own branch `release/v<version>` so it stays reachable. Depend on it by
its full commit sha (the workflow's summary prints it); the tag is a
readable alias:

```bash
bun add github:snolab/liagent#261b907f888b9d2c7c95a1fd53f90d874db27226   # v0.1.0
```

A git dependency on a release commit gets the built files with no build
step. agent-yes pins one this way and ships this package as
`agent-yes/liagent`; moving to a new release is a one-line bump of that pin.
The workflow can also publish to npm (trusted publishing), off by default.

Repository owners: add a tag ruleset for `v*` that blocks updates and
deletions, so a release tag can never be moved.

## Develop

```bash
bun install
bun test
bun run typecheck
bun run dev     # http://127.0.0.1:8861/liagent/ — the demo; liagent.js rebuilt per request
                # …/liagent/?hub — the same box on a local hub (EVAL=1 for eval)
bun run build   # dist/liagent.js
```
