import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantStore, privateAppend, spillTo } from "../src/grants.ts";

const root = mkdtempSync(join(tmpdir(), "liagent-grants-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const mode = (p: string) => statSync(p).mode & 0o777;

test("the grants file is 0600 in a 0700 directory, from its first write", () => {
  const file = join(root, "a", "b", "grants.json");
  const g = grantStore(file);
  g.save("https://dev.example.com/api/chat", "chat", "t1", Date.now() + 1000);
  expect(mode(file)).toBe(0o600);
  expect(mode(join(root, "a", "b"))).toBe(0o700);
  expect(g.load("https://dev.example.com/api/chat", "chat")).toBe("t1");
  expect(g.load("https://dev.example.com/api/chat", "eval")).toBeUndefined();
  g.save("https://dev.example.com/api/chat", "eval", "t2", Date.now() + 1000);
  expect(g.load("https://dev.example.com/api/chat", "eval")).toBe("t2");
  g.forget("https://dev.example.com/api/chat", "chat");
  expect(g.load("https://dev.example.com/api/chat", "chat")).toBeUndefined();
  expect(mode(file)).toBe(0o600);
});

test("the CLI's own directory is tightened even if it existed; an existing file is tightened", () => {
  const dir = join(root, "loose");
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
  const file = join(dir, "grants.json");
  writeFileSync(file, "{}", { mode: 0o644 });
  chmodSync(file, 0o644);
  grantStore(file, true).save("h", "chat", "t", Date.now());
  expect(mode(dir)).toBe(0o700);
  expect(mode(file)).toBe(0o600);
});

test("a custom path's existing folder keeps its mode; a folder we create is 0700", () => {
  const shared = join(root, "shared");
  mkdirSync(shared, { mode: 0o755 });
  chmodSync(shared, 0o755);
  grantStore(join(shared, "grants.json")).save("h", "chat", "t", Date.now());
  expect(mode(shared)).toBe(0o755);
  expect(mode(join(shared, "grants.json"))).toBe(0o600);
  grantStore(join(shared, "made", "grants.json")).save("h", "chat", "t", Date.now());
  expect(mode(join(shared, "made"))).toBe(0o700);
});

test("an existing 0644 file ends up 0600 (privateWrite tightens it before writing)", () => {
  const file = join(root, "old.json");
  writeFileSync(file, "{}", { mode: 0o644 });
  chmodSync(file, 0o644);
  grantStore(file).save("h", "chat", "t", Date.now());
  expect(mode(file)).toBe(0o600);
});

test("inbox files are 0600 in a 0700 directory", () => {
  const p = spillTo(join(root, "inbox"), "ab/c", "long text");
  expect(p.endsWith("ab_c.txt")).toBe(true);
  expect(mode(p)).toBe(0o600);
  expect(mode(join(root, "inbox"))).toBe(0o700);
});

test("the listen --out log is 0600: created that way, or tightened if it existed", () => {
  const fresh = join(root, "chat.jsonl");
  privateAppend(fresh, "a\n");
  privateAppend(fresh, "b\n");
  expect(mode(fresh)).toBe(0o600);
  expect(require("node:fs").readFileSync(fresh, "utf8")).toBe("a\nb\n");
  const old = join(root, "old.jsonl");
  writeFileSync(old, "x\n", { mode: 0o644 });
  chmodSync(old, 0o644);
  privateAppend(old, "y\n");
  expect(mode(old)).toBe(0o600);
});
