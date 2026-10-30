// The arguments of `liagent progress …`, parsed into what it sends. Pure
// (argv and env in, a command or an Error out), so it is tested without the
// network; src/progress-cli.ts does the request.

import {
  PROGRESS_KINDS,
  PROGRESS_STATUSES,
  type ProgressReport,
  isProgressId,
  parseProgressReport,
  parseTtl,
} from "./progress.ts";

export const PROGRESS_USAGE = `liagent progress — report to the live state tree (a progress hub, src/progress-hub.ts).

  liagent progress [hub] --agent <name> --task "<text>" --status <${PROGRESS_STATUSES.join("|")}>
      [--path /words/prefetch | --id <slug> [--parent <id>]] [--done] [--pct 40] [--eta 15m]
      [--pr 299] [--note "..."] [--needs "approve PR #299"] [--kind <${PROGRESS_KINDS.join("|")}>]
      [--ref <id>] [--action "<command or URL>"] [--link https://…] [--rev N] [--human]
  liagent progress grant   [hub] --node <id> --agent <name> [--ttl 8h]
      Mint a token for <name> scoped to <id> and its subtree (inside your own
      scope, never outliving your token); prints it.
  liagent progress resolve [hub] --id <id> [--note "the answer"]
      Check a node off as the owner (the root token only).
  liagent progress show    [hub]
      The whole tree and the log, as JSON.

  --agent defaults to $LIAGENT_AGENT and --path to $LIAGENT_TASK_PATH.
  [hub] is the hub's URL, e.g. https://example.com/api/progress (or --hub;
  default $LIAGENT_PROGRESS_HUB). The token is --token, else
  $LIAGENT_PROGRESS_TOKEN: the hub's secret (the root) or a scoped token.
  --repo owner/name (or $LIAGENT_REPO) prints --pr as a link.`;

export type ProgressCommand = { token?: string; hub?: string; repo?: string } & (
  | { cmd: "report"; report: ProgressReport }
  | { cmd: "grant"; node: string; agent: string; ttl: string }
  | { cmd: "resolve"; id: string; note?: string }
  | { cmd: "show" }
);

const STRINGS = [
  "agent",
  "task",
  "status",
  "eta",
  "note",
  "id",
  "parent",
  "path",
  "needs",
  "kind",
  "ref",
  "action",
  "link",
  "token",
  "node",
  "ttl",
  "hub",
  "repo",
] as const;
const NUMBERS = ["pct", "pr", "rev"] as const;
const SWITCHES = ["done", "human"] as const;
const SUBS = ["grant", "resolve", "show"] as const;

type Env = Record<string, string | undefined>;

/**
 * argv (after `progress`) → the command, or an Error naming what is wrong.
 * A first (or post-subcommand) argument that is a URL is the hub.
 */
export function parseProgressArgs(argv: string[], env: Env = {}): ProgressCommand | Error {
  const sub = (SUBS as readonly string[]).includes(argv[0] ?? "") ? argv[0]! : "report";
  const raw: Record<string, unknown> = {};
  let i = sub === "report" ? 0 : 1;
  if (argv[i] && /^(https?|wss?):\/\//.test(argv[i]!)) raw.hub = argv[i++];
  for (; i < argv.length; i++) {
    const arg = argv[i]!;
    const m = /^--([a-z]+)(?:=(.*))?$/s.exec(arg);
    if (!m) return new Error(`unexpected argument: ${arg}`);
    const name = m[1]!;
    if ((SWITCHES as readonly string[]).includes(name)) {
      raw[name] = true;
      continue;
    }
    const value = m[2] ?? argv[++i];
    if (value === undefined) return new Error(`--${name} needs a value`);
    if ((STRINGS as readonly string[]).includes(name)) raw[name] = value;
    else if ((NUMBERS as readonly string[]).includes(name)) {
      const n = Number(value.replace(/^#|%$/g, ""));
      if (value.trim() === "" || !Number.isFinite(n))
        return new Error(`--${name} must be a number`);
      raw[name] = n;
    } else return new Error(`unknown flag: --${name}`);
  }
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const common: { token?: string; hub?: string; repo?: string } = {};
  const token = str(raw.token) ?? str(env.LIAGENT_PROGRESS_TOKEN);
  const hub = (str(raw.hub) ?? str(env.LIAGENT_PROGRESS_HUB))?.replace(/\/+$/, "");
  const repo = str(raw.repo) ?? str(env.LIAGENT_REPO);
  if (token) common.token = token;
  if (hub) common.hub = hub;
  if (repo) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return new Error("--repo must be owner/name");
    common.repo = repo;
  }
  if (sub === "show") return { cmd: "show", ...common };
  const agent = str(raw.agent) ?? str(env.LIAGENT_AGENT);
  if (sub === "grant") {
    if (!isProgressId(raw.node)) return new Error("grant needs --node <id>");
    if (typeof raw.agent !== "string" || !raw.agent) return new Error("grant needs --agent <name>");
    const ttl = typeof raw.ttl === "string" ? raw.ttl : "8h";
    const ms = parseTtl(ttl);
    if (ms instanceof Error) return new Error(`--ttl: ${ms.message}`);
    return { cmd: "grant", node: raw.node, agent: raw.agent, ttl, ...common };
  }
  if (sub === "resolve") {
    if (!isProgressId(raw.id)) return new Error("resolve needs --id <id>");
    return {
      cmd: "resolve",
      id: raw.id,
      ...(typeof raw.note === "string" ? { note: raw.note } : {}),
      ...common,
    };
  }
  if (raw.done) raw.status = "done";
  if (raw.path === undefined && raw.id === undefined && str(env.LIAGENT_TASK_PATH))
    raw.path = str(env.LIAGENT_TASK_PATH);
  if (raw.path !== undefined) {
    if (raw.id !== undefined && raw.id !== raw.path) return new Error("--path and --id differ");
    raw.id = raw.path;
  }
  if (agent) raw.agent = agent;
  if (raw.human) {
    raw.assignee = { type: "human", name: raw.agent };
    delete raw.agent;
  }
  for (const k of ["path", "done", "human", "token", "hub", "repo"]) delete raw[k];
  const report = parseProgressReport(raw);
  return report instanceof Error ? report : { cmd: "report", report, ...common };
}

/** The request a command makes: a path below the hub URL and a body (none: GET). */
export function progressRequest(c: ProgressCommand): { path: string; body?: unknown } {
  if (c.cmd === "report") return { path: "", body: c.report };
  if (c.cmd === "grant")
    return { path: "/grant", body: { node: c.node, agent: c.agent, ttl: c.ttl } };
  if (c.cmd === "resolve")
    return { path: "/resolve", body: c.note ? { id: c.id, note: c.note } : { id: c.id } };
  return { path: "" };
}
