"use client";
// A chat UI drawn from scratch in React on liagent/react: no <liagent-chat>.
// The hooks hold the hub socket, the state and the draft rules; this file is
// only markup. Style it any way you like.

import { useChatState, useDraft, useHubChat } from "liagent/react";

export function HeadlessChat({ url }: { url: string }) {
  const chat = useHubChat({ url });
  const s = useChatState(chat);
  const { state: draft, ref } = useDraft(chat);
  const shown = new Set(s.messages.map((m) => m.id));
  return (
    <section aria-label="Chat with the agent">
      <p aria-live="polite">
        {s.status === "live" ? `connected · ${s.listeners} agent(s) listening` : s.status}
      </p>
      {s.pending && (
        <div role="alertdialog">
          {s.pending.label} asks to connect: code {s.pending.code}{" "}
          {/* allow() works only from a tap like this one. */}
          <button onClick={() => chat.allow(s.pending!.pair, { pages: "all" })}>Allow</button>
          <button onClick={() => chat.deny(s.pending!.pair)}>Deny</button>
        </div>
      )}
      <ul aria-live="polite">
        {/* Text only: React escapes it. Never dangerouslySetInnerHTML a message. */}
        {s.messages.map((m) => (
          <li key={m.id} data-from={m.from}>
            {m.text}
          </li>
        ))}
        {s.outbox
          .filter((o) => !shown.has(o.id))
          .map((o) => (
            <li key={o.id} data-status={o.status}>
              {o.text}
              {o.status === "failed" && <button onClick={() => chat.retry(o.id)}>Retry</button>}
            </li>
          ))}
      </ul>
      {s.busy && <p>The agent is working…</p>}
      <textarea ref={ref} rows={2} placeholder="Message the agent…" aria-invalid={draft.failed} />
    </section>
  );
}
