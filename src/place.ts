// Where the agent CLI (src/cli.ts) sits in the state tree: --task-path /
// $LIAGENT_TASK_PATH (its node) and --agent / $LIAGENT_AGENT (the node's
// assignee). A sub-agent sets the env vars once; the flags win over them.
// Messages are addressed to state-tree nodes; a node's assignee receives them.

import { ROOT_NODE, agentIdOf, nodePath, routeTo } from "./protocol.ts";

export type Place = { node?: string; agent?: string };

/** The node and assignee from the flags, else the environment; an error for a bad one. */
export function placeOf(
  flags: { taskPath?: string; agent?: string },
  env: Record<string, string | undefined>,
): Place | { error: string } {
  const rawPath = flags.taskPath ?? env.LIAGENT_TASK_PATH;
  const rawAgent = flags.agent ?? env.LIAGENT_AGENT;
  const node = rawPath?.trim() ? nodePath(rawPath) : undefined;
  if (rawPath?.trim() && !node)
    return { error: `not a node path: ${rawPath} (letters, digits, ._~- segments, ≤ 80 chars)` };
  const agent = rawAgent?.trim() ? agentIdOf(rawAgent) : undefined;
  if (rawAgent?.trim() && !agent)
    return { error: `not an agent id: ${rawAgent} (≤ 40 chars of letters, digits, ._@:+- )` };
  const out: Place = {};
  if (node && node !== ROOT_NODE) out.node = node;
  if (agent) out.agent = agent;
  return out;
}

/**
 * Whether `listen` prints a chat line: the user's and friends' lines (all
 * the hub routed here), and agent lines addressed to a node — never its own,
 * nor the agents' replies to the main thread (as before node paths).
 * `observed`: the hub's mark, or (for history) worked out from the routes.
 */
export function listenLine(
  m: { from: string; to?: string; taskPath?: string; agentId?: string } & Record<string, unknown>,
  self: Place,
  observed?: boolean,
): Record<string, unknown> | null {
  if (m.from === "agent") {
    if (typeof m.to !== "string") return null;
    if ((m.taskPath ?? ROOT_NODE) === (self.node ?? ROOT_NODE) && m.agentId === self.agent)
      return null;
  }
  const seen = observed ?? routeTo(self.node, m.to) === "observed";
  return { type: "chat", ...m, ...(seen ? { observed: true } : {}) };
}
