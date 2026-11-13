// The box's `beforesend` event: the host's last word on an outgoing line.
//
//   box.addEventListener("beforesend", (e) => {
//     Object.assign(e.detail.extra, { page: location.pathname }); // compose: never replace extra
//     if (tooLong(e.detail.text)) e.preventDefault();              // keep the draft unsent
//   });
//
// Fired (cancelable, not bubbling) just before `onSend`. Fields put in
// `detail.extra` go out as the line's `ctx` (a plain JSON object, checked by
// cleanCtx in protocol.ts: at most MAX_CTX characters; an empty or invalid one
// is left out, so a box without listeners sends exactly what it sent before).
import type { AttachmentRef, ChatContext, MessageSource } from "./protocol.ts";

export type BeforeSendDetail = {
  readonly text: string;
  /** The state-tree node the line is addressed to; absent = the main thread. */
  readonly to?: string;
  readonly source?: MessageSource;
  readonly context?: ChatContext;
  readonly attachments: readonly AttachmentRef[];
  /** The host's fields for this line, sent as `ctx`. Add to it; several listeners compose. */
  extra: Record<string, unknown>;
};

export function beforeSendEvent(d: Omit<BeforeSendDetail, "extra">): CustomEvent<BeforeSendDetail> {
  return new CustomEvent<BeforeSendDetail>("beforesend", {
    cancelable: true,
    detail: { ...d, extra: {} },
  });
}
