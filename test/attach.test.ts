import { describe, expect, it } from "bun:test";
import { ATTACH_EVENT, attachFiles, filesOf, hasFiles } from "../src/attach.ts";

const photo = () => new File(["x"], "photo.jpg", { type: "image/jpeg" });
const notes = () => new File(["hello"], "notes.txt", { type: "text/plain" });

describe("files in a transfer or a paste", () => {
  it("sees files by their list or, while dragging, by the Files type", () => {
    expect(hasFiles({ files: [photo()] })).toBe(true);
    // During dragover the list is empty; only the types say files are coming.
    expect(hasFiles({ files: [], types: ["Files"] })).toBe(true);
    expect(hasFiles({ files: [], types: ["text/plain", "text/html"] })).toBe(false);
    expect(hasFiles({})).toBe(false);
    expect(hasFiles(null)).toBe(false);
    expect(hasFiles(undefined)).toBe(false);
  });

  it("lists the files, in order, or none", () => {
    const a = photo();
    const b = notes();
    expect(filesOf({ files: [a, b] })).toEqual([a, b]);
    expect(filesOf({ files: null, types: ["text/plain"] })).toEqual([]);
    expect(filesOf(null)).toEqual([]);
  });
});

describe("handing files to the host", () => {
  it("fires liagent-attach (bubbling, composed, cancelable), then calls onAttach", async () => {
    const t = new EventTarget();
    const files = [photo(), notes()];
    const order: string[] = [];
    let seen: Event | undefined;
    t.addEventListener(ATTACH_EVENT, (e) => {
      seen = e;
      order.push("event");
    });
    const note = await attachFiles(t, files, (f) => {
      order.push("onAttach");
      expect(f).toBe(files);
      return `uploaded ${f.length} files`;
    });
    expect(order).toEqual(["event", "onAttach"]);
    expect(seen).toBeInstanceOf(CustomEvent);
    expect((seen as CustomEvent).detail).toEqual({ files });
    expect(seen!.bubbles).toBe(true);
    expect(seen!.composed).toBe(true);
    expect(seen!.cancelable).toBe(true);
    expect(note).toBe("uploaded 2 files");
  });

  it("skips onAttach when a listener calls preventDefault", async () => {
    const t = new EventTarget();
    t.addEventListener(ATTACH_EVENT, (e) => e.preventDefault());
    let called = false;
    const note = await attachFiles(t, [photo()], () => {
      called = true;
      return "never";
    });
    expect(called).toBe(false);
    expect(note).toBeUndefined();
  });

  it("awaits an async handler; no string or an empty one is no note", async () => {
    const t = new EventTarget();
    expect(await attachFiles(t, [photo()], async () => "done")).toBe("done");
    expect(await attachFiles(t, [photo()], async () => {})).toBeUndefined();
    expect(await attachFiles(t, [photo()], () => "")).toBeUndefined();
  });

  it("turns a throw or a rejection into the note", async () => {
    const t = new EventTarget();
    const thrown = await attachFiles(t, [photo()], () => {
      throw new Error("too large");
    });
    expect(thrown).toBe("too large");
    const rejected = await attachFiles(t, [photo()], () => Promise.reject("offline"));
    expect(rejected).toBe("offline");
  });

  it("fires the event even without onAttach, for hosts that only listen", async () => {
    const t = new EventTarget();
    let got: File[] = [];
    t.addEventListener(ATTACH_EVENT, (e) => (got = (e as CustomEvent).detail.files));
    const files = [notes()];
    expect(await attachFiles(t, files)).toBeUndefined();
    expect(got).toBe(files);
  });

  it("does nothing for no files", async () => {
    const t = new EventTarget();
    let fired = false;
    t.addEventListener(ATTACH_EVENT, () => (fired = true));
    let called = false;
    expect(await attachFiles(t, [], () => void (called = true))).toBeUndefined();
    expect(fired).toBe(false);
    expect(called).toBe(false);
  });
});
