import { expect, test } from "bun:test";

// A hub nobody listens on: anything that tried to post would fail, not exit 0 with usage.
const run = (...a: string[]) =>
  Bun.spawnSync(["bun", "src/cli.ts", ...a], {
    env: { ...process.env, LIAGENT_HUB: "ws://127.0.0.1:1" },
    stdin: "ignore",
  });

test("say --help / -h prints usage and never posts", () => {
  for (const h of ["--help", "-h"]) {
    const r = run("say", h);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("liagent");
  }
});

test("say with an unknown flag is refused, not posted", () => {
  const r = run("say", "--bogus", "hi");
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("unknown flag --bogus");
});

test("edit --help prints usage", () => {
  expect(run("edit", "--help").exitCode).toBe(0);
});
