/**
 * Files handed to the box: from its "+" button, a drop on the bar, or a
 * paste into the input. The box never uploads anything: it passes the files
 * to the host, which decides what to do with them.
 *
 * 1. `liagent-attach` fires on the box (bubbling, composed, cancelable) with
 *    `detail: { files }`. A listener that calls preventDefault() takes them.
 * 2. Otherwise `onAttach(files)` runs; a string it returns (or resolves to)
 *    is a note for the user ("3 files uploaded", "too large"). A throw or a
 *    rejection becomes the note too.
 *
 * Pure (no DOM beyond EventTarget): test/attach.test.ts.
 */

export const ATTACH_EVENT = "liagent-attach";

/** The host's handler (box.onAttach): a string it returns is shown as a note. */
export type AttachHandler = (files: File[]) => void | string | Promise<void | string>;

/** What a DataTransfer or a paste's clipboardData offers (only what is read here). */
export type FileSource = {
  files?: ArrayLike<File> | null;
  types?: ArrayLike<string> | null;
};

/** The transfer carries files (a drag from the desktop, a copied picture). */
export function hasFiles(dt: FileSource | null | undefined): boolean {
  if (!dt) return false;
  if (dt.files && dt.files.length > 0) return true;
  return Array.from(dt.types ?? []).includes("Files");
}

/** The files in a transfer, a paste or an `<input type=file>` (empty if none). */
export function filesOf(dt: FileSource | null | undefined): File[] {
  return Array.from(dt?.files ?? []);
}

/**
 * Hand files to the host: fire `liagent-attach` on `target`, then, unless a
 * listener took them, call `onAttach`. Resolves to the note to show (or
 * undefined). Nothing happens for no files.
 */
export async function attachFiles(
  target: EventTarget,
  files: File[],
  onAttach?: AttachHandler | null,
): Promise<string | undefined> {
  if (!files.length) return undefined;
  const ev = new CustomEvent(ATTACH_EVENT, {
    detail: { files },
    bubbles: true,
    composed: true,
    cancelable: true,
  });
  if (!target.dispatchEvent(ev) || !onAttach) return undefined;
  try {
    const note = await onAttach(files);
    return typeof note === "string" && note ? note : undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
