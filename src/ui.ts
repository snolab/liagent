// liagent/ui: the box's pure building blocks, no DOM needed, each tested in
// test/. Hosts that draw their own chat (React, Svelte…) can share them.
//
//   tree-nav       the tree view's reducer: detents, accordion, end-stops
//   detent         a drag quantised into levels (snap, hysteresis, rubber band)
//   float-lines    the minimized box's floating lines: dwell, fade, arrivals
//   anchor         which side of the bar the floating box hangs from
//   frontier-view  display rules for the three frontier lines
//   echo           the text-level echo guard for hands-free voice
//   speech-rate    the read-aloud speed setting
//   tap-gesture    single/double tap, drag flag, axis lock, long press
//   ui-strings     the box's and the tree's strings in Chinese

export * from "./tree-nav.ts";
export * from "./detent.ts";
export * from "./float-lines.ts";
export * from "./anchor.ts";
export * from "./frontier-view.ts";
export * from "./echo.ts";
export * from "./speech-rate.ts";
export * from "./tap-gesture.ts";
export * from "./ui-strings.ts";
