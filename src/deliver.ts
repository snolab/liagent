// What `liagent listen --to` types into an agent-yes agent for one chat
// message. Pure, so it is unit tested (test/deliver.test.ts).

import type { AttachmentRef, ChatContext, ChatMessage } from "./protocol.ts";

/**
 * `ay send` refuses more than 1024 chars per send, and a long paste into a
 * live CLI gets mangled anyway: past this, the agent gets a preview and the
 * path of a file with the whole message.
 */
export const SEND_MAX = 900;
/** The text one chat message is delivered as: a header with the reply command, then the body. */
export function deliveryText(
  hub: string,
  m: ChatMessage & { email?: string },
  spill: (id: string, text: string) => string,
): string {
  const who = m.from === "friend" ? `friend ${m.email || m.thread}` : "the user";
  const replyTo = m.from === "friend" ? ` --to ${m.email || m.thread}` : "";
  const page = m.label.split(" ")[0] || "?";
  const header = `[liagent ${m.id}] ${who} wrote in the chat box (${page}) — reply: liagent say ${hub}${replyTo} "..."\n`;
  const body = m.text + contextText(m.context) + attachmentsText(m.attachments) + ctxText(m.ctx);
  if (header.length + body.length <= SEND_MAX) return header + body;
  const path = spill(m.id, body);
  const room = Math.max(0, SEND_MAX - header.length - path.length - 40);
  return `${header}${body.slice(0, room)}… (${body.length} chars; the whole message: ${path})`;
}

/**
 * What the user attached to a line, as a block after its text: the
 * selection quoted ("> " on each line, so it reads as data, not as the
 * user's words) with the page it came from, then the files. "" when nothing.
 */
export function contextText(c: ChatContext | undefined): string {
  if (!c) return "";
  const out: string[] = [];
  if (c.selection) {
    const where = [c.host, c.path].filter(Boolean).join("");
    const from = [c.title ? `"${c.title}"` : "", where].filter(Boolean).join(" ");
    out.push(`[attached: selection${from ? ` from ${from}` : ""}]`);
    out.push(...c.selection.split("\n").map((l) => `> ${l}`));
  }
  for (const f of c.files ?? [])
    out.push(`[attached: file ${f.name}${f.type ? ` (${f.type})` : ""}: ${f.url}]`);
  return out.length ? `\n\n${out.join("\n")}` : "";
}

/**
 * The files sent with a line (stored by the host), as a block after its
 * text: one "[attached: file <name> (<type>, <size> bytes) id <id>]" each.
 * The agent fetches one through the host's own API by its id. "" when none.
 */
export function attachmentsText(list: readonly AttachmentRef[] | undefined): string {
  if (!list?.length) return "";
  const lines = list.map(
    (a) => `[attached: file ${a.name} (${a.type}, ${a.size} bytes) id ${a.id}]`,
  );
  return `\n\n${lines.join("\n")}`;
}

/**
 * The host's `ctx` on a line (the box's `beforesend` event, `detail.extra`),
 * as a block after its text: one line of JSON, labelled as the page's own
 * data so the agent reads it as hints about where the user is, never as the
 * user's words or as proof of anything. "" when none.
 */
export function ctxText(ctx: Record<string, unknown> | undefined): string {
  if (!ctx) return "";
  let json: string;
  try {
    json = JSON.stringify(ctx);
  } catch {
    return "";
  }
  if (!json || json === "{}") return "";
  return `\n\n[page ctx (set by the page's script, not by the user): ${json}]`;
}
