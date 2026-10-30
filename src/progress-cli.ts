// `liagent progress …` (src/cli.ts hands it argv): one request to the
// progress hub, then exit. The parsing is src/progress-args.ts.

import { PROGRESS_USAGE, parseProgressArgs, progressRequest } from "./progress-args.ts";

type Out = { log: (s: string) => void; error: (s: string) => void };

/** POST `body` (or GET without one) to `<hub><path>`; the JSON answer, or an Error. */
export async function callProgress(
  hub: string,
  token: string,
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown> | Error> {
  try {
    const res = await fetchImpl(`${hub}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) return new Error(`${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

/** Run `liagent progress <argv>`; the exit code. */
export async function runProgress(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  out: Out = console,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    out.log(PROGRESS_USAGE);
    return 0;
  }
  const cmd = parseProgressArgs(argv, env);
  if (cmd instanceof Error) {
    out.error(`liagent progress: ${cmd.message}\n\n${PROGRESS_USAGE}`);
    return 2;
  }
  if (!cmd.hub) {
    out.error("liagent progress: no hub — pass its URL, --hub, or set LIAGENT_PROGRESS_HUB");
    return 2;
  }
  if (!cmd.token) {
    out.error("liagent progress: no token — pass --token or set LIAGENT_PROGRESS_TOKEN");
    return 2;
  }
  const { path, body } = progressRequest(cmd);
  const res = await callProgress(cmd.hub, cmd.token, path, body, fetchImpl);
  if (res instanceof Error) {
    out.error(`liagent progress: ${res.message}`);
    return 1;
  }
  if (cmd.cmd === "grant") out.log(String(res.token));
  else if (cmd.cmd === "show") out.log(JSON.stringify(res, null, 2));
  else if (cmd.cmd === "resolve") {
    const ids = (res.resolved as string[] | undefined) ?? [];
    out.log(`progress: resolved ${ids.join(", ") || "nothing (already done)"}`);
  } else {
    const e = res.entry as { id: string; status: string; rev: number; pr?: number };
    const pr = e.pr && cmd.repo ? ` https://github.com/${cmd.repo}/pull/${e.pr}` : "";
    out.log(`progress: ${e.id} ${e.status} (rev ${e.rev}, ${res.readers ?? 0} watching)${pr}`);
  }
  return 0;
}
