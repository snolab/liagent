import { describe, expect, it } from "bun:test";
import {
  GRANT_MAX_MS,
  PROGRESS_READER_HEADER,
  ProgressHub,
  type ProgressStorage,
  RATE,
  RESOLVED_NOTE,
  progressGate,
  progressHub,
  routeProgress,
} from "../src/progress-hub.ts";
import type { Socket } from "../src/hub.ts";
import {
  OWNER_NODE,
  PROGRESS_DONE_TTL_MS,
  PROGRESS_LOG_MAX,
  PROGRESS_MAX_ENTRIES,
  type ProgressEntry,
  type ProgressEvent,
  applyProgressMessage,
  autoNode,
  filterWaiting,
  foldProgress,
  mergeProgress,
  parseProgressMessage,
  parseProgressReport,
  parseTtl,
  progressEvent,
  progressLabel,
  progressSlug,
  progressTodo,
} from "../src/progress.ts";
import { mintProgressToken, verifyProgressToken } from "../src/progress-token.ts";
import { parseProgressArgs, progressRequest } from "../src/progress-args.ts";
import { runProgress } from "../src/progress-cli.ts";

const ROOT = "root-secret";

class FakeSocket implements Socket {
  sent: Record<string, unknown>[] = [];
  closed?: number;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closed = code;
  }
  serializeAttachment() {}
  deserializeAttachment() {
    return null;
  }
}
(globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = class {
  0 = new FakeSocket();
  1 = new FakeSocket();
};

function fakeStorage(): ProgressStorage & { store: Map<string, unknown>; alarm: number | null } {
  const store = new Map<string, unknown>();
  return {
    store,
    alarm: null,
    async getAlarm() {
      return this.alarm;
    },
    async setAlarm(at: number) {
      this.alarm = at;
    },
    get: async <T>(k: string) => structuredClone(store.get(k)) as T | undefined,
    put: async (k, v) => void store.set(k, structuredClone(v)),
    delete: async (k) => store.delete(k),
    list: async <T>({ prefix }: { prefix: string }) => {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      return new Map(keys.map((k) => [k, structuredClone(store.get(k)) as T]));
    },
  };
}

function setup(secret: string | undefined = ROOT) {
  let t = 1_000_000;
  const sockets: FakeSocket[] = [];
  const storage = fakeStorage();
  const hub = new ProgressHub(
    {
      acceptWebSocket: (ws) => sockets.push(ws as FakeSocket),
      getWebSockets: () => sockets,
      storage,
    },
    { PROGRESS_TOKEN: secret },
    () => t,
  );
  const call = async (path: string, token: string, body?: unknown, method = "POST") => {
    const res = await hub.fetch(
      new Request(`https://example.com/api/progress${path}`, {
        method,
        headers: { authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const write = (token: string, body: Record<string, unknown>) =>
    call("", token, { status: "doing", task: "t", ...body });
  const reader = async () => {
    const res = await hub.fetch(
      new Request("https://example.com/api/progress", {
        headers: { upgrade: "websocket", [PROGRESS_READER_HEADER]: "1" },
      }),
    );
    expect(res.status).toBe(101);
    return sockets.at(-1)!;
  };
  const grant = async (token: string, node: string, agent: string, ttl?: string) =>
    (await call("/grant", token, { node, agent, ttl })).body.token as string;
  const entry = (id: string) => storage.store.get(`e:${id}`) as ProgressEntry | undefined;
  return {
    hub,
    storage,
    sockets,
    call,
    write,
    reader,
    grant,
    entry,
    tick: (ms: number) => (t += ms),
    now: () => t,
  };
}

describe("progress tokens", () => {
  it("knows the root, verifies a scoped token, and refuses forgeries and expiry", async () => {
    expect(await verifyProgressToken(ROOT, ROOT)).toEqual({ root: true });
    const tok = await mintProgressToken(ROOT, {
      node: "/words",
      agent: "a",
      exp: 2000,
      via: "root",
    });
    expect(await verifyProgressToken(ROOT, tok, 1000)).toEqual({
      root: false,
      node: "/words",
      agent: "a",
      exp: 2000,
      via: "root",
    });
    expect(await verifyProgressToken(ROOT, tok, 2000)).toBeNull();
    const forged = await mintProgressToken("other", { node: "/", agent: "a", exp: 9e15 });
    expect(await verifyProgressToken(ROOT, forged)).toBeNull();
    const [, sig] = tok.split(".");
    const widened = `${btoa(JSON.stringify({ node: "/", agent: "a", exp: 9e15 })).replace(/=+$/, "")}.${sig}`;
    expect(await verifyProgressToken(ROOT, widened)).toBeNull();
    expect(await verifyProgressToken(ROOT, "a.b.c")).toBeNull();
    expect(await verifyProgressToken(ROOT, "a.!!")).toBeNull();
    expect(await verifyProgressToken(ROOT, "")).toBeNull();
    expect(await verifyProgressToken("", ROOT)).toBeNull();
    // A signed payload that is not a grant.
    const bad = await mintProgressToken(ROOT, { node: 1 } as never);
    expect(await verifyProgressToken(ROOT, bad)).toBeNull();
    const notJson = `bm90IGpzb24.${(await mintProgressToken(ROOT, { node: "x", agent: "a", exp: 1 })).split(".")[1]}`;
    expect(await verifyProgressToken(ROOT, notJson)).toBeNull();
  });
});

describe("parseProgressReport", () => {
  const ok = (b: Record<string, unknown>) =>
    parseProgressReport({ status: "doing", task: "t", agent: "a", ...b });
  it("validates and normalises", () => {
    expect(parseProgressReport(null)).toBeInstanceOf(Error);
    expect(parseProgressReport([])).toBeInstanceOf(Error);
    expect(parseProgressReport({ task: "t", status: "doing" })).toBeInstanceOf(Error);
    expect(ok({ task: "" })).toBeInstanceOf(Error);
    expect(ok({ status: "nope" })).toBeInstanceOf(Error);
    expect(ok({ kind: "nope" })).toBeInstanceOf(Error);
    expect(ok({ agent: "x".repeat(41) })).toBeInstanceOf(Error);
    expect(ok({ agent: 3 })).toBeInstanceOf(Error);
    expect(ok({ task: 3 })).toBeInstanceOf(Error);
    expect(ok({ note: "x".repeat(281) })).toBeInstanceOf(Error);
    expect(ok({ id: "Bad Id" })).toBeInstanceOf(Error);
    expect(ok({ id: "/words/a", parent: "/other" })).toBeInstanceOf(Error);
    expect(ok({ id: "x", parent: "x" })).toBeInstanceOf(Error);
    expect(ok({ pct: 101 })).toBeInstanceOf(Error);
    expect(ok({ pr: 1.5 })).toBeInstanceOf(Error);
    expect(ok({ link: "http://x" })).toBeInstanceOf(Error);
    expect(ok({ agent: "!!", task: "??" })).toBeInstanceOf(Error);
    expect(
      parseProgressReport({ status: "doing", task: "t", assignee: { type: "robot" } }),
    ).toBeInstanceOf(Error);
    expect(
      parseProgressReport({ status: "doing", task: "t", assignee: { type: "human", name: "" } }),
    ).toBeInstanceOf(Error);
    expect(
      parseProgressReport({ status: "doing", task: "t", assignee: { type: "human", name: 1 } }),
    ).toBeInstanceOf(Error);
    expect(
      ok({ task: "Live\nroadmap", pct: 39.6, pr: 3, needs: "", eta: "5m", link: "https://x" }),
    ).toEqual({
      id: "a-live-roadmap",
      assignee: { type: "agent", name: "a" },
      task: "Live roadmap",
      status: "doing",
      pct: 40,
      pr: 3,
      needs: "",
      eta: "5m",
      link: "https://x",
    });
    expect(ok({ id: "/words/prefetch", kind: "feedback" })).toMatchObject({
      id: "/words/prefetch",
      parent: "/words",
      kind: "feedback",
    });
    expect(
      parseProgressReport({ status: "done", task: "t", assignee: { type: "human", name: "h" } }),
    ).toMatchObject({ assignee: { type: "human", name: "h" } });
  });
  it("labels and slugs", () => {
    expect(progressLabel("/words/prefetch/x")).toBe("/words › prefetch › x");
    expect(progressLabel("slug")).toBe("slug");
    expect(progressSlug("Agent", "Do it!")).toBe("agent-do-it");
    expect(parseTtl("8h")).toBe(8 * 3_600_000);
    expect(parseTtl("forever")).toBeInstanceOf(Error);
  });
});

describe("CLI args", () => {
  it("parses flags into a report", () => {
    expect(
      parseProgressArgs([
        "--agent",
        "a",
        "--task=Ship it",
        "--done",
        "--pct",
        "40%",
        "--pr",
        "#299",
      ]),
    ).toMatchObject({
      cmd: "report",
      report: { status: "done", pct: 40, pr: 299, task: "Ship it" },
    });
    expect(
      parseProgressArgs([
        "--agent=o",
        "--human",
        "--path",
        "/words/a",
        "--task",
        "t",
        "--status",
        "waiting-owner",
        "--kind",
        "decision",
        "--rev",
        "3",
        "--token",
        "tk",
      ]),
    ).toEqual({
      cmd: "report",
      token: "tk",
      report: {
        id: "/words/a",
        parent: "/words",
        assignee: { type: "human", name: "o" },
        task: "t",
        status: "waiting-owner",
        kind: "decision",
        rev: 3,
      },
    });
    expect(parseProgressArgs(["--path", "/a", "--id", "/b", "--agent", "a"])).toBeInstanceOf(Error);
    expect(parseProgressArgs(["--agent", "a", "--task", "t"])).toBeInstanceOf(Error);
    expect(parseProgressArgs(["grant", "--node", "/words", "--agent", "w"])).toEqual({
      cmd: "grant",
      node: "/words",
      agent: "w",
      ttl: "8h",
    });
    expect(
      parseProgressArgs(["grant", "--node", "/w", "--agent", "w", "--ttl", "x"]),
    ).toBeInstanceOf(Error);
    expect(parseProgressArgs(["grant", "--node", "Bad"])).toBeInstanceOf(Error);
    expect(parseProgressArgs(["grant", "--node", "/w"])).toBeInstanceOf(Error);
    expect(parseProgressArgs(["resolve", "--id", "/@owner/x", "--note", "B"])).toEqual({
      cmd: "resolve",
      id: "/@owner/x",
      note: "B",
    });
    expect(parseProgressArgs(["resolve", "--id", "/x"])).toEqual({ cmd: "resolve", id: "/x" });
    expect(parseProgressArgs(["resolve"])).toBeInstanceOf(Error);
    expect(parseProgressArgs(["show", "--token=t"])).toEqual({ cmd: "show", token: "t" });
    expect(parseProgressArgs(["oops"])).toBeInstanceOf(Error);
    expect(parseProgressArgs(["--agent"])).toBeInstanceOf(Error);
    expect(parseProgressArgs(["--pct", "x"])).toBeInstanceOf(Error);
    expect(parseProgressArgs(["--bogus", "1"])).toBeInstanceOf(Error);
  });
});

describe("foldProgress", () => {
  const e = (id: string, extra: Partial<ProgressEntry> = {}): ProgressEntry => ({
    ...mergeProgress(
      undefined,
      parseProgressReport({ id, task: id, status: "doing", agent: "a" }) as never,
      1,
    ),
    ...extra,
  });
  it("builds the tree with counts, owner flags and order", () => {
    const tree = foldProgress([
      autoNode("/words", "a", 1),
      e("/words/a", { at: 5 }),
      e("/words/b", { kind: "feedback", at: 4 }),
      e("/words/c", { status: "done", at: 3 }),
      e("/words/d", { kind: "decision", at: 2 }),
      autoNode(OWNER_NODE, "a", 1),
      e(`${OWNER_NODE}/t1`, { kind: "approval", ref: "/words/a" }),
      e("x", { parent: "y" }),
      e("y", { parent: "x" }),
      { ...progressEvent(e("/_infra"), "n") } as ProgressEvent,
    ]);
    const words = tree.find((n) => n.id === "/words")!;
    expect(words.counts).toEqual({ tasks: 3, feedback: 1 });
    expect(words.children.map((n) => n.id)).toEqual([
      "/words/a",
      "/words/d",
      "/words/b",
      "/words/c",
    ]);
    expect(words.children[0]!.waitingOwner).toBe(true); // ref'd by an open to-do
    expect(words.waitingOwnerCount).toBe(2);
    expect(tree.find((n) => n.id === OWNER_NODE)!.waitingOwnerCount).toBe(1);
    expect(tree.map((n) => n.id)).toContain("x"); // a loop's nodes are roots
    const waiting = filterWaiting(tree);
    expect(waiting.map((n) => n.id).sort()).toEqual([OWNER_NODE, "/words"].sort());
    expect(waiting.find((n) => n.id === "/words")!.children.map((n) => n.id)).toEqual([
      "/words/a",
      "/words/d",
    ]);
    expect(
      progressTodo([
        e(`${OWNER_NODE}/b`, { created: 2 }),
        e(`${OWNER_NODE}/a`, { created: 1 }),
        e("/words/z"),
      ]).map((x) => x.id),
    ).toEqual([`${OWNER_NODE}/a`, `${OWNER_NODE}/b`]);
  });
});

describe("reader messages", () => {
  it("parses and applies snapshots and events, merging notes", () => {
    const entry = mergeProgress(
      undefined,
      parseProgressReport({ id: "n", task: "t", status: "doing", agent: "a" }) as never,
      1,
    );
    expect(parseProgressMessage("nope")).toBeNull();
    expect(parseProgressMessage(3)).toBeNull();
    expect(parseProgressMessage("null")).toBeNull();
    expect(parseProgressMessage(JSON.stringify({ type: "other" }))).toBeNull();
    const snap = parseProgressMessage(
      JSON.stringify({ type: "snapshot", entries: [entry, { id: 1 }] }),
    )!;
    expect(snap).toEqual({ type: "snapshot", entries: [entry], log: [] });
    let view = applyProgressMessage({ rows: [], log: [] }, snap);
    const ev = parseProgressMessage(JSON.stringify(progressEvent({ ...entry, at: 2 }, "hello")))!;
    view = applyProgressMessage(view, ev);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]!.notes?.[0]!.text).toBe("hello");
    expect(view.log).toHaveLength(1);
    view = applyProgressMessage(view, progressEvent({ ...entry, at: 3 }));
    expect(view.rows[0]!.notes).toHaveLength(1);
  });
});

describe("ProgressHub", () => {
  it("refuses without a token or a secret", async () => {
    const h = setup();
    expect((await h.call("", "wrong", {})).status).toBe(401);
    const none = setup("");
    expect((await none.call("", ROOT, {})).status).toBe(401);
    expect(
      (
        await h.hub.fetch(
          new Request("https://example.com/x", { headers: { upgrade: "websocket" } }),
        )
      ).status,
    ).toBe(403);
    expect((await h.call("", ROOT, undefined, "PUT")).status).toBe(405);
    expect((await h.call("", ROOT, "x".repeat(5000))).status).toBe(413);
    const bad = await h.hub.fetch(
      new Request("https://example.com/api/progress", {
        method: "POST",
        headers: { authorization: `Bearer ${ROOT}` },
        body: "{",
      }),
    );
    expect(bad.status).toBe(400);
    expect((await h.write(ROOT, {})).status).toBe(400);
  });

  it("persists, broadcasts, logs, and auto-creates path ancestors", async () => {
    const h = setup();
    const ws = await h.reader();
    expect(ws.sent[0]).toEqual({ type: "snapshot", entries: [], log: [] });
    const r = await h.write(ROOT, { agent: "main", id: "/words/prefetch/a", note: "hi", pct: 10 });
    expect(r.status).toBe(200);
    expect(h.entry("/words")).toMatchObject({ kind: "group", creator: "_auto" });
    expect(h.entry("/words/prefetch/a")).toMatchObject({
      rev: 1,
      pct: 10,
      notes: [{ text: "hi" }],
    });
    expect(ws.sent.slice(1).map((m) => m.id)).toEqual([
      "/words",
      "/words/prefetch",
      "/words/prefetch/a",
    ]);
    // Claiming an auto group, keeping fields, appending notes, clearing needs.
    await h.write(ROOT, { agent: "main", id: "/words", needs: "look" });
    expect(h.entry("/words")).toMatchObject({ creator: "main", kind: "task", needs: "look" });
    h.tick(1);
    await h.write(ROOT, { agent: "main", id: "/words/prefetch/a", note: "more", needs: "" });
    expect(h.entry("/words/prefetch/a")).toMatchObject({ rev: 2, pct: 10 });
    expect(h.entry("/words/prefetch/a")!.notes).toHaveLength(2);
    const got = await h.call("", ROOT, undefined, "GET");
    expect(got.body.entries).toHaveLength(3);
    expect(got.body.log).toHaveLength(5);
    // Slug ids need a known parent, and may not loop.
    expect((await h.write(ROOT, { agent: "main", id: "s1", parent: "nope" })).status).toBe(400);
    await h.write(ROOT, { agent: "main", id: "s1" });
    await h.write(ROOT, { agent: "main", id: "s2", parent: "s1" });
    expect((await h.write(ROOT, { agent: "main", id: "s1", parent: "s2" })).status).toBe(400);
    h.hub.webSocketClose(ws, 1005);
    expect(ws.closed).toBe(1000);
    h.hub.webSocketError(ws);
    expect(ws.closed).toBe(1011);
  });

  it("rejects a stale rev with the current one", async () => {
    const h = setup();
    await h.write(ROOT, { agent: "a", id: "n", rev: 5 });
    const r = await h.write(ROOT, { agent: "a", id: "n", rev: 5 });
    expect(r.status).toBe(409);
    expect(r.body.rev).toBe(5);
    expect((await h.write(ROOT, { agent: "a", id: "n", rev: 6 })).status).toBe(200);
  });

  it("keeps a scoped token inside its subtree", async () => {
    const h = setup();
    await h.write(ROOT, { agent: "main", id: "s-root" });
    await h.write(ROOT, { agent: "main", id: "elsewhere" });
    const tok = await h.grant(ROOT, "/words", "w");
    const slug = await h.grant(ROOT, "s-root", "s");
    // Inside: its node, and paths below it.
    expect((await h.write(tok, { agent: "w", id: "/words" })).status).toBe(200);
    expect((await h.write(tok, { agent: "w", id: "/words/a/b" })).status).toBe(200);
    // Another name, or outside.
    expect((await h.write(tok, { agent: "x", id: "/words/a" })).status).toBe(403);
    expect((await h.write(tok, { agent: "w", id: "/_infra/x" })).status).toBe(403);
    expect((await h.write(tok, { agent: "w", id: "elsewhere" })).status).toBe(403);
    // A new slug child must name a parent in scope; it may not re-parent out.
    expect((await h.write(slug, { agent: "s", id: "c1" })).status).toBe(403);
    expect((await h.write(slug, { agent: "s", id: "c1", parent: "elsewhere" })).status).toBe(403);
    expect((await h.write(slug, { agent: "s", id: "c1", parent: "s-root" })).status).toBe(200);
    expect((await h.write(slug, { agent: "s", id: "c1", parent: "elsewhere" })).status).toBe(403);
    expect((await h.write(slug, { agent: "s", id: "s-root", parent: "c1" })).status).toBe(403);
    expect((await h.write(slug, { agent: "s", id: "c2", parent: "s-root" })).status).toBe(200);
    expect((await h.write(slug, { agent: "s", id: "c2", parent: "c1" })).status).toBe(200);
    // Status belongs to the creator, or a scope above.
    const sub = await h.grant(tok, "/words/a/b", "w2");
    expect((await h.write(sub, { agent: "w2", id: "/words/a/b", status: "done" })).status).toBe(
      403,
    );
    expect((await h.write(sub, { agent: "w2", id: "/words/a/b", note: "fyi" })).status).toBe(200);
    expect((await h.write(sub, { agent: "w2", id: "/words/a/b", pct: 5 })).status).toBe(403);
    expect((await h.write(tok, { agent: "w", id: "/words/a/b", status: "review" })).status).toBe(
      200,
    );
    // A to-do for the owner, about something in scope.
    expect((await h.write(tok, { agent: "w", id: `${OWNER_NODE}/x`, ref: "/_infra" })).status).toBe(
      403,
    );
    expect(
      (
        await h.write(tok, {
          agent: "w",
          id: `${OWNER_NODE}/x`,
          kind: "approval",
          ref: "/words/a/b",
        })
      ).status,
    ).toBe(200);
    expect(h.entry(OWNER_NODE)).toMatchObject({ kind: "person", assignee: { type: "human" } });
    expect(
      (await h.write(sub, { agent: "w2", id: `${OWNER_NODE}/x`, ref: "/words/a/b" })).status,
    ).toBe(403);
    // Any valid token reads.
    expect((await h.call("", sub, undefined, "GET")).status).toBe(200);
  });

  it("delegates only inside scope, never past the parent's expiry", async () => {
    const h = setup();
    const tok = await h.grant(ROOT, "/words", "w", "1h");
    const sub = await h.call("/grant", tok, { node: "/words/a", agent: "w2", ttl: "9d" });
    expect(sub.body).toMatchObject({ node: "/words/a", via: "/words", exp: h.now() + 3_600_000 });
    expect((await h.call("/grant", tok, { node: "/_infra", agent: "w2" })).status).toBe(403);
    expect((await h.call("/grant", tok, { node: "Bad", agent: "w2" })).status).toBe(400);
    expect((await h.call("/grant", tok, { node: "/words/a", agent: "" })).status).toBe(400);
    expect((await h.call("/grant", tok, { node: "/words/a", agent: "w", ttl: "x" })).status).toBe(
      400,
    );
    const root = await h.call("/grant", ROOT, { node: "/x", agent: "a", ttl: "30d" });
    expect(root.body.exp).toBe(h.now() + GRANT_MAX_MS);
    h.tick(3_600_000);
    expect((await h.write(sub.body.token, { agent: "w2", id: "/words/a" })).status).toBe(401);
  });

  it("resolves a to-do and the decision it refs, from the CLI or the page", async () => {
    const h = setup();
    const ws = await h.reader();
    await h.write(ROOT, { agent: "a", id: "/_infra/d", kind: "decision", needs: "pick" });
    await h.write(ROOT, { agent: "a", id: `${OWNER_NODE}/d`, kind: "decision", ref: "/_infra/d" });
    const tok = await h.grant(ROOT, "/_infra", "a");
    expect((await h.call("/resolve", tok, { id: "/_infra/d" })).status).toBe(403);
    expect((await h.call("/resolve", ROOT, {})).status).toBe(400);
    expect((await h.call("/resolve", ROOT, { id: "/nope" })).status).toBe(404);
    const r = await h.call("/resolve", ROOT, { id: `${OWNER_NODE}/d`, note: "B" });
    expect(r.body.resolved).toEqual([`${OWNER_NODE}/d`, "/_infra/d"]);
    expect(h.entry("/_infra/d")).toMatchObject({ status: "done", creator: "a", by: "owner" });
    expect(h.entry("/_infra/d")!.needs).toBeUndefined();
    expect(ws.sent.at(-1)).toMatchObject({ id: "/_infra/d", note: "B" });
    // The page's check-off.
    await h.write(ROOT, { agent: "a", id: "/_infra/e", kind: "approval" });
    await h.hub.webSocketMessage(ws, "{");
    await h.hub.webSocketMessage(ws, JSON.stringify({ type: "other" }));
    await h.hub.webSocketMessage(
      ws,
      new TextEncoder().encode(JSON.stringify({ type: "resolve", id: "/_infra/e" })).buffer,
    );
    expect(h.entry("/_infra/e")!.notes!.at(-1)!.text).toBe(RESOLVED_NOTE);
    expect((await h.call("/resolve", ROOT, { id: "/_infra/e" })).body.resolved).toEqual([]);
  });

  it("prunes done nodes and empty groups by alarm, and caps the store and the log", async () => {
    const h = setup();
    const ws = await h.reader();
    await h.write(ROOT, { agent: "a", id: "/g/x", status: "done" });
    expect(h.storage.alarm).toBe(h.now() + PROGRESS_DONE_TTL_MS);
    h.tick(1000);
    await h.write(ROOT, { agent: "a", id: "/h/y", status: "done" });
    h.tick(PROGRESS_DONE_TTL_MS - 500);
    await h.hub.alarm();
    expect(h.entry("/g/x")).toBeUndefined();
    expect(h.entry("/g")).toBeUndefined();
    expect(h.entry("/h/y")).toBeDefined();
    expect(h.storage.alarm).toBe(h.now() + 500);
    expect(ws.sent.at(-1)!.type).toBe("snapshot");
    // Cap: the oldest done go first.
    const big = setup();
    await big.write(ROOT, { agent: "a", id: "old-done", status: "done" });
    for (let i = 1; i < PROGRESS_MAX_ENTRIES; i++) {
      big.tick(RATE.windowMs);
      await big.write(ROOT, { agent: "a", id: `n${i}` });
    }
    big.tick(RATE.windowMs);
    await big.write(ROOT, { agent: "a", id: "one-more" });
    expect(big.entry("old-done")).toBeUndefined();
    big.tick(RATE.windowMs);
    await big.write(ROOT, { agent: "a", id: "two-more" });
    expect(big.entry("n1")).toBeUndefined();
    expect([...big.storage.store.keys()].filter((k) => k.startsWith("l:"))).toHaveLength(
      PROGRESS_LOG_MAX,
    );
  });

  it("rate limits each name", async () => {
    const h = setup();
    for (let i = 0; i < RATE.perName; i++) await h.write(ROOT, { agent: "a", id: "n" });
    const r = await h.hub.fetch(
      new Request("https://example.com/api/progress", {
        method: "POST",
        headers: { authorization: `Bearer ${ROOT}` },
        body: JSON.stringify({ agent: "a", id: "n", task: "t", status: "doing" }),
      }),
    );
    expect(r.status).toBe(429);
    for (let i = 0; i < RATE.perName; i++) await h.call("/resolve", ROOT, { id: "n" });
    expect((await h.call("/resolve", ROOT, { id: "n" })).status).toBe(429);
  });
});

describe("progressHub", () => {
  it("reads its secret from the named env binding", async () => {
    const Hub = progressHub({ secretVar: "MY_SECRET" });
    const storage = fakeStorage();
    const hub = new Hub(
      { acceptWebSocket: () => {}, getWebSockets: () => [], storage },
      { MY_SECRET: ROOT, PROGRESS_TOKEN: "other" },
    );
    const get = (token: string) =>
      hub.fetch(
        new Request("https://example.com/api/progress", {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
    expect((await get(ROOT)).status).toBe(200);
    expect((await get("other")).status).toBe(401);
  });
});

describe("routeProgress", () => {
  const seen: Request[] = [];
  const ns = {
    idFromName: (n: string) => n,
    get: () => ({
      fetch: async (r: Request) => {
        seen.push(r);
        return new Response("p");
      },
    }),
  };
  const go = async (
    url: string,
    init: RequestInit,
    opts: Partial<Parameters<typeof routeProgress>[2]> = {},
  ) => {
    const r = await routeProgress(new Request(url, init), ns, {
      secret: ROOT,
      reader: () => true,
      ...opts,
    });
    return r ? `${r.status} ${await r.text()}` : null;
  };
  const U = "https://example.com/api/progress";

  it("gates writers and lets the host decide readers", async () => {
    expect(await go("https://example.com/other", {})).toBeNull();
    expect(await go("https://example.com/api/progressive", {})).toBeNull();
    expect(await go(U, { method: "POST" }, { secret: undefined })).toStartWith("503");
    expect(await go(U, { method: "POST", headers: { origin: "https://x" } })).toStartWith("403");
    expect(await go(U, { method: "POST" })).toStartWith("401");
    expect(
      await go(`${U}/grant`, {
        method: "POST",
        headers: { authorization: "Bearer t", [PROGRESS_READER_HEADER]: "1" },
      }),
    ).toBe("200 p");
    expect(seen.at(-1)!.headers.get(PROGRESS_READER_HEADER)).toBeNull();
    const ws = { upgrade: "websocket", origin: "https://example.com", cookie: "s=1" };
    expect(await go(U, { headers: ws }, { reader: () => false })).toStartWith("403");
    expect(
      await go(
        U,
        { headers: ws },
        {
          reader: () => {
            throw new Error("no session");
          },
        },
      ),
    ).toStartWith("403");
    expect(await go(U, { headers: { ...ws, origin: "https://evil.example" } })).toStartWith(
      "403 forbidden origin",
    );
    expect(
      await go(
        U,
        { headers: { ...ws, origin: "https://app.example" } },
        {
          allowedOrigins: ["https://app.example"],
        },
      ),
    ).toBe("200 p");
    let asked: Request | undefined;
    expect(
      await go(
        U,
        { headers: ws },
        {
          reader: async (r) => {
            asked = r;
            return true;
          },
        },
      ),
    ).toBe("200 p");
    expect(asked!.headers.get("cookie")).toBe("s=1");
    expect(seen.at(-1)!.headers.get(PROGRESS_READER_HEADER)).toBe("1");
    expect(
      await go(
        "https://example.com/p/x",
        { method: "GET", headers: { authorization: "Bearer t" } },
        { path: "/p/" },
      ),
    ).toBe("200 p");
    expect(progressGate(new Request(U), ROOT)!.status).toBe(401);
    expect(
      progressGate(new Request(U, { headers: { authorization: "Bearer t" } }), ROOT),
    ).toBeNull();
  });
});

describe("liagent progress", () => {
  it("takes the hub, agent, path, token and repo from flags or the environment", () => {
    const env = {
      LIAGENT_PROGRESS_HUB: "https://h.example/api/progress/",
      LIAGENT_PROGRESS_TOKEN: "envtok",
      LIAGENT_AGENT: "sub",
      LIAGENT_TASK_PATH: "/words/a",
      LIAGENT_REPO: "o/r",
    };
    expect(parseProgressArgs(["--task", "t", "--status", "doing"], env)).toEqual({
      cmd: "report",
      hub: "https://h.example/api/progress",
      token: "envtok",
      repo: "o/r",
      report: {
        id: "/words/a",
        parent: "/words",
        assignee: { type: "agent", name: "sub" },
        task: "t",
        status: "doing",
      },
    });
    expect(
      parseProgressArgs(
        [
          "https://x.example/p",
          "--id",
          "slug",
          "--agent",
          "me",
          "--task",
          "t",
          "--done",
          "--token",
          "t2",
        ],
        env,
      ),
    ).toMatchObject({
      hub: "https://x.example/p",
      token: "t2",
      report: { id: "slug", assignee: { name: "me" }, status: "done" },
    });
    expect(parseProgressArgs(["show", "--hub", "https://y.example/p"])).toEqual({
      cmd: "show",
      hub: "https://y.example/p",
    });
    expect(parseProgressArgs(["show", "https://y.example/p"])).toMatchObject({
      hub: "https://y.example/p",
    });
    expect(parseProgressArgs(["show", "--repo", "not a repo"])).toBeInstanceOf(Error);
    const report = parseProgressArgs([
      "--agent",
      "a",
      "--id",
      "n",
      "--task",
      "t",
      "--status",
      "doing",
    ]);
    expect(progressRequest(report as never)).toMatchObject({ path: "", body: { id: "n" } });
    expect(progressRequest({ cmd: "grant", node: "/a", agent: "b", ttl: "1h" })).toEqual({
      path: "/grant",
      body: { node: "/a", agent: "b", ttl: "1h" },
    });
    expect(progressRequest({ cmd: "resolve", id: "/a" })).toEqual({
      path: "/resolve",
      body: { id: "/a" },
    });
    expect(progressRequest({ cmd: "resolve", id: "/a", note: "n" }).body).toEqual({
      id: "/a",
      note: "n",
    });
    expect(progressRequest({ cmd: "show" })).toEqual({ path: "" });
  });

  it("makes one request against a real hub and prints the answer", async () => {
    const h = setup();
    const lines: string[] = [];
    const errors: string[] = [];
    const out = { log: (s: string) => lines.push(s), error: (s: string) => errors.push(s) };
    const viaHub = (async (url: string, init: RequestInit) =>
      h.hub.fetch(new Request(url, init))) as unknown as typeof fetch;
    const run = (argv: string[], env: Record<string, string> = {}) =>
      runProgress(
        argv,
        { LIAGENT_PROGRESS_HUB: "https://example.com/api/progress", ...env },
        out,
        viaHub,
      );
    expect(await run(["--help"])).toBe(0);
    expect(lines.pop()).toContain("liagent progress");
    expect(await run(["--agent", "a"])).toBe(2);
    expect(await run(["--agent", "a", "--task", "t", "--status", "doing"])).toBe(2);
    expect(errors.pop()).toContain("no token");
    expect(await runProgress(["show", "--token", ROOT], {}, out, viaHub)).toBe(2);
    expect(errors.pop()).toContain("no hub");
    const env = { LIAGENT_PROGRESS_TOKEN: ROOT, LIAGENT_REPO: "o/r" };
    expect(
      await run(
        ["--agent", "a", "--path", "/w/x", "--task", "t", "--status", "doing", "--pr", "7"],
        env,
      ),
    ).toBe(0);
    expect(lines.pop()).toBe(
      "progress: /w/x doing (rev 1, 0 watching) https://github.com/o/r/pull/7",
    );
    expect(await run(["grant", "--node", "/w", "--agent", "b"], env)).toBe(0);
    const tok = lines.pop()!;
    expect(await verifyProgressToken(ROOT, tok, h.now())).toMatchObject({ node: "/w", agent: "b" });
    expect(await run(["resolve", "--id", "/w/x"], env)).toBe(0);
    expect(lines.pop()).toBe("progress: resolved /w/x");
    expect(await run(["resolve", "--id", "/w/x"], env)).toBe(0);
    expect(lines.pop()).toContain("nothing");
    expect(await run(["show"], env)).toBe(0);
    expect(JSON.parse(lines.pop()!).entries).toHaveLength(2);
    expect(await run(["resolve", "--id", "/w/x"], { LIAGENT_PROGRESS_TOKEN: tok })).toBe(1);
    expect(errors.pop()).toContain("403");
  });
});
