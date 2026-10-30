/**
 * The mic's browser pieces: the stream's constraints, the page's one
 * AudioContext, Silero VAD (@ricky0123/vad-web, loaded only when the host
 * gives a source for it) and the energy-gate fallback that needs nothing.
 *
 * liagent has no runtime dependencies, so vad-web is never imported here.
 * The host hands over a loader:
 *
 *   mic.vad = { load: () => import("@ricky0123/vad-web"),
 *               baseAssetPath: "/vad/", onnxWASMBasePath: "/ort/" };
 *   mic.vad = vadFromScripts(VAD_DIST_URL, ORT_DIST_URL);   // UMD bundles by <script>
 *
 * Without one, or when it fails to load (blocked wasm, offline CDN), the
 * energy gate (src/mic.ts energyGate) cuts the utterances instead.
 */
import { RATE, type Vad, type VadEvents, energyGate, resample } from "./mic.ts";

/** The mic with echo cancellation on (the default: the user may talk over the agent). */
export const AEC_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
} as const;
/** Echo cancellation's "off" mode: capture is held while the agent speaks; no auto gain. */
export const LEGACY_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  channelCount: 1,
} as const;
export const micConstraints = (aec = true): MediaTrackConstraints =>
  aec ? { ...AEC_CONSTRAINTS } : { ...LEGACY_CONSTRAINTS };

/** What the browser actually applied to the mic track (no device ids), for a host's debug log. */
let applied: Record<string, unknown> | null = null;
export function noteTrack(stream: { getAudioTracks(): { getSettings?(): object }[] }) {
  try {
    const s = (stream.getAudioTracks()[0]?.getSettings?.() ?? {}) as Record<string, unknown>;
    const { echoCancellation, noiseSuppression, autoGainControl, sampleRate, channelCount } = s;
    applied = { echoCancellation, noiseSuppression, autoGainControl, sampleRate, channelCount };
  } catch {
    applied = null;
  }
}
export const appliedSettings = () => applied;

/**
 * The page's one AudioContext for voice: the energy fallback records through
 * it, the send tick plays on it, and cloud replies play through it. Made on
 * the mic tap (a gesture, which iOS needs). Kept on globalThis, so every copy
 * of the module shares it.
 */
const CTX_KEY = "__liagentAudio";
type CtxHolder = Record<string, AudioContext | undefined>;
export function audioCtx(): AudioContext | null {
  const g = globalThis as unknown as CtxHolder;
  const have = g[CTX_KEY];
  if (have) return have;
  const Ctx =
    globalThis.AudioContext ??
    (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return Ctx ? (g[CTX_KEY] = new Ctx()) : null;
}
/** The AudioContext if one was made (never makes one). */
export const existingCtx = (): AudioContext | null =>
  (globalThis as unknown as CtxHolder)[CTX_KEY] ?? null;

/** The browser can capture: getUserMedia and Web Audio. */
export const canCapture = () =>
  typeof navigator !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia &&
  !!(
    globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext
  );

/** The mic stream, with the constraints for `aec`; what was applied is noted. */
export async function micStream(aec = true): Promise<MediaStream> {
  const s = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(aec) });
  noteTrack(s);
  return s;
}

/** The slice of vad-web's MicVAD the mic uses. */
export type MicVADLike = {
  start(): Promise<void> | void;
  pause(): Promise<void> | void;
  destroy(): Promise<void> | void;
};
/** vad-web's module (or its UMD global, `window.vad`). */
export type VadWebModule = {
  MicVAD: { new: (o: Record<string, unknown>) => Promise<MicVADLike> };
};
/** Hands over vad-web: `() => import("@ricky0123/vad-web")`, or anything resolving to its module. */
export type VadLoader = () => Promise<VadWebModule | { default: VadWebModule }>;
/** Silero VAD's source: a loader and where its model and onnxruntime's wasm are served from. */
export type VadConfig = {
  load: VadLoader;
  /** vad-web's `baseAssetPath`: the directory with silero_vad_*.onnx and the worklet. */
  baseAssetPath?: string;
  /** vad-web's `onnxWASMBasePath`: the directory with onnxruntime-web's .wasm files. */
  onnxWASMBasePath?: string;
  /** Silero's model (default "v5"). */
  model?: "v5" | "legacy";
  /** More MicVAD options (thresholds, redemption frames…), passed through. */
  options?: Record<string, unknown>;
};
export type VadSource = VadLoader | VadConfig;

const loadScript = (src: string) =>
  new Promise<void>((resolve, reject) => {
    if (document.querySelector(`script[src="${CSS.escape(src)}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      s.remove();
      reject(new Error(`could not load ${src}`));
    };
    document.head.append(s);
  });

const dir = (u: string) => (u.endsWith("/") ? u : `${u}/`);

/**
 * vad-web from its UMD builds, by <script> tags: `vadBase` is vad-web's dist
 * directory (bundle.min.js, the model, the worklet) and `ortBase`
 * onnxruntime-web's (ort.wasm.min.js and the wasm). E.g. pinned on a CDN:
 *
 *   vadFromScripts("https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/",
 *                  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/")
 *
 * The page's CSP must allow both origins (script-src, connect-src, and
 * 'wasm-unsafe-eval').
 */
export function vadFromScripts(vadBase: string, ortBase: string): VadConfig {
  const vad = dir(vadBase);
  const ort = dir(ortBase);
  return {
    baseAssetPath: vad,
    onnxWASMBasePath: ort,
    load: async () => {
      await loadScript(`${ort}ort.wasm.min.js`);
      await loadScript(`${vad}bundle.min.js`);
      const g = (globalThis as unknown as { vad?: VadWebModule }).vad;
      if (!g?.MicVAD) throw new Error("vad-web did not load");
      return g;
    },
  };
}

const vadConfig = (s: VadSource): VadConfig => (typeof s === "function" ? { load: s } : s);

/**
 * Silero on the session's stream (never stops it): ends an utterance after
 * ~0.8 s of silence; each frame's speech probability goes to onFrame.
 */
export async function sileroVad(ev: VadEvents, stream: MediaStream, src: VadSource): Promise<Vad> {
  const c = vadConfig(src);
  const m = await c.load();
  const mod = ("MicVAD" in m ? m : m.default) as VadWebModule | undefined;
  if (!mod?.MicVAD) throw new Error("vad-web: no MicVAD");
  const v = await mod.MicVAD.new({
    ...(c.baseAssetPath ? { baseAssetPath: c.baseAssetPath } : {}),
    ...(c.onnxWASMBasePath ? { onnxWASMBasePath: c.onnxWASMBasePath } : {}),
    model: c.model ?? "v5",
    submitUserSpeechOnPause: true,
    startOnLoad: false,
    ...c.options,
    getStream: async () => stream,
    pauseStream: async () => {},
    resumeStream: async () => stream,
    onSpeechStart: ev.onSpeechStart,
    onSpeechEnd: ev.onSpeechEnd,
    onVADMisfire: ev.onMisfire,
    onFrameProcessed: (p: { isSpeech?: number } | undefined, frame: Float32Array) =>
      ev.onFrame?.(frame, p?.isSpeech),
  });
  return {
    start: () => v.start(),
    pause: () => v.pause(),
    flush: async () => {
      await v.pause();
      await v.start();
    },
    destroy: () => v.destroy(),
  };
}

/** The fallback: an energy threshold on the raw signal (energyGate), on the session's stream. */
export async function energyVad(ev: VadEvents, stream: MediaStream): Promise<Vad> {
  const ctx = audioCtx();
  if (!ctx) throw new Error("no Web Audio");
  const src = ctx.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated but everywhere, and needs no worklet file.
  const node = ctx.createScriptProcessor(2048, 1, 1);
  const gate = energyGate({ rate: ctx.sampleRate });
  let on = false;
  const emit = (r: ReturnType<typeof gate.push>) => {
    if (r === "start") ev.onSpeechStart();
    else if (r === "misfire") ev.onMisfire();
    else if (r) ev.onSpeechEnd(resample(r, ctx.sampleRate, RATE));
  };
  node.onaudioprocess = (e) => {
    if (!on) return;
    const frame = new Float32Array(e.inputBuffer.getChannelData(0));
    const r = gate.push(frame);
    if (r === "start") emit(r);
    ev.onFrame?.(resample(frame, ctx.sampleRate, RATE));
    if (r !== "start") emit(r);
  };
  src.connect(node);
  node.connect(ctx.destination);
  return {
    start: () => {
      on = true;
      return ctx.resume();
    },
    pause: () => {
      on = false;
      emit(gate.flush()); // held: the mic drops it
    },
    flush: () => emit(gate.flush()),
    destroy: () => {
      on = false;
      node.disconnect();
      src.disconnect();
    },
  };
}
