// <liagent-mic>: the mic button, a framework-free custom element. One tap
// turns listening on, another (or Escape) off. Each utterance the VAD cuts is
// sent to the host's STT endpoint at once and its transcript lands in a chat
// box's draft, in the order spoken; a final with words is punctuated and sent
// at once (appendDictation, src/mic.ts). Partial transcripts of a long
// utterance show dimmed meanwhile.
//
//   import { defineMic } from "liagent/mic";
//   defineMic();                                   // registers <liagent-mic>
//
//   <liagent-chat>
//     <liagent-mic slot="mic" stt-url="/api/stt"></liagent-mic>
//   </liagent-chat>
//
// The box it drives is the closest <liagent-chat>, or `mic.box` (anything
// with the DictationTarget shape below). Without one, transcripts are only
// announced as `mic-text` events.
//
// The mic is one session per page (src/mic-session.ts): the element can be
// removed and added again, or re-rendered by a framework, and listening goes
// on. A reload with the mic on resumes it without a tap when the permission
// is granted; else the button shows "Tap to resume listening".
//
// Attributes / properties:
//   stt-url / sttUrl      the STT endpoint (POST, 16 kHz mono WAV body; JSON {text})
//   lang / lang           a language hint, sent as ?lang= (none: detected)
//   vad-src, ort-src      vad-web's and onnxruntime-web's dist URLs (Silero VAD by <script>)
//   storage-key           sessionStorage key of the reload flag (default "liagent:mic")
//   aec                   "off": no echo-cancelled barge-in (capture held while the agent speaks)
//   tick                  a soft tick when a spoken sentence is sent (off by default)
//   .stt                  (wav, info) => Promise<{text} | string>, instead of stt-url
//   .sttHeaders, .sttCredentials   for the default STT request
//   .vad                  Silero's source: () => import("@ricky0123/vad-web"), or a VadConfig
//   .box                  the DictationTarget to type into
//   .voice                a MicVoiceLink (liagent/voice's session) for hands-free replies
//   .strings              the labels and notes, e.g. translated
//
// Events (bubbling, composed): mic-state {state, status}, mic-text {text}
// (cancelable: preventDefault keeps it out of the box), mic-sent {text},
// mic-error {error, note}, mic-resume (a ResumeOutcome), mic-utterance
// {wav, durationMs, text, echo} for each final utterance.
//
// Theming: --liagent-fg, --liagent-mic-rec (capturing; a red), --liagent-mic-talk
// (the agent speaking; a blue).

import {
  type MicErrorStrings,
  type MicState,
  type MicStatus,
  MIC_ERROR_STRINGS_EN,
  type SttResult,
  type UploadInfo,
  appendDictation,
  micErrorNote,
  micStatus,
  postStt,
  scheduleTick,
} from "./mic.ts";
import {
  type MicDeps,
  type MicSession,
  type MicView,
  type MicVoiceLink,
  type ResumeOutcome,
  type Utterance,
  MIC_ON_KEY,
  MIC_SESSION_KEY,
  micSession,
} from "./mic-session.ts";
import {
  type VadSource,
  audioCtx,
  canCapture,
  energyVad,
  existingCtx,
  micStream,
  sileroVad,
  vadFromScripts,
} from "./mic-audio.ts";

export * from "./mic.ts";
export * from "./mic-session.ts";
export * from "./mic-audio.ts";

/**
 * What the mic types into: `<liagent-chat>` has this shape, and so can any
 * host's own input. The mic reads `draft`, writes the dictated draft with
 * `setDraft(next, { source: "stt" })`, shows partial transcripts with
 * `setPartial(text)` (null: none left), sends with `submit()` when a spoken
 * sentence is complete (false: it did not go out), and sets `micActive` while
 * it listens (a box should not send by its typing debounce meanwhile).
 */
export interface DictationTarget {
  readonly draft: string;
  setDraft(next: string, opts?: { source?: "stt" }): void;
  setPartial(text: string | null): void;
  submit(): boolean | void;
  micActive: boolean;
}

/** Is `x` something the mic can type into? */
export const isDictationTarget = (x: unknown): x is DictationTarget =>
  !!x &&
  typeof (x as DictationTarget).setDraft === "function" &&
  typeof (x as DictationTarget).setPartial === "function" &&
  typeof (x as DictationTarget).submit === "function";

/**
 * One final transcript into the target: appended to its draft, punctuated,
 * and sent at once when it ends a sentence with words in it. True if it went
 * out.
 */
export function dictate(box: DictationTarget, text: string): boolean {
  const r = appendDictation(box.draft ?? "", text);
  if (r.draft === box.draft) return false;
  box.setDraft(r.draft, { source: "stt" });
  return r.send && box.submit() !== false;
}

/** The STT call the element makes: the host's own, or a POST to `stt-url`. */
export type SttHandler = (wav: Uint8Array, info: UploadInfo) => Promise<SttResult | string>;

/** What the element hands the page's session (src/mic-session.ts). */
export type MicConfig = {
  stt?: SttHandler;
  vad?: VadSource;
  aec: boolean;
  onUtterance?: (u: Utterance) => void;
};

export type MicStrings = MicErrorStrings & {
  dictate: string;
  resume: string;
  speaking: string;
  recording: string;
  listening: string;
  rec: string;
  noStt: string;
};
export const MIC_STRINGS_EN: MicStrings = {
  ...MIC_ERROR_STRINGS_EN,
  dictate: "Dictate: listen and type what you say",
  resume: "Tap to resume listening",
  speaking: "Agent speaking; tap to interrupt and talk",
  recording: "Recording; tap to stop listening",
  listening: "Listening; tap to stop",
  rec: "REC",
  noStt: "No STT endpoint: set stt-url",
};

/** The button's label for a view. */
export function micLabel(
  v: Pick<MicView, "state" | "resume">,
  status: MicStatus,
  t: MicStrings = MIC_STRINGS_EN,
): string {
  if (v.state === "off") return v.resume ? t.resume : t.dictate;
  if (status === "speaking") return t.speaking;
  return v.state === "capturing" ? t.recording : t.listening;
}

class NoStt extends Error {
  constructor() {
    super("no STT endpoint");
    this.name = "NoStt";
  }
}

/** The browser side of the page's session, made by the first element to connect. */
function browserDeps(storageKey: string): MicDeps<MicConfig> {
  const ss = () => globalThis.sessionStorage;
  return {
    getStream: (c) => micStream(c?.aec ?? true),
    load: (ev, s, c) =>
      c?.vad ? sileroVad(ev, s as MediaStream, c.vad) : Promise.reject(new Error("no VAD source")),
    fallback: (ev, s) => energyVad(ev, s as MediaStream),
    upload: async (wav, info, c) => {
      if (!c?.stt) throw new NoStt();
      const r = await c.stt(wav, info);
      return typeof r === "string" ? r : (r.text ?? "");
    },
    onState: (s) => {
      // Off, and nothing being read: let the device sleep its audio.
      const g = globalThis as unknown as Record<string, MicSession<MicConfig> | undefined>;
      const speaking = g[MIC_SESSION_KEY]?.view().speaking ?? false;
      if (s === "off" && !speaking)
        void existingCtx()
          ?.suspend()
          .catch(() => {});
    },
    onUtterance: (u, c) => c?.onUtterance?.(u),
    storage: {
      get: (k) => ss().getItem(k),
      set: (k, x) => ss().setItem(k, x),
      remove: (k) => ss().removeItem(k),
    },
    storageKey,
    permission: async () => {
      const p = await navigator.permissions?.query({ name: "microphone" as PermissionName });
      return (p?.state as "granted" | "denied" | "prompt" | undefined) ?? "unknown";
    },
    resumeAudio: async () => {
      const c = audioCtx();
      if (!c) return false;
      if (c.state === "running") return true;
      // Without a gesture this may never settle: give it a moment.
      await Promise.race([c.resume().catch(() => {}), new Promise((r) => setTimeout(r, 800))]);
      return (c.state as string) === "running";
    },
  };
}

/** Phosphor "microphone" (MIT, (c) 2023 Phosphor Icons), regular and fill. */
const MIC_PATH = {
  regular:
    "M128,176a48.05,48.05,0,0,0,48-48V64a48,48,0,0,0-96,0v64A48.05,48.05,0,0,0,128,176ZM96,64a32,32,0,0,1,64,0v64a32,32,0,0,1-64,0Zm40,143.6V240a8,8,0,0,1-16,0V207.6A80.11,80.11,0,0,1,48,128a8,8,0,0,1,16,0,64,64,0,0,0,128,0,8,8,0,0,1,16,0A80.11,80.11,0,0,1,136,207.6Z",
  fill: "M80,128V64a48,48,0,0,1,96,0v64a48,48,0,0,1-96,0Zm128,0a8,8,0,0,0-16,0,64,64,0,0,1-128,0,8,8,0,0,0-16,0,80.11,80.11,0,0,0,72,79.6V240a8,8,0,0,0,16,0V207.6A80.11,80.11,0,0,0,208,128Z",
};

const CSS = `
:host {
  position: relative; display: inline-flex; flex-shrink: 0;
  color: var(--liagent-fg, CanvasText);
  --rec: var(--liagent-mic-rec, oklch(0.6 0.22 25));
  --talk: var(--liagent-mic-talk, oklch(0.62 0.14 250));
}
:host([hidden]) { display: none; }
button {
  all: unset; box-sizing: border-box; position: relative; cursor: pointer;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  width: 40px; height: 32px; border-radius: 999px; font-size: 16px; line-height: 1;
  color: color-mix(in oklch, currentColor 55%, transparent); touch-action: none;
  -webkit-tap-highlight-color: transparent;
}
button::after { content: ""; position: absolute; inset: -4px 0; }
button::before {
  content: ""; position: absolute; inset: 2px 6px; border-radius: 999px; pointer-events: none;
}
button:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }
button[data-state="loading"] { opacity: 0.5; }
button[data-state="listening"], button[data-state="capturing"] { color: var(--rec); }
button[data-state="listening"]::before { box-shadow: 0 0 0 2px color-mix(in oklch, var(--rec) 35%, transparent); }
button[data-state="capturing"]::before { box-shadow: 0 0 0 2px var(--rec); animation: pulse 1.2s ease-in-out infinite; }
button[data-status="speaking"] { color: var(--talk); }
button[data-status="speaking"]::before { box-shadow: 0 0 0 2px var(--talk); animation: pulse 2.4s ease-in-out infinite; }
button[data-resume]::before { border: 2px dashed var(--rec); }
svg { width: 1em; height: 1em; fill: currentColor; }
.rec { font-size: 8px; font-weight: 700; color: var(--rec); }
.rec[hidden] { display: none; }
.note {
  position: absolute; inset-inline-end: 0; bottom: 100%; margin-bottom: 8px;
  white-space: nowrap; font-size: 10px; pointer-events: none; color: oklch(0.6 0.17 45);
}
.note:empty { display: none; }
@keyframes pulse { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { button::before { animation: none !important; } }
`;

const Base: typeof HTMLElement =
  typeof HTMLElement === "undefined" ? (class {} as unknown as typeof HTMLElement) : HTMLElement;

const SVG = "http://www.w3.org/2000/svg";

/** The mic button. See the header for its attributes, properties and events. */
export class MicElement extends Base {
  static observedAttributes = ["stt-url", "lang", "vad-src", "ort-src", "aec"];
  /** The host's own STT call (else a POST to stt-url). */
  stt?: SttHandler;
  sttHeaders?: Record<string, string>;
  sttCredentials?: RequestCredentials;
  /** Silero VAD's source (else vad-src/ort-src; else the energy gate). */
  vad?: VadSource;
  strings: Partial<MicStrings> = {};
  private _box: DictationTarget | null = null;
  private _voice: MicVoiceLink | null | undefined;
  private _session?: MicSession<MicConfig>;
  private shadow?: ShadowRoot;
  private btn?: HTMLButtonElement;
  private path?: SVGPathElement;
  private recEl?: HTMLSpanElement;
  private noteEl?: HTMLSpanElement;
  private off: (() => void)[] = [];
  private last: { state?: MicState; status?: MicStatus; active?: boolean; error?: unknown } = {};
  private lastResume?: ResumeOutcome;

  get sttUrl(): string {
    return this.getAttribute("stt-url") ?? "";
  }
  set sttUrl(v: string) {
    if (v) this.setAttribute("stt-url", v);
    else this.removeAttribute("stt-url");
  }
  get lang(): string {
    return this.getAttribute("lang") ?? "";
  }
  set lang(v: string) {
    if (v) this.setAttribute("lang", v);
    else this.removeAttribute("lang");
  }
  get storageKey(): string {
    return this.getAttribute("storage-key") || MIC_ON_KEY;
  }
  set storageKey(v: string) {
    this.setAttribute("storage-key", v);
  }
  /** Echo-cancelled barge-in (default: on unless localStorage `liagent:voice-aec` is "0"; `aec="off"` turns it off). */
  get aec(): boolean {
    const a = this.getAttribute("aec");
    if (a === null) {
      // Unset: the device setting the voice output reads too.
      try {
        return globalThis.localStorage?.getItem("liagent:voice-aec") !== "0";
      } catch {
        return true;
      }
    }
    return a !== "off" && a !== "false" && a !== "0";
  }
  set aec(v: boolean) {
    this.setAttribute("aec", v ? "on" : "off");
  }
  /** A soft tick when a spoken sentence is sent. */
  get tick(): boolean {
    return this.hasAttribute("tick");
  }
  set tick(v: boolean) {
    this.toggleAttribute("tick", v);
  }
  /** The target; null: the closest <liagent-chat>. */
  get box(): DictationTarget | null {
    if (this._box) return this._box;
    const near = this.closest?.("liagent-chat");
    if (isDictationTarget(near)) return near;
    const host = (this.getRootNode?.() as ShadowRoot | undefined)?.host;
    return isDictationTarget(host) ? host : null;
  }
  set box(v: DictationTarget | null) {
    this._box = v;
    this.syncActive(true);
  }
  /** The voice output for hands-free replies (undefined: leave the session's as it is). */
  get voice(): MicVoiceLink | null {
    return this._session?.voice() ?? this._voice ?? null;
  }
  set voice(v: MicVoiceLink | null) {
    this._voice = v;
    this._session?.setVoice(v);
  }
  /** The page's mic session (undefined until connected where the browser can capture). */
  get session(): MicSession<MicConfig> | undefined {
    return this._session;
  }

  private get t(): MicStrings {
    return { ...MIC_STRINGS_EN, ...this.strings };
  }

  private config(): MicConfig {
    const url = this.sttUrl;
    const vadSrc = this.getAttribute("vad-src");
    const ortSrc = this.getAttribute("ort-src");
    return {
      stt:
        this.stt ??
        (url
          ? (wav) =>
              postStt(wav, {
                url,
                lang: this.lang || undefined,
                headers: this.sttHeaders,
                credentials: this.sttCredentials,
              })
          : undefined),
      vad: this.vad ?? (vadSrc && ortSrc ? vadFromScripts(vadSrc, ortSrc) : undefined),
      aec: this.aec,
      onUtterance: (u) => this.fire("mic-utterance", u),
    };
  }

  attributeChangedCallback() {
    this._session?.configure(this.config());
  }

  connectedCallback() {
    if (!canCapture()) {
      this.hidden = true;
      return;
    }
    this.build();
    const s = (this._session = micSession(browserDeps(this.storageKey)));
    s.configure(this.config());
    if (this._voice !== undefined) s.setVoice(this._voice);
    this.off.push(
      s.subscribe((v) => this.render(v)),
      s.attach({
        onText: (text) => this.onText(text),
        onPending: (n, interim) => this.box?.setPartial(n > 0 && interim ? interim : null),
      }),
    );
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && s.view().state !== "off") void s.off();
    };
    document.addEventListener("keydown", esc);
    this.off.push(() => document.removeEventListener("keydown", esc));
    // The box's input losing focus with the mic on ends a typing pause: read on.
    const box = this.box as unknown as EventTarget | null;
    if (box && typeof box.addEventListener === "function") {
      const out = () => {
        if (s.view().state !== "off") s.voice()?.resume?.();
      };
      box.addEventListener("focusout", out);
      this.off.push(() => box.removeEventListener("focusout", out));
    }
  }

  disconnectedCallback() {
    // The session goes on listening: only this element lets go of it.
    for (const f of this.off.splice(0)) f();
  }

  /** Turn listening on or off, as a tap does (call it in a gesture). */
  toggle() {
    const s = this._session;
    if (!s) return;
    if (s.view().state === "off") {
      // Made in this gesture, so iOS lets the tick (and cloud replies) play later.
      void audioCtx()
        ?.resume()
        .catch(() => {});
      s.voice()?.unlock?.();
    }
    void s.toggle();
  }

  private fire(type: string, detail: unknown, cancelable = false): boolean {
    return this.dispatchEvent(
      new CustomEvent(type, { detail, bubbles: true, composed: true, cancelable }),
    );
  }

  private onText(text: string) {
    if (!this.fire("mic-text", { text }, true)) return;
    const box = this.box;
    if (!box || !dictate(box, text)) return;
    this.fire("mic-sent", { text });
    // Sent: an interruption (the user talking, typing) is over, and the reading goes on.
    this._session?.voice()?.resume?.();
    this.playTick();
  }

  /** The soft tick, on the mic's AudioContext; never while the agent speaks. */
  private playTick() {
    const c = existingCtx();
    if (!this.tick || !c || c.state === "closed" || this._session?.view().speaking) return;
    void c.resume().then(
      () => scheduleTick(c as unknown as Parameters<typeof scheduleTick>[0]),
      () => {},
    );
  }

  private syncActive(force = false) {
    const on = (this._session?.view().state ?? "off") !== "off";
    if (!force && on === this.last.active) return;
    this.last.active = on;
    const box = this.box;
    if (box) box.micActive = on;
  }

  private build() {
    if (this.shadow) return;
    const root = (this.shadow = this.attachShadow({ mode: "open" }));
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch {
      const st = document.createElement("style");
      st.textContent = CSS;
      root.append(st);
    }
    const note = (this.noteEl = document.createElement("span"));
    note.className = "note";
    note.setAttribute("role", "alert");
    note.setAttribute("part", "note");
    const btn = (this.btn = document.createElement("button"));
    btn.type = "button";
    btn.setAttribute("part", "button");
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 256 256");
    svg.setAttribute("aria-hidden", "true");
    const path = (this.path = document.createElementNS(SVG, "path"));
    svg.append(path);
    const rec = (this.recEl = document.createElement("span"));
    rec.className = "rec";
    rec.setAttribute("aria-hidden", "true");
    btn.append(svg, rec);
    // Keeps the input's focus: the box stays open while dictating.
    btn.addEventListener("pointerdown", (e) => e.preventDefault());
    btn.addEventListener("click", () => {
      const s = this._session;
      if (!s) return;
      const v = s.view();
      // Barge in: the reading stops (it reads on later), and capture resumes at once.
      if (micStatus(v.state, v.pending, v.speaking) === "speaking" && s.voice()?.interrupt)
        return s.voice()?.interrupt?.("tap");
      this.toggle();
    });
    root.append(note, btn);
  }

  private render(v: MicView) {
    const btn = this.btn;
    if (!btn || !this.path || !this.recEl || !this.noteEl) return;
    const t = this.t;
    const status = micStatus(v.state, v.pending, v.speaking);
    btn.dataset.state = v.state;
    btn.dataset.status = status;
    btn.toggleAttribute("data-resume", v.resume && v.state === "off");
    btn.setAttribute("aria-pressed", String(v.state !== "off"));
    btn.setAttribute("aria-label", micLabel(v, status, t));
    btn.title = micLabel(v, status, t);
    this.path.setAttribute("d", v.state === "off" ? MIC_PATH.regular : MIC_PATH.fill);
    this.recEl.textContent = t.rec;
    this.recEl.hidden = v.state !== "capturing";
    const note = v.error ? (v.error instanceof NoStt ? t.noStt : micErrorNote(v.error, t)) : "";
    this.noteEl.textContent = note;
    if (v.error && v.error !== this.last.error) this.fire("mic-error", { error: v.error, note });
    this.last.error = v.error;
    if (v.state !== this.last.state || status !== this.last.status) {
      this.last.state = v.state;
      this.last.status = status;
      this.fire("mic-state", { state: v.state, status });
    }
    if (v.resumed && v.resumed !== this.lastResume) {
      this.lastResume = v.resumed;
      this.fire("mic-resume", v.resumed);
    }
    this.syncActive();
  }
}

/** Register the element (once) under `tag`. Returns the class. */
export function defineMic(tag = "liagent-mic"): typeof MicElement {
  if (typeof customElements !== "undefined" && !customElements.get(tag))
    customElements.define(tag, MicElement);
  return MicElement;
}
