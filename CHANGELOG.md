# Changelog

## Unreleased

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
