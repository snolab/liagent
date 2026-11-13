import { expect, test } from "bun:test";
import { SEND_MAX, ctxText, deliveryText } from "../src/deliver.ts";

const hub = "https://example.com/api/chat";
const msg = (text: string, extra = {}) => ({
  id: "m1",
  from: "owner" as const,
  label: "/words Mozilla/5.0 (X11)",
  text,
  at: 0,
  ...extra,
});
const noSpill = () => {
  throw new Error("should not spill");
};

test("a short message: header with the reply command, then the text", () => {
  expect(deliveryText(hub, msg("fix it"), noSpill)).toBe(
    `[liagent m1] the user wrote in the chat box (/words) — reply: liagent reply ${hub} "..."\nfix it`,
  );
});

test("a voice (stt) line's header offers the polish, tied to that line's id", () => {
  expect(deliveryText(hub, msg("fix it", { source: "stt" }), noSpill)).toStartWith(
    `[liagent m1] the user wrote in the chat box (/words) — reply: liagent reply ${hub} --id m1 [--polish "..."] "..."\n`,
  );
});

test("a friend's message replies to their thread", () => {
  const t = deliveryText(
    hub,
    msg("hi", { from: "friend", email: "a@x.com", thread: "u1" }),
    noSpill,
  );
  expect(t).toContain("friend a@x.com wrote");
  expect(t).toContain(`liagent reply ${hub} --to a@x.com "..."`);
  expect(t).not.toContain("--polish");
});

test("a long one is spilled to a file and previewed within the send cap", () => {
  const spilled: string[] = [];
  const long = "x".repeat(4000);
  const t = deliveryText(hub, msg(long), (id, text) => {
    spilled.push(`${id}:${text.length}`);
    return "/inbox/m1.txt";
  });
  expect(spilled).toEqual(["m1:4000"]);
  expect(t.length).toBeLessThanOrEqual(SEND_MAX);
  expect(t).toEndWith("… (4000 chars; the whole message: /inbox/m1.txt)");
});

test("a line's ctx is delivered after the text, labelled as the page's data", () => {
  const t = deliveryText(hub, msg("open it", { ctx: { recordId: "42", step: 2 } }), noSpill);
  expect(t).toBe(
    `[liagent m1] the user wrote in the chat box (/words) — reply: liagent say ${hub} "..."\n` +
      `open it\n\n[page ctx (set by the page's script, not by the user): {"recordId":"42","step":2}]`,
  );
});

test("ctx comes after the selection and the files; none or empty adds nothing", () => {
  const t = deliveryText(
    hub,
    msg("see", {
      context: { selection: "quoted" },
      attachments: [{ id: "f1", name: "a.txt", type: "text/plain", size: 3 }],
      ctx: { page: "/x" },
    }),
    noSpill,
  );
  expect(t).toEndWith(
    '> quoted\n\n[attached: file a.txt (text/plain, 3 bytes) id f1]\n\n[page ctx (set by the page\'s script, not by the user): {"page":"/x"}]',
  );
  expect(deliveryText(hub, msg("plain", { ctx: {} }), noSpill)).toEndWith("\nplain");
  expect(ctxText(undefined)).toBe("");
  expect(ctxText({})).toBe("");
});

test("a spilled message keeps its ctx in the file, and the preview still fits the cap", () => {
  let spilled = "";
  const long = "y".repeat(4000);
  const t = deliveryText(hub, msg(long, { ctx: { recordId: "42" } }), (_id, text) => {
    spilled = text;
    return "/inbox/m1.txt";
  });
  expect(spilled).toEndWith(
    '[page ctx (set by the page\'s script, not by the user): {"recordId":"42"}]',
  );
  expect(spilled.startsWith(long)).toBe(true);
  expect(t.length).toBeLessThanOrEqual(SEND_MAX);
  expect(t).toEndWith(`… (${spilled.length} chars; the whole message: /inbox/m1.txt)`);
});
