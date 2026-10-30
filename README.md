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
› next) sits under them.

Properties: `messages`, `live`, `listeners`, `sessions`, `pending`, `evalRan`,
`busy`, `guest`, `notice`, `warning`, `defaultOpen`, `placeholder`,
`treeSource`, `strings`, `voice`, `micActive`, and the avatars: `agentAvatar`
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

## The agent's CLI

```bash
export LIAGENT_HUB=https://dev.example.com/api/chat
liagent pair                 # prints a code; the user taps Allow in the box
liagent listen --to <agent>  # messages → JSON lines, and into an agent-yes agent
liagent say "On it."         # reply in the box
liagent busy --every 4 &     # the box's spinner, until your next reply
liagent eval 'document.title'  # eval hubs only; the user allows it on chosen pages
LIAGENT_TASK_PATH=/words/prefetch liagent say "warming"  # a sub-agent, shown as "/words › prefetch"
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
