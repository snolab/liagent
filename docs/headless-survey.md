# Survey: how headless libraries split logic from UI, and what went wrong

This is the background for [headless-plan.md](headless-plan.md), from web
research on 2026-11-02. **[V]** means checked against the source URL or the
upstream code. **[R]** means recalled, and not re-checked.

## Library by library

**Vercel AI SDK `useChat`, the closest to us.**

- **The split [V].** `AbstractChat` in the core `ai` package owns all the
  logic: the status (`submitted | streaming | ready | error`), a serial job
  queue for send, regenerate and tool output, and the transport. Each
  framework supplies only a `ChatState`. React's keeps separate listener
  sets for messages, status and error, and replaces arrays immutably. Vue
  and Svelte get a `Chat` class, not a hook.
- **v4 → v5 churn [V].**
  - `api` and `headers` moved into `new DefaultChatTransport()`.
  - The hook stopped managing the input ("manage input state manually").
  - `content` became `parts[]`.
  - `append` became `sendMessage`, `reload` became `regenerate`, and
    `isLoading` became `status`.
  - The tool states were renamed.
  - Sharing state by `id` gave way to passing a `Chat` instance.
  - Teams budgeted 3–5 days for the move, and converted stored v4
    messages when reading them.
- **Pitfalls, from the commit log [V].**
  - Stale closures in callbacks and the transport (#8985, #16546). The
    hook now keeps the latest options in a ref.
  - Snapshots published on every streamed token cost too much render work,
    so they are now throttled (#18525, #16887).
  - It moved off `useSyncExternalStore`, because synchronous streamed
    updates starved App Router navigation (#21874).
  - Status is never throttled, so "ready" can't render next to stale
    messages.
  - It aborts a stream when the chat id changes (#20654), and dedupes
    stream resume across shared instances (#21679).
  - Chat ids are created lazily, so React can prerender (#23415).
  - It resumes streams after a backgrounded page comes back (#22035).
  - With `resume: true`, `stop()` only disconnects: the maintainers call
    the two "not compatible" (#8390).

**assistant-ui [V].** A runtime layer sits under the primitives.
`LocalRuntime` owns the messages, given a model adapter.
`ExternalStoreRuntime` lets you own the array and pass `onNew`, `onEdit`
and `onReload`; features switch on according to the callbacks you give.
The primitives are Radix-style compound components [R].

**CopilotKit [V].** `useCopilotChatHeadless_c` returns `{messages,
sendMessage, isLoading}`. Its docs disagree on whether the headless tier
needs a licence, and the import paths differ between `react-core` and
`react-core/v2`. Lesson: a headless tier and its import paths must be
plain.

**Stream Chat [V].** The core client is not reactive. The React SDK syncs
client events into state, and newer versions use a `StateStore` with
`getLatestValue()` and `subscribeWithSelector()` (keys compared with
`Object.is`). Pitfalls they document:

- A selector that builds a new array always looks changed.
- An unstable selector unsubscribes and resubscribes on every render.
- Optimistic messages live only in the React SDK.
- A raw `next()` write is overwritten: change state through methods.

**Sendbird [R].** The core SDK and the UIKits have separate release
trains, and version mismatches are a recurring support topic.

**TanStack Table [V].** In v8 the adapters called `table.setOptions` on
every render. This hid dependencies from the framework, served stale cells
under React Compiler, and re-rendered the whole table on any change. v9
moves to per-feature atoms, read through `useSelector`.

**TanStack Query [V].**

- Structural sharing keeps references stable, for JSON data only.
- Tracked props re-render only on the fields that are read; rest
  destructuring defeats it.
- Adapters move in lockstep with the core [R].

**Downshift [V].** Prop getters (`getInputProps(userProps)`) merge the
handlers and ARIA attributes.

- v7 was a breaking release driven entirely by accessibility (ARIA 1.2).
- v8 tightened the getter types and replaced `disabled` with
  `isItemDisabled`.
- v9 removed the aria-live helpers, which left that work to its users.
- Its `stateReducer` with action `type` strings is a good extension point,
  but renaming those types is itself a breaking change.

**React Aria / React Stately [V].** Three layers:

1. State, with no platform assumptions (React Native uses it directly).
2. Behaviour and ARIA, which call methods on the state.
3. Components that render.

Headless UI v2 adopted its interaction hooks.

**Headless UI v2 [V].** State moved to `data-*` attributes, anchoring
moved to Floating UI, and default elements changed (Transition went from a
Fragment to a `div`). Behaviour and DOM defaults changed in a major
release.

**Radix [V].** Compound components plus `asChild` / Slot, built on
`cloneElement`. `asChild` rendered nothing under RSC (#3542), React 19's
`props.ref` forced changes to Slot, and `cloneElement` is a legacy API
(#2934).

**Zag.js / Ark UI [V].** A state machine, then `connect(service,
normalizeProps)` returns prop objects, normalized per framework. Its
adapter checklist:

- controlled and uncontrolled values stay in sync;
- no duplicate listeners, and no stale props;
- no DOM access during SSR;
- the events are tested;
- the framework is a peer dependency.

**Web Components and React [V].** React 19 passes Custom Elements
Everywhere: a prop is set as a property when the element has one, else as
an attribute. Under SSR only primitive props render, as attributes.
`@lit/react` maps events explicitly.

**Lexical [V].** `createHeadlessEditor()` runs without a DOM, and its
DOM-only methods throw.

## What liagent takes from them

1. **One session object owns the behaviour**, as `AbstractChat` does: the
   socket, status, messages, pairing and busy. Adapters only bridge
   snapshots, and `<liagent-chat>` is the first user of the public API,
   with no back doors.
2. **An immutable snapshot plus `subscribe`.** The same reference until
   something changes, and stable references per slice (the `messages`
   array changes only when messages do), so selectors work. This avoids
   the "getSnapshot should be cached" loop.
3. **`useSyncExternalStore` suits whole messages, not streams.** liagent
   sends whole lines today, so it is fine. If partial text streaming is
   added, throttle message notifications in the core, and never throttle
   status (AI SDK #21874, #18525).
4. **Never capture config at construction.** Use getter functions or
   `setOptions()`, and have adapters keep the latest callbacks in a ref
   (three stale-closure fixes in the AI SDK).
5. **An idempotent lifecycle.** StrictMode, and a custom element moved in
   the DOM, mount, unmount and mount again. `start()` must be safe to call
   twice, and teardown is deferred by a microtask, so a quick re-mount
   keeps the socket.
6. **An explicit status union**, with busy derived from heartbeat times
   in the core, not in the UI.
7. **The transport behind an interface**, so the tests use an in-memory
   hub.
8. **Reconnect on `visibilitychange` and `pageshow`**, because iOS freezes
   background sockets. Make the clock and timers injectable for tests.
9. **Freeze the message schema early.** A v4 → v5-style `content` →
   `parts` move is the most expensive kind of churn. Optimistic messages
   (`sending | sent | failed`) belong in the core, not only in one UI.
10. **Change state only through actions.** The snapshot is read-only.
11. **The draft and IME rules as a small controller in the core.** The
    element wires the DOM events to it. A prop-getter helper can come
    later; the ARIA attributes it would return are part of the API.
12. **Accessibility defaults ship in the element**: aria-live for replies
    and pairing prompts. The core exposes an `announce` event, so custom
    UIs get the same cues.
13. **The element plays well with React 19.** Rich data goes through
    properties, and only primitives through attributes. Events are
    lowercase `CustomEvent`s (`liagent-message`). Nothing touches `window`
    or `customElements` at import.
14. **One package, with subpath exports**, versioned together. Framework
    adapters take the framework as an optional peer. This avoids the
    release drift between Sendbird's core and its UIKits, and the unclear
    import paths of CopilotKit.
15. **A small, stable surface**: plain functions in the core, and slots and
    CSS parts on the element. No `asChild` or render-prop machinery to
    break on the next React.

## Sources

- https://ai-sdk.dev/docs/migration-guides/migration-guide-5-0
- https://github.com/vercel/ai/blob/main/packages/ai/src/ui/chat.ts,
  …/packages/react/src/use-chat.ts, …/packages/react/src/chat.react.ts
  (commits #8985, #16546, #18525, #20654, #21679, #21874, #22035, #23415)
- https://ai-sdk.dev/v5/docs/troubleshooting/abort-breaks-resumable-streams
- https://atypica.ai/engineering/ai-sdk-v5-migration
- https://www.assistant-ui.com/docs/runtimes/pick-a-runtime
- https://docs.copilotkit.ai/reference/hooks/useCopilotChatHeadless_c
- https://getstream.io/chat/docs/sdk/react/guides/sdk-state-management/
- https://tanstack.com/blog/tanstack-table-v9-reactivity
- https://tanstack.com/query/latest/docs/framework/react/guides/render-optimizations
- https://github.com/downshift-js/downshift (MIGRATION_V7, V8, V9)
- https://react-spectrum.adobe.com/architecture.html
- https://tailwindcss.com/blog/headless-ui-v2
- https://github.com/radix-ui/primitives/issues/3542, …/pull/2934
- https://zagjs.com/guides/framework-adapters
- https://custom-elements-everywhere.com/
- https://lexical.dev/docs/concepts/headless
