# Changelog

## Unreleased

### Added

- **`liagent reply`.** A say that first polishes the line it answers:
  `liagent reply --id <msgId> --polish "…" "reply"` edits that line (as
  `liagent edit <msgId>` would), then posts the reply. `--polish` always
  needs `--id`, never "the latest line", and never goes with a friend's
  `--to`; a polish the hub refuses is reported and the reply still goes out.
  `listen --to`'s header now says `liagent reply …`, with `--id <id>
  [--polish "..."]` on the user's own voice (stt) lines only.
- **`beforesend` on the box.** A cancelable `beforesend` event fires just
  before `onSend` with `{ text, to, source, context, attachments, extra }`.
  Listeners add fields to `detail.extra` (several compose); they go out as
  the chat line's `ctx`, a plain JSON object of at most `MAX_CTX` (4000)
  characters, checked by `cleanCtx` and kept by `parsePageMessage` and the
  hub. `preventDefault()` keeps the draft unsent. `chat.send()` takes
  `ctx` too. `liagent listen --to` delivers it after the text as
  `[page ctx (set by the page's script, not by the user): {…}]`, in the
  spilled file too. No listener: the same message as before.

- **Links in messages.** http(s) URLs in a line's text (also polished/raw
  text) become links, built as DOM nodes (`linkify`, `src/linkify.ts`).
  Other origins open in a new tab with `rel="noopener noreferrer"`; the
  page's own origin stays in the tab. Trailing `.,;:!?)]}` and quotes stay
  outside (balanced parens stay in); links stop at 、。）」』】 and U+3000.
  Links take clicks although the log is `pointer-events: none`, and a press
  on one does not move focus.
- **Box style hooks.** The bar is exposed as `part="bar"`;
  `--liagent-bar-radius-top` and `--liagent-bar-radius-bottom` set its top
  and bottom corner radii (default: the round bar as before); the host
  element reflects its layout as `[open]` or `[min]`.
- **Files in the chat.** `box.files` takes the host's file handling
  (`ChatFiles`: `upload(file, onProgress, signal)` → `{id, name, type, size}`,
  `url(ref)`, and optionally `maxBytes`, `list()`, `remove(id)`,
  `actions(ref)`). Files pasted into the input, dropped anywhere on the box
  (an overlay takes the drop) or picked with an upload action
  (`fileAction()` / `mediaAction()` without `upload`, or any action with
  `upload: true` and `accept`) show as chips over the input with a
  thumbnail or extension, size, progress and ×. A send waits for running
  uploads; files alone go out with their names as the text. Sent lines
  carry `attachments` (refs, never bytes) and show them from `url(ref)`:
  raster images inline, the rest as download links, with the host's
  actions. With `list`, the + menu has a Files panel: usage, rows, a
  confirmed Delete. `box.addFiles()` and `host.addFiles()` feed files in.
  `memoryFiles()` is an in-memory host for demos and tests; liagent ships
  no storage.
- **`attachments` on the wire.** `{type:"chat", …, attachments}`;
  `cleanAttachments` / `cleanFileName` on the hub (at most 10, checked ids,
  names without folders, control or bidi characters), kept on owner lines
  only; `liagent listen --to` delivers one `[attached: file …]` line each.
  `onSend` gets them in `opts.attachments`; `connectHub` sends them.
  New strings: `attachDrop`, `attachUploading`, `attachFailed`,
  `attachTooBig`, `attachFileRemove`, `files`, `filesEmpty`, `filesUsage`,
  `filesUsageQuota`, `filesFailed`, `filesProcessed`, `filesDelete`,
  `filesDeleteConfirm`, `filesKeep`, `filesClose`.

### Changed

- **No text on the mic.** The "REC" under the icon while capturing is gone:
  the ring shows the state, and while capturing it pulses (opacity and a
  slight scale about its own centre, so it stays concentric). Under
  `prefers-reduced-motion` it holds still, 3px instead of 2px. A polite live
  region says Listening / Agent speaking for screen readers (`micLive`).
  `MicStrings.rec` is removed; `liveListening` and `liveSpeaking` are new.

- **One frame while typing.** While the typing glass is up it is the frame,
  so the bar's own box is no longer drawn inside it: its border turns
  transparent (the width stays, so nothing moves), its tint and blur go, and
  it fades with the glass; at rest the border is back. Inside the glass the
  "@/" node list is plain rows and the attached chip keeps only its rail. The
  - menu drops its border (its shadow is its edge).

## 0.2.0 (2026-11-03)

### Added

- **The + menu and a slot-based bar.** `box.actions` takes the host's
  `ChatAction`s, each placed in the + menu (`place: "menu"`, the default) or
  as a bar button at the start (`"leading"`) or end (`"trailing"`). An action
  does something (`onSelect`) or attaches something to the next line
  (`attach`). Built-in, optional providers: `selectionAction()` (the page's
  last selection outside the box, sensitive fields fenced, 2000 chars at
  most, 30 min), `fileAction({ upload })` and `mediaAction({ upload })` (the
  host uploads; liagent carries the result).
- `treePlacement` / `tree-placement` (`"leading" | "menu" | "hidden"`) and
  `micPlacement` / `mic-placement` (`"trailing" | "leading" | "inside" |
  "hidden"`).
- **A line's `context` on the wire:** `{type:"chat", …, context}` with
  `{selection?, path?, title?, host?, files?}`, cleaned by `cleanContext`
  (known keys, each bounded; file URLs http(s) or same-origin only), kept on
  the `ChatMessage`, passed to agents, and delivered by `liagent listen --to`
  after the text as quoted data. `onSend` gets it as `opts.context`;
  `connectHub` sends it. The box shows it as a chip before sending and as a
  quote over the sent line.
- **Geometry from variables:** `--liagent-control`, `--liagent-bar-border`,
  `--liagent-bar-pad`; the bar's corner radius is derived
  (`border + padding + control / 2`), so the mic stays concentric with its
  corner at any size. The mic takes `--liagent-mic-fg`, `--liagent-mic-bg`,
  `--liagent-mic-icon`.
- **Typing glass:** while the input has the focus, the box's own area gets a
  frosted backdrop; the rest of the page stays sharp.
- **Echo cancellation switch:** `applyAec(on)` (also in the box's menu when a
  mic is in it) writes the per-device switch and reopens an open mic at once
  (`MicSession.reopen()`). `pageAudio()` lets a host register its own sounds:
  with echo cancellation off, capture is held while they play
  (`MicSession.setPageHold`).

### Changed

- Echo cancellation off now turns off all processing
  (`echoCancellation`, `noiseSuppression` and `autoGainControl` all false);
  `LEGACY_CONSTRAINTS` is an alias of the new `RAW_CONSTRAINTS`.
- `MIC_SESSION_V` is 2 (a session from an older copy is migrated, its stream
  kept).

### Fixed

- A log at its newest line stays there when it or the input changes size
  (the keyboard, a growing draft, a panel); the re-pin's own scroll no longer
  counts as leaving the end.
