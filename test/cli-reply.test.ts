import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `liagent reply` against a scripted hub: the same rules as src/hub.ts's edit()
// (the owner's latest stt line only; friends' lines never), so the test is about
// what the CLI sends, and in which order, not about the hub's own checks.

type Msg = Record<string, unknown> & { type?: string };
/** The owner's thread as the hub sends it after approval: v1 (stt), t1 (typed), v2 (stt, the latest). */
const HISTORY: Msg[] = [
  { id: "v1", from: "owner", text: "fix the sink button", source: "stt", at: 1, label: "/words" },
  { id: "t1", from: "owner", text: "typed", at: 2, label: "/words" },
  { id: "v2", from: "owner", text: "and the sync one", source: "stt", at: 3, label: "/words" },
];
const LATEST = "v2";

let server: ReturnType<typeof Bun.serve>;
let received: Msg[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req, { data: undefined })) return undefined;
      return new Response("ws only", { status: 426 });
    },
    websocket: {
      open(ws) {
        // A fresh pairing is approved at once; the history follows, as the hub does.
        ws.send(
          JSON.stringify({
            type: "approved",
            scope: "chat",
            token: "t",
            until: Date.now() + 3_600_000,
            pages: "all",
          }),
        );
        ws.send(JSON.stringify({ type: "history", messages: HISTORY }));
      },
      message(ws, data) {
        const m = JSON.parse(String(data)) as Msg;
        received.push(m);
        const fail = (reason: string) => {
          ws.send(JSON.stringify({ type: "error", error: reason, reason }));
        };
        if (m.type === "edit") {
          const line = HISTORY.find((x) => x.id === m.id);
          if (!line)
            return fail(
              `no message ${m.id} in the owner's thread (friends' lines can never be edited)`,
            );
          if (line.id !== LATEST)
            return fail(
              `message ${m.id} is not the owner's latest: only the latest may be polished`,
            );
          if (line.source !== "stt")
            return fail(
              `message ${m.id} was typed, not spoken: only voice (stt) lines may be polished`,
            );
          ws.send(JSON.stringify({ type: "edited", id: m.id, thread: "owner", text: m.text }));
          return;
        }
        if (m.type === "say") ws.send(JSON.stringify({ type: "said", id: "r1" }));
      },
    },
  });
});
afterAll(() => server.stop(true));

/**
 * One CLI run with its own grants file (so a saved token never leaks between
 * runs). Async: the scripted hub lives in this process, so a spawnSync would
 * block it from answering.
 */
async function run(...a: string[]) {
  received = [];
  const dir = mkdtempSync(join(tmpdir(), "liagent-reply-"));
  const p = Bun.spawn(["bun", "src/cli.ts", "reply", ...a], {
    env: {
      ...process.env,
      LIAGENT_HUB: `http://127.0.0.1:${server.port}`,
      LIAGENT_GRANTS: join(dir, "grants.json"),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  return { code, err, sent: received };
}

describe("liagent reply", () => {
  it("polishes the line it answers (by --id), then replies", async () => {
    const r = await run("--id", LATEST, "--polish", "And the sync one.", "On it.");
    expect(r.code).toBe(0);
    expect(r.sent.map((m) => m.type)).toEqual(["edit", "say"]);
    expect(r.sent[0]).toMatchObject({ type: "edit", id: LATEST, text: "And the sync one." });
    expect(r.sent[1]).toMatchObject({ type: "say", text: "On it." });
    expect(r.err).toContain(`polished ${LATEST}`);
  });

  it("a stale --id (a newer line arrived meanwhile): the hub refuses, the newer line is untouched, the reply still goes out", async () => {
    const r = await run("--id", "v1", "--polish", "Fix the sync button.", "Done.");
    expect(r.code).toBe(0);
    expect(r.sent.map((m) => m.type)).toEqual(["edit", "say"]);
    // The edit names the answered line, never the latest one in the history.
    expect(r.sent[0]).toMatchObject({ type: "edit", id: "v1" });
    expect(r.sent.some((m) => m.type === "edit" && m.id === LATEST)).toBe(false);
    expect(r.err).toContain("not polished: message v1 is not the owner's latest");
    expect(r.err).toContain("replying anyway");
    expect(r.sent[1]).toMatchObject({ type: "say", text: "Done." });
  });

  it("a polish the hub rejects for another rule (a typed line) is reported; the reply still goes out", async () => {
    const r = await run("--id", "t1", "--polish", "Typed.", "Ok.");
    expect(r.code).toBe(0);
    expect(r.sent.map((m) => m.type)).toEqual(["edit", "say"]);
    expect(r.err).toContain("not polished: message t1");
  });

  it("a friend's reply never polishes: refused before anything is sent", async () => {
    const r = await run("--to", "a@x.com", "--id", LATEST, "--polish", "x", "hi");
    expect(r.code).toBe(2);
    expect(r.err).toContain("a friend's line can never be polished");
    expect(r.sent).toEqual([]);
  });

  it("--polish without --id is refused: a polish is tied to the line being answered", async () => {
    const r = await run("--polish", "Fix it.", "Done.");
    expect(r.code).toBe(2);
    expect(r.err).toContain("needs --id");
    expect(r.sent).toEqual([]);
  });

  it("without --polish, reply is a plain say (--id is ignored); a friend's --to is kept", async () => {
    const r = await run("--to", "a@x.com", "hello");
    expect(r.code).toBe(0);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatchObject({ type: "say", text: "hello", to: "a@x.com" });
  });
});
