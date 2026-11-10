/**
 * The box's actions: the "+" menu and the bar's own buttons, as one
 * pluggable list the host owns (box.actions). Each action says where it
 * goes — in the + menu (`place: "menu"`, the default), or as a button at the
 * bar's start (`"leading"`) or end (`"trailing"`) — so moving a feature from
 * the bar into the menu is a one-word change in the host's config.
 *
 * An action either does something (`onSelect`) or attaches something to the
 * line being typed (`attach`, returning a ChatContext: a selection and the
 * page it came from, files the host uploaded). What is attached shows as a
 * chip over the input (× drops it) and goes out with the next line as its
 * `context` (src/protocol.ts cleanContext).
 *
 * Built-in providers, all optional and generic:
 *   - selectionAction(): the page's last selection made outside the box
 *     (kept while the user goes to the input: a phone clears the page's
 *     selection when the input takes focus), never from a password, a
 *     one-time-code or card field, or anything under [data-sensitive];
 *     at most MAX_SELECTION chars; forgotten after SELECTION_TTL_MS, a tap
 *     elsewhere on the page, or a send.
 *   - fileAction({ upload }) / mediaAction({ upload }): a file picker whose
 *     files the HOST uploads (`upload(file)` → {url, name, type?, size?});
 *     liagent never sends file bytes over the chat.
 *   - fileAction() / mediaAction() without `upload`: an upload action
 *     (`upload: true`): the box opens the picker with its `accept` and puts
 *     the files in its pending list, stored through the host's `box.files`
 *     (src/files.ts); without `box.files` it shows disabled.
 *
 * Pure apart from the DOM it is handed (SelectionDeps), so it is unit tested
 * with fakes (test/attach.test.ts).
 */
import { type ChatContext, MAX_SELECTION, type ContextFile, cleanContext } from "./protocol.ts";

/** Where an action shows: in the + menu, or as a bar button at its start or end. */
export type ActionPlace = "menu" | "leading" | "trailing";

/** What an action's callbacks get from the box. */
export type ActionHost = {
  /** Attach to the line being typed (merged with what is attached already). */
  attach(ctx: ChatContext): void;
  /** Focus the box's input. */
  focus(): void;
  /** Close the + menu (it closes by itself after a pick). */
  close(): void;
  /** Show a short notice over the input (an upload that failed…). */
  notice(text: string): void;
  /** Upload files through the box's `files` host for the next line (nothing without one). */
  addFiles(files: readonly File[]): void;
  /** The box itself, for anything else. */
  box: HTMLElement;
};

/**
 * One item of the + menu, or one bar button. Plain data and callbacks, no
 * framework element: any UI stack can register them.
 */
export type ChatAction = {
  /** Unique among the box's actions; also the element's data-action. */
  id: string;
  /** The row's text, or the button's accessible name. Shown as text. */
  label: string;
  /**
   * A glyph (text, e.g. "＋" or "❝"), or a Node (an <svg> the host built) that
   * is cloned for each render. Never parsed as HTML.
   */
  icon?: string | Node;
  /** Where it goes (default "menu"). */
  place?: ActionPlace;
  /** The menu group heading it sits under (default: none, at the top). */
  group?: string;
  /** A muted second line in the menu (what would be attached…). */
  hint?: () => string | undefined;
  /** Off: shown disabled. Read on every render. */
  enabled?: () => boolean;
  /** Tells the box when `enabled` or `hint` may have changed; returns an unsubscribe. */
  subscribe?: (changed: () => void) => () => void;
  /** Do it. */
  onSelect?: (host: ActionHost) => void | Promise<void>;
  /**
   * Attach something: the result is merged into what goes with the next line
   * (null: nothing). Runs after onSelect when both are given.
   */
  attach?: (
    host: ActionHost,
  ) => ChatContext | null | undefined | Promise<ChatContext | null | undefined>;
  /** The line it attached to went out (a kept selection is let go). */
  sent?: () => void;
  /**
   * An upload action: picking it opens the file picker (with `accept`) and
   * the box uploads what is picked through its `files` host (src/files.ts),
   * as pasted or dropped files are. Without `box.files` it shows disabled.
   * onSelect and attach still run first when given.
   */
  upload?: boolean;
  /** An upload action's picker `accept` (absent: any file). */
  accept?: string;
};

/** The actions for one place, in the host's order; a later duplicate id is dropped. */
export function actionsAt(list: readonly ChatAction[], place: ActionPlace): ChatAction[] {
  const seen = new Set<string>();
  return list.filter((a) => {
    if (!a?.id || seen.has(a.id)) return false;
    seen.add(a.id);
    return (a.place ?? "menu") === place;
  });
}

/** The menu's actions grouped: ungrouped first, then each group in first-seen order. */
export function menuGroups(list: readonly ChatAction[]): { group?: string; items: ChatAction[] }[] {
  const out: { group?: string; items: ChatAction[] }[] = [];
  for (const a of actionsAt(list, "menu")) {
    const g = out.find((x) => x.group === a.group);
    if (g) g.items.push(a);
    else out.push({ group: a.group, items: [a] });
  }
  const i = out.findIndex((x) => x.group === undefined);
  if (i > 0) out.unshift(...out.splice(i, 1));
  return out;
}

/** Whether an action can be picked now (a throwing `enabled` counts as off). */
export function actionEnabled(a: ChatAction): boolean {
  try {
    return a.enabled ? a.enabled() !== false : true;
  } catch {
    return false;
  }
}

// ---- the page selection ---------------------------------------------------------

/** How long a remembered selection stays attachable. */
export const SELECTION_TTL_MS = 30 * 60_000;

/** A remembered selection: what can be attached, and when it was made. */
export type PageSelection = ChatContext & { selection: string; at: number };

/** The slice of an element read here (the DOM's, or a test's fake). */
export type ElLike = {
  tagName?: string;
  type?: string;
  value?: string;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  getAttribute?(name: string): string | null;
  closest?(selector: string): unknown;
  parentElement?: ElLike | null;
  nodeType?: number;
};

/** The box's own elements: a selection in them is never attached. */
export const CHAT_FENCE = "liagent-chat, [data-liagent-chat]";
/** Marks a part of a page whose text is never captured (any page may use it). */
export const SENSITIVE = "[data-sensitive], [data-liagent-sensitive]";
const SENSITIVE_AUTOCOMPLETE = /password|one-time-code|cc-|csc/i;

/** A field (or a part of the page) whose text must never be attached. */
export function isSensitive(el: ElLike | null | undefined): boolean {
  if (!el) return false;
  if (el.tagName === "INPUT") {
    if ((el.type ?? "").toLowerCase() === "password") return true;
    if (SENSITIVE_AUTOCOMPLETE.test(el.getAttribute?.("autocomplete") ?? "")) return true;
  }
  return !!el.closest?.(SENSITIVE);
}

const elementOf = (n: ElLike | null | undefined): ElLike | null =>
  !n ? null : n.nodeType === 1 ? n : (n.parentElement ?? null);

export type SelectionDoc = {
  activeElement: ElLike | null;
  getSelection(): {
    rangeCount: number;
    isCollapsed: boolean;
    anchorNode: ElLike | null;
    focusNode: ElLike | null;
    toString(): string;
    getRangeAt?(i: number): { intersectsNode(n: unknown): boolean };
  } | null;
  /** The fenced elements a selection must not cross. */
  querySelectorAll?(selector: string): ArrayLike<unknown>;
  addEventListener(type: string, f: (e: { target: unknown }) => void, capture?: boolean): void;
  removeEventListener(type: string, f: (e: { target: unknown }) => void, capture?: boolean): void;
};

export type SelectionDeps = {
  doc: SelectionDoc;
  /** Whether a node is part of the chat itself. */
  inChat(node: unknown): boolean;
  /** Where the page is: path, title, and host when it matters. */
  where(): Omit<ChatContext, "selection" | "files">;
  /** Extra fences (selectors) besides CHAT_FENCE and SENSITIVE. */
  fence?: string;
  now?: () => number;
};

/** What is selected now outside the chat: "" when nothing, null when it must be left alone. */
export function readSelection(d: Pick<SelectionDeps, "doc" | "inChat" | "fence">): string | null {
  const a = d.doc.activeElement;
  if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && !d.inChat(a)) {
    if (isSensitive(a) || (d.fence && a.closest?.(d.fence))) return null;
    const s = a.selectionStart ?? 0;
    const e = a.selectionEnd ?? 0;
    if (e > s) return (a.value ?? "").slice(s, e);
  }
  const sel = d.doc.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return "";
  if (d.inChat(sel.anchorNode) || d.inChat(sel.focusNode)) return null;
  const ends = [elementOf(sel.anchorNode), elementOf(sel.focusNode)];
  if (ends.some((e) => isSensitive(e) || (d.fence && e?.closest?.(d.fence)))) return null;
  // Nor anything it spans: a selection from before a fenced part to after it
  // would carry that part's text in toString().
  const fences = [SENSITIVE, CHAT_FENCE, d.fence].filter(Boolean).join(", ");
  const fenced = d.doc.querySelectorAll?.(fences);
  if (fenced?.length && sel.getRangeAt)
    for (let i = 0; i < sel.rangeCount; i++) {
      const r = sel.getRangeAt(i);
      for (let j = 0; j < fenced.length; j++) if (r.intersectsNode(fenced[j])) return null;
    }
  return sel.toString();
}

export type SelectionMemory = ReturnType<typeof createSelectionMemory>;

/**
 * The last non-empty selection made outside the chat. Cleared by a press
 * elsewhere on the page that leaves nothing selected, by clear(), and when
 * older than SELECTION_TTL_MS.
 */
export function createSelectionMemory(d: SelectionDeps) {
  const now = d.now ?? Date.now;
  // Fences only add up: every caller's private parts stay fenced.
  const fences = new Set<string>(d.fence ? [d.fence] : []);
  const read = () => readSelection({ ...d, fence: [...fences].join(", ") || undefined });
  let kept: PageSelection | null = null;
  let downInChat = false;
  const subs = new Set<() => void>();
  const set = (v: PageSelection | null) => {
    if (v === kept || (v && kept && v.selection === kept.selection && v.path === kept.path)) return;
    kept = v;
    for (const f of subs) f();
  };
  const onDown = (e: { target: unknown }) => {
    downInChat = d.inChat(e.target);
  };
  const onChange = () => {
    const text = read();
    if (text === null) return;
    const trimmed = text.trim();
    if (trimmed) {
      const ctx = cleanContext({ ...d.where(), selection: trimmed.slice(0, MAX_SELECTION) });
      if (ctx?.selection) set({ ...ctx, selection: ctx.selection, at: now() });
      return;
    }
    // Empty: the chat taking the focus (or a press in it) keeps what was
    // selected; a press anywhere else on the page lets it go.
    if (downInChat || d.inChat(d.doc.activeElement)) return;
    set(null);
  };
  return {
    start() {
      d.doc.addEventListener("pointerdown", onDown, true);
      d.doc.addEventListener("selectionchange", onChange);
      return () => {
        d.doc.removeEventListener("pointerdown", onDown, true);
        d.doc.removeEventListener("selectionchange", onChange);
      };
    },
    /** The kept selection while it is fresh. */
    get(): PageSelection | null {
      return kept && now() - kept.at <= SELECTION_TTL_MS ? kept : null;
    },
    clear: () => set(null),
    /** Fence more of the page (selectors whose text is never attached); never removed. */
    addFence(selector: string | undefined) {
      if (!selector || fences.has(selector)) return;
      fences.add(selector);
      // What is kept may sit in the newly fenced part: let it go.
      if (kept) set(null);
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
    /** For tests: run the handlers as the DOM would. */
    _events: { onDown, onChange },
  };
}

/** One line of a selection, for a chip: whitespace collapsed. */
export const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function domInChat(node: unknown): boolean {
  const n = node as { nodeType?: number; parentElement?: Element | null } | null;
  if (!n || typeof n !== "object") return false;
  const el = (n.nodeType === 1 ? n : n.parentElement) as Element | null | undefined;
  if (!el?.closest) return false;
  if (el.closest(CHAT_FENCE)) return true;
  // Inside the box's shadow root: its host is the box.
  const root = el.getRootNode?.() as ShadowRoot | undefined;
  return !!root && "host" in root && !!(root.host as Element | undefined)?.closest?.(CHAT_FENCE);
}

const MEMORY_KEY = "__liagentSelection";
/**
 * The page's selection memory, made and started once (every copy of the
 * module shares it, on globalThis). Null where there is no DOM. Each
 * caller's `fence` is added to it; `host` is the first caller's.
 */
export function pageSelection(
  opts: { host?: boolean; fence?: string } = {},
): SelectionMemory | null {
  if (typeof document === "undefined") return null;
  const g = globalThis as unknown as Record<string, SelectionMemory | undefined>;
  const have = g[MEMORY_KEY];
  if (have) {
    // Made by another caller: its fences stay, this caller's are added.
    have.addFence?.(opts.fence);
    return have;
  }
  const m = createSelectionMemory({
    doc: document as unknown as SelectionDoc,
    inChat: domInChat,
    fence: opts.fence,
    where: () => ({
      path: location.pathname,
      title: document.title,
      ...(opts.host ? { host: location.host } : {}),
    }),
  });
  m.start();
  g[MEMORY_KEY] = m;
  return m;
}

export type SelectionActionOptions = {
  id?: string;
  label?: string;
  /** The hint when nothing is selected. */
  none?: string;
  icon?: string | Node;
  group?: string;
  place?: ActionPlace;
  /** Send the page's host too (a box embedded on other sites). */
  host?: boolean;
  /** More selectors whose text is never attached. */
  fence?: string;
  /** The memory to use (tests, or a host's own); default: the page's. */
  memory?: SelectionMemory | null;
};

/** "Attach the selection": the page's last selection outside the box, as context. */
export function selectionAction(o: SelectionActionOptions = {}): ChatAction {
  const mem = () => (o.memory !== undefined ? o.memory : pageSelection(o));
  // Start listening now, so a selection made before the menu opens is known;
  // a memory made elsewhere takes this action's fence too.
  mem()?.addFence(o.fence);
  return {
    id: o.id ?? "selection",
    label: o.label ?? "Attach the selection",
    icon: o.icon ?? "❝",
    group: o.group,
    place: o.place,
    enabled: () => !!mem()?.get(),
    hint: () => {
      const s = mem()?.get();
      return s ? `“${oneLine(s.selection)}”` : (o.none ?? "Select text on the page first");
    },
    subscribe: (f) => mem()?.subscribe(f) ?? (() => {}),
    attach: () => {
      const s = mem()?.get();
      if (!s) return null;
      const { at: _at, ...ctx } = s;
      return ctx;
    },
    sent: () => mem()?.clear(),
  };
}

/** What a host's upload hook returns for one file. */
export type UploadedFile = ContextFile;

export type FileActionOptions = {
  /**
   * The host uploads the file and says where it is now (throw to refuse).
   * Absent: an upload action, stored through the box's `files` host instead
   * (with chips, progress and ×; src/files.ts).
   */
  upload?: (file: File) => Promise<UploadedFile>;
  id?: string;
  label?: string;
  icon?: string | Node;
  group?: string;
  place?: ActionPlace;
  /** The picker's accept (default: any file). */
  accept?: string;
  multiple?: boolean;
  /** The notice when an upload throws. */
  failed?: (file: File, err: unknown) => string;
  /** The picker (tests): default an <input type="file">. */
  pick?: (accept: string | undefined, multiple: boolean) => Promise<File[]>;
};

function pickFiles(accept: string | undefined, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (accept) input.accept = accept;
    input.multiple = multiple;
    input.style.display = "none";
    input.addEventListener("change", () => {
      resolve([...(input.files ?? [])]);
      input.remove();
    });
    input.addEventListener("cancel", () => {
      resolve([]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

/**
 * "Attach a file": the host's upload hook, each result attached as a file;
 * without one, an upload action the box stores through `box.files`.
 */
export function fileAction(o: FileActionOptions = {}): ChatAction {
  const base: ChatAction = {
    id: o.id ?? "file",
    label: o.label ?? "Attach a file",
    icon: o.icon ?? "📎",
    group: o.group,
    place: o.place,
  };
  const upload = o.upload;
  if (!upload) return { ...base, upload: true, ...(o.accept ? { accept: o.accept } : {}) };
  return {
    ...base,
    attach: async (host) => {
      const files = await (o.pick ?? pickFiles)(o.accept, o.multiple ?? true);
      const done: ContextFile[] = [];
      for (const f of files)
        try {
          done.push(await upload(f));
        } catch (e) {
          host.notice(o.failed?.(f, e) ?? `Could not attach ${f.name}`);
        }
      return done.length ? cleanContext({ files: done }) : null;
    },
  };
}

/** "Attach a photo or video": fileAction for media (image, video, audio). */
export function mediaAction(o: FileActionOptions = {}): ChatAction {
  return fileAction({
    id: "media",
    label: "Attach a photo or video",
    icon: "🖼",
    accept: "image/*,video/*,audio/*",
    ...o,
  });
}
