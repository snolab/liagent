/**
 * Files sent with a chat line: pasted into the input, dropped on the box, or
 * picked with an upload action in the + menu (attach.ts fileAction /
 * mediaAction without their own `upload`). The box never stores bytes and
 * knows no server: the host sets `box.files` (ChatFiles), which uploads one
 * file, says where the page may fetch one, and optionally lists and deletes
 * what was stored and offers its own actions on one. Without it, paste and
 * drop do nothing and the upload actions show disabled.
 *
 * Here: the host contract, the pending list above the input (one entry per
 * file with its progress, removable before sending), small pure helpers, and
 * memoryFiles(), an in-memory host for demos and tests. Nothing a user sent
 * is rendered as HTML: names are text, and only an image type in
 * INLINE_IMAGE is shown as an <img>, from the host's own URL.
 *
 * Pure apart from what it is handed, so it is unit tested with fakes
 * (test/files.test.ts).
 */
import { type AttachmentRef, MAX_ATTACHMENTS, cleanFileName } from "./protocol.ts";

export type { AttachmentRef } from "./protocol.ts";

/** One file the host has stored (a row of the + menu's file list). */
export type StoredFile = AttachmentRef & {
  /** When it was stored (ms since the epoch). */
  at: number;
  /** When the agent marked it handled, if it did. */
  processedAt?: number;
};

/** What the user has stored with the host: shown at the top of the file list. */
export type FilesUsage = {
  /** Bytes stored now. */
  bytes: number;
  /** Files stored now. */
  items: number;
  /** The user's quota in bytes, if the host has one. */
  quota?: number;
};

/** The file list's data: the stored files, newest first, and the usage. */
export type FilesListing = { items: StoredFile[]; usage?: FilesUsage };

/** One host action on a stored file (a button on its row and next to it under a sent line). */
export type FileItemAction = {
  /** Unique among one file's actions; also the button's data-action. */
  id: string;
  /** The button's text, localized by the host. Shown as text. */
  label: string;
  run: () => void;
};

/**
 * The host's file handling. Every method may throw (or reject); the box
 * shows that as a failed chip or a failed list, never as a crash.
 */
export type ChatFiles = {
  /**
   * Store one file; resolves with its ref once stored. `onProgress` gets the
   * bytes sent so far; `signal` aborts it (× on the chip before it finished).
   */
  upload(
    file: File,
    onProgress: (sent: number, total: number) => void,
    signal: AbortSignal,
  ): Promise<AttachmentRef>;
  /** Where the page may fetch a stored file (an <img> src, a download link). */
  url(ref: AttachmentRef): string;
  /** Largest file the host takes, in bytes: a bigger one is refused before upload. */
  maxBytes?: number;
  /** The stored files, newest first, and the usage: the + menu's file list. */
  list?(): Promise<FilesListing>;
  /** Delete one stored file for good (the list's Delete, confirmed first). */
  remove?(id: string): Promise<void>;
  /** What the host can do with one stored file (open it in one of its tools…); none: []. */
  actions?(ref: AttachmentRef): FileItemAction[];
};

/** Image types shown inline as <img>; anything else (SVG included) is a file chip. */
export const INLINE_IMAGE = /^image\/(png|jpeg|gif|webp|avif)$/;
export const isInlineImage = (type: string) => INLINE_IMAGE.test(type);

/** "12 KB", "3.4 MB": bytes for a chip ("" for nonsense). */
export function formatSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

/** "PDF", "ZIP": a file chip's stand-in for a thumbnail ("FILE" without an extension). */
export function fileBadge(name: string): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name);
  return m ? m[1]!.toUpperCase() : "FILE";
}

/** The slice of a DataTransfer (paste or drop) read here. */
export type TransferLike = {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<{ kind: string; getAsFile(): File | null }> | null;
  types?: ArrayLike<string> | readonly string[];
};

/** The files in a paste or a drop (items first: a pasted screenshot is only there). */
export function filesFrom(dt: TransferLike | null | undefined): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const it of Array.from(dt.items ?? [])) {
    if (it.kind !== "file") continue;
    const f = it.getAsFile();
    if (f) out.push(f);
  }
  if (!out.length) out.push(...Array.from(dt.files ?? []));
  return out;
}

/** Whether a drag carries files (dragover cannot read them yet, only the types). */
export function dragHasFiles(dt: TransferLike | null | undefined): boolean {
  return Array.from(dt?.types ?? []).includes("Files");
}

/** One file above the input: uploading, stored (ref), failed, or refused as too big. */
export type PendingFile = {
  key: string;
  name: string;
  type: string;
  size: number;
  /** Bytes sent so far. */
  sent: number;
  state: "uploading" | "done" | "failed" | "too-big";
  ref?: AttachmentRef;
  /** A local object URL for an image's thumbnail, revoked when the chip goes. */
  thumb?: string;
};

export type PendingDeps = {
  /** The host's files now (absent: add() does nothing). */
  files: () => ChatFiles | undefined;
  /** URL.createObjectURL / revokeObjectURL (absent in tests: no thumbnails). */
  objectUrl?: { create(f: File): string; revoke(u: string): void };
};

/**
 * The pending files above the input, as a small store (subscribe/get, like
 * the page selection): add() starts each upload, remove() aborts or drops
 * one, take() hands the stored refs to a sent line and clears the list.
 */
export function createPendingFiles(deps: PendingDeps) {
  let list: PendingFile[] = [];
  const aborts = new Map<string, AbortController>();
  const subs = new Set<() => void>();
  let n = 0;
  const set = (next: PendingFile[]) => {
    list = next;
    for (const f of subs) f();
  };
  const patch = (key: string, p: Partial<PendingFile>) => {
    if (list.some((x) => x.key === key)) set(list.map((x) => (x.key === key ? { ...x, ...p } : x)));
  };
  const drop = (x: PendingFile) => {
    aborts.get(x.key)?.abort();
    aborts.delete(x.key);
    if (x.thumb) deps.objectUrl?.revoke(x.thumb);
  };
  return {
    subscribe(f: () => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
    get: () => list,
    /** Start uploading these (past MAX_ATTACHMENTS in all, the rest are left out). */
    add(files: readonly File[]) {
      const host = deps.files();
      if (!host) return;
      const room = Math.max(0, MAX_ATTACHMENTS - list.length);
      const added: PendingFile[] = [];
      const starts: (() => void)[] = [];
      for (const file of files.slice(0, room)) {
        const key = `f${++n}`;
        const type = file.type || "application/octet-stream";
        const big = host.maxBytes !== undefined && file.size > host.maxBytes;
        const p: PendingFile = {
          key,
          name: cleanFileName(file.name),
          type,
          size: file.size,
          sent: 0,
          state: big ? "too-big" : "uploading",
          ...(isInlineImage(type) && deps.objectUrl ? { thumb: deps.objectUrl.create(file) } : {}),
        };
        added.push(p);
        if (big) continue;
        const ac = new AbortController();
        aborts.set(key, ac);
        // Started once the chips are listed, so a first progress report has a chip to land on.
        starts.push(() => {
          let run: Promise<AttachmentRef>;
          try {
            run = Promise.resolve(host.upload(file, (sent) => patch(key, { sent }), ac.signal));
          } catch (e) {
            run = Promise.reject(e);
          }
          run
            .then(
              (ref) => {
                if (aborts.get(key) !== ac) return;
                patch(key, { state: "done", sent: file.size, ref });
              },
              () => {
                if (aborts.get(key) !== ac) return;
                patch(key, { state: "failed" });
              },
            )
            .finally(() => {
              if (aborts.get(key) === ac) aborts.delete(key);
            });
        });
      }
      if (added.length) set([...list, ...added]);
      for (const go of starts) go();
    },
    /** × on a chip: abort its upload (if running) and drop it. */
    remove(key: string) {
      const x = list.find((p) => p.key === key);
      if (!x) return;
      drop(x);
      set(list.filter((p) => p.key !== key));
    },
    /** Any file still on its way: a send waits for it. */
    busy: () => list.some((p) => p.state === "uploading"),
    /** Any file stored and ready to go out. */
    ready: () => list.some((p) => p.state === "done" && !!p.ref),
    /** The stored files' refs for the line being sent; every chip goes (failed ones too). */
    take(): AttachmentRef[] {
      const refs = list.flatMap((p) => (p.state === "done" && p.ref ? [p.ref] : []));
      for (const x of list) drop(x);
      if (list.length) set([]);
      return refs;
    },
  };
}
export type PendingFiles = ReturnType<typeof createPendingFiles>;

// ---- an example host ----------------------------------------------------------

export type MemoryFilesOptions = {
  /** Largest file taken, in bytes (default: no limit). */
  maxBytes?: number;
  /** Quota shown in the list's usage line (default: none). */
  quota?: number;
  /** Actions on a stored file (default: none). */
  actions?: (ref: AttachmentRef) => FileItemAction[];
  /** An object URL for a stored file (default URL.createObjectURL; tests pass a fake). */
  objectUrl?: (f: Blob) => string;
  now?: () => number;
};

/**
 * A ChatFiles that keeps every file in this page's memory (object URLs), for
 * demos and tests only: nothing leaves the page and everything is gone on
 * reload. A real host uploads to its own store, checks the file's type and
 * size again on its side, and serves it back from a URL of its own.
 */
export function memoryFiles(o: MemoryFilesOptions = {}): ChatFiles & {
  /** The stored files, newest first (for tests). */
  stored(): StoredFile[];
} {
  const now = o.now ?? Date.now;
  const mkUrl = o.objectUrl ?? ((f: Blob) => URL.createObjectURL(f));
  const items: (StoredFile & { href: string })[] = [];
  let n = 0;
  const plain = ({ href: _href, ...f }: StoredFile & { href: string }): StoredFile => f;
  return {
    maxBytes: o.maxBytes,
    async upload(file, onProgress, signal) {
      if (signal.aborted) throw new Error("aborted");
      if (o.maxBytes !== undefined && file.size > o.maxBytes) throw new Error("too large");
      onProgress(file.size, file.size);
      const ref: AttachmentRef = {
        id: `m${now().toString(36)}${(++n).toString(36)}`,
        name: cleanFileName(file.name),
        type: file.type || "application/octet-stream",
        size: file.size,
      };
      items.unshift({ ...ref, at: now(), href: mkUrl(file) });
      return ref;
    },
    url: (ref) => items.find((x) => x.id === ref.id)?.href ?? "",
    async list() {
      const bytes = items.reduce((s, x) => s + x.size, 0);
      return {
        items: items.map(plain),
        usage: { bytes, items: items.length, ...(o.quota ? { quota: o.quota } : {}) },
      };
    },
    async remove(id) {
      const i = items.findIndex((x) => x.id === id);
      if (i < 0) throw new Error("no such file");
      items.splice(i, 1);
    },
    actions: o.actions,
    stored: () => items.map(plain),
  };
}
