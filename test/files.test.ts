import { describe, expect, it } from "bun:test";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_NAME,
  cleanAttachments,
  cleanFileName,
  parsePageMessage,
} from "../src/protocol.ts";
import { attachmentsText, deliveryText } from "../src/deliver.ts";
import { fileAction, mediaAction } from "../src/attach.ts";
import {
  type ChatFiles,
  INLINE_IMAGE,
  createPendingFiles,
  dragHasFiles,
  fileBadge,
  filesFrom,
  formatSize,
  memoryFiles,
} from "../src/files.ts";
import { UI_EN, UI_ZH } from "../src/ui-strings.ts";

const file = (name: string, size = 10, type = "") =>
  new File([new Uint8Array(size)], name, { type });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("cleanFileName", () => {
  it("drops folders, control and bidi characters; bounded; 'file' when empty", () => {
    expect(cleanFileName("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
    expect(cleanFileName("../../etc/passwd")).toBe("passwd");
    expect(cleanFileName("evil\u202Efdp.exe")).toBe("evilfdp.exe");
    expect(cleanFileName("a\u0000b\nc")).toBe("abc");
    expect(cleanFileName("x".repeat(MAX_ATTACHMENT_NAME + 50)).length).toBe(MAX_ATTACHMENT_NAME);
    expect(cleanFileName("")).toBe("file");
    expect(cleanFileName("dir/")).toBe("file");
    expect(cleanFileName(42)).toBe("file");
  });
});

describe("cleanAttachments", () => {
  it("keeps known keys, checks each; the same id once; at most MAX_ATTACHMENTS", () => {
    expect(
      cleanAttachments([
        { id: "a1", name: "a.png", type: "image/png", size: 12, extra: "x" },
        { id: "a1", name: "dup", type: "image/png", size: 1 },
        { id: "bad id!", name: "x", type: "text/plain", size: 1 },
        { id: "b2", name: "b", type: "<script>", size: -3 },
        { id: "c3", name: "c", type: "text/html", size: 1.5 },
        null,
        "nope",
      ]),
    ).toEqual([
      { id: "a1", name: "a.png", type: "image/png", size: 12 },
      { id: "b2", name: "b", type: "application/octet-stream", size: 0 },
      { id: "c3", name: "c", type: "text/html", size: 0 },
    ]);
    const many = Array.from({ length: MAX_ATTACHMENTS + 5 }, (_, i) => ({
      id: `f${i}`,
      name: "n",
      type: "text/plain",
      size: 1,
    }));
    expect(cleanAttachments(many)?.length).toBe(MAX_ATTACHMENTS);
    expect(cleanAttachments([])).toBeUndefined();
    expect(cleanAttachments({ id: "a" })).toBeUndefined();
    expect(cleanAttachments([{ id: "" }])).toBeUndefined();
  });

  it("a page's chat line carries its cleaned attachments", () => {
    const m = parsePageMessage(
      JSON.stringify({
        type: "chat",
        id: "c1",
        text: "see",
        attachments: [{ id: "x1", name: "a/b.txt", type: "text/plain", size: 3 }, { id: "?" }],
      }),
    );
    expect(m).toEqual({
      type: "chat",
      id: "c1",
      text: "see",
      attachments: [{ id: "x1", name: "b.txt", type: "text/plain", size: 3 }],
    });
    const none = parsePageMessage(
      JSON.stringify({ type: "chat", id: "c2", text: "hi", attachments: [{ id: "!" }] }),
    );
    expect(none && "attachments" in none).toBe(false);
  });
});

describe("delivery", () => {
  it("lists each attached file after the text, by id, as data", () => {
    expect(attachmentsText(undefined)).toBe("");
    expect(attachmentsText([])).toBe("");
    const t = deliveryText(
      "https://hub.example",
      {
        id: "m1",
        from: "owner",
        label: "/ page",
        text: "look",
        at: 0,
        attachments: [{ id: "a1", name: "shot.png", type: "image/png", size: 2048 }],
      },
      () => "/tmp/x",
    );
    expect(t.endsWith("look\n\n[attached: file shot.png (image/png, 2048 bytes) id a1]")).toBe(
      true,
    );
  });
});

describe("helpers", () => {
  it("formatSize", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1023)).toBe("1023 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(20 * 1024 * 1024)).toBe("20 MB");
    expect(formatSize(-1)).toBe("");
    expect(formatSize(Number.NaN)).toBe("");
  });
  it("fileBadge", () => {
    expect(fileBadge("a.pdf")).toBe("PDF");
    expect(fileBadge("archive.tar.gz")).toBe("GZ");
    expect(fileBadge("README")).toBe("FILE");
  });
  it("inline images: raster types only, never SVG", () => {
    expect(INLINE_IMAGE.test("image/png")).toBe(true);
    expect(INLINE_IMAGE.test("image/webp")).toBe(true);
    expect(INLINE_IMAGE.test("image/svg+xml")).toBe(false);
    expect(INLINE_IMAGE.test("text/html")).toBe(false);
  });
  it("filesFrom: items first (a pasted screenshot), else files; text items ignored", () => {
    const a = file("a.png");
    const b = file("b.txt");
    expect(
      filesFrom({
        items: [
          { kind: "string", getAsFile: () => null },
          { kind: "file", getAsFile: () => a },
        ],
        files: [b],
      }),
    ).toEqual([a]);
    expect(filesFrom({ items: [], files: [b] })).toEqual([b]);
    expect(filesFrom(null)).toEqual([]);
  });
  it("dragHasFiles reads the types only", () => {
    expect(dragHasFiles({ types: ["text/plain", "Files"] })).toBe(true);
    expect(dragHasFiles({ types: ["text/plain"] })).toBe(false);
    expect(dragHasFiles(undefined)).toBe(false);
  });
  it("the strings cover the files in both tables, placeholders kept", () => {
    for (const t of [UI_EN, UI_ZH]) {
      expect(t.filesUsage).toContain("{size}");
      expect(t.filesUsage).toContain("{n}");
      expect(t.filesUsageQuota).toContain("{quota}");
    }
  });
});

/** A host whose uploads the test resolves by hand. */
function manualHost(maxBytes?: number) {
  const calls: {
    file: File;
    progress: (s: number, t: number) => void;
    signal: AbortSignal;
    ok: (id: string) => void;
    fail: () => void;
  }[] = [];
  const host: ChatFiles = {
    maxBytes,
    upload: (file, progress, signal) =>
      new Promise((res, rej) =>
        calls.push({
          file,
          progress,
          signal,
          ok: (id) => res({ id, name: file.name, type: file.type, size: file.size }),
          fail: () => rej(new Error("no")),
        }),
      ),
    url: (r) => `/files/${r.id}`,
  };
  return { host, calls };
}

describe("createPendingFiles", () => {
  it("uploads each with progress; take() hands out the stored refs and clears", async () => {
    const { host, calls } = manualHost();
    const p = createPendingFiles({ files: () => host });
    let changes = 0;
    p.subscribe(() => changes++);
    p.add([file("a.pdf", 100, "application/pdf"), file("b.png", 50, "image/png")]);
    expect(p.get().map((x) => x.state)).toEqual(["uploading", "uploading"]);
    expect(p.busy()).toBe(true);
    calls[0]!.progress(40, 100);
    expect(p.get()[0]!.sent).toBe(40);
    calls[0]!.ok("a1");
    calls[1]!.fail();
    await flush();
    expect(p.get().map((x) => x.state)).toEqual(["done", "failed"]);
    expect(p.busy()).toBe(false);
    expect(p.ready()).toBe(true);
    expect(p.take()).toEqual([{ id: "a1", name: "a.pdf", type: "application/pdf", size: 100 }]);
    expect(p.get()).toEqual([]);
    expect(changes).toBeGreaterThan(3);
  });

  it("× aborts a running upload; its late result is ignored", async () => {
    const { host, calls } = manualHost();
    const p = createPendingFiles({ files: () => host });
    p.add([file("a.txt")]);
    p.remove(p.get()[0]!.key);
    expect(calls[0]!.signal.aborted).toBe(true);
    calls[0]!.ok("late");
    await flush();
    expect(p.get()).toEqual([]);
  });

  it("too big is refused before upload; no host, nothing; at most MAX_ATTACHMENTS", () => {
    const { host, calls } = manualHost(5);
    const p = createPendingFiles({ files: () => host });
    p.add([file("big.bin", 6), file("ok.bin", 5)]);
    expect(p.get().map((x) => x.state)).toEqual(["too-big", "uploading"]);
    expect(calls.length).toBe(1);
    p.add(Array.from({ length: MAX_ATTACHMENTS }, (_, i) => file(`f${i}`)));
    expect(p.get().length).toBe(MAX_ATTACHMENTS);
    const none = createPendingFiles({ files: () => undefined });
    none.add([file("x")]);
    expect(none.get()).toEqual([]);
  });

  it("an upload that throws at once is a failed chip", async () => {
    const host: ChatFiles = {
      upload: () => {
        throw new Error("sync");
      },
      url: () => "",
    };
    const p = createPendingFiles({ files: () => host });
    p.add([file("x")]);
    await flush();
    expect(p.get()[0]!.state).toBe("failed");
  });

  it("thumbnails for inline images only, revoked when the chip goes", () => {
    const { host } = manualHost();
    const made: string[] = [];
    const revoked: string[] = [];
    const p = createPendingFiles({
      files: () => host,
      objectUrl: {
        create: (f) => (made.push(f.name), `blob:${f.name}`),
        revoke: (u) => void revoked.push(u),
      },
    });
    p.add([file("a.png", 1, "image/png"), file("b.svg", 1, "image/svg+xml")]);
    expect(p.get().map((x) => x.thumb)).toEqual(["blob:a.png", undefined]);
    p.take();
    expect(revoked).toEqual(["blob:a.png"]);
  });
});

describe("upload actions", () => {
  it("fileAction() / mediaAction() without upload are upload actions with their accept", () => {
    expect(fileAction()).toMatchObject({ id: "file", upload: true });
    expect(fileAction().attach).toBeUndefined();
    expect(mediaAction()).toMatchObject({
      id: "media",
      upload: true,
      accept: "image/*,video/*,audio/*",
    });
    expect(fileAction({ accept: ".csv" }).accept).toBe(".csv");
  });
});

describe("memoryFiles (the example host)", () => {
  it("stores, lists newest first with usage, removes, and refuses too big", async () => {
    let t = 1000;
    const m = memoryFiles({
      maxBytes: 100,
      quota: 1000,
      now: () => t++,
      objectUrl: (f) => `blob:${(f as File).name}`,
      actions: (r) => [{ id: "open", label: "Open", run: () => r.id }],
    });
    const seen: number[] = [];
    const ac = new AbortController();
    const a = await m.upload(file("a.txt", 10, "text/plain"), (s) => seen.push(s), ac.signal);
    const b = await m.upload(file("b.png", 20, "image/png"), () => {}, ac.signal);
    expect(seen).toEqual([10]);
    expect(m.url(a)).toBe("blob:a.txt");
    const l = await m.list!();
    expect(l.items.map((x) => x.name)).toEqual(["b.png", "a.txt"]);
    expect(l.usage).toEqual({ bytes: 30, items: 2, quota: 1000 });
    expect(m.actions!(b).map((x) => x.id)).toEqual(["open"]);
    await m.remove!(a.id);
    expect(m.stored().map((x) => x.id)).toEqual([b.id]);
    expect(m.url(a)).toBe("");
    await expect(m.upload(file("big", 101), () => {}, ac.signal)).rejects.toThrow();
    await expect(m.remove!("nope")).rejects.toThrow();
    ac.abort();
    await expect(m.upload(file("c"), () => {}, ac.signal)).rejects.toThrow();
  });
});
