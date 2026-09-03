/**
 * Build an assistant-ui `ExportedMessageRepository` from our folded message list,
 * for the INCREMENTAL external-store render path.
 *
 * The old render write did `runtime.thread.reset(fromAgUiMessages(msgs))`, which
 * rebuilds the whole repository from scratch on EVERY push — re-generating fresh
 * ids for every message and re-painting the entire thread (the "open a conversation
 * and it jumps to the top / flashes" bug). Instead we hand the external store a
 * `messageRepository` snapshot: the core then reconciles per-message
 * (addOrUpdateMessage / deleteMessage / resetHead — see
 * @assistant-ui/core external-store-thread-runtime-core), keeping unchanged
 * message subtrees in place with NO re-paint, and holding the viewport at the head.
 *
 * Two invariants the incremental reconcile requires, both satisfied here:
 *   1. STABLE message ids across pushes. Our ids come from the integrity log
 *      (messageId / toolCallId) and the deterministic `sys:` splice — never a
 *      per-render random id — so a message keeps its identity between folds.
 *   2. Parent-before-child order. We chain the (already chronological) list
 *      linearly: message[i].parentId = message[i-1].id, root = null. The head is
 *      the last message, so resetHead keeps the newest turn pinned.
 */

import { fromAgUiMessages } from "@assistant-ui/react-ag-ui";
import { ExportedMessageRepository } from "@assistant-ui/react";

/** A repository snapshot the external store consumes: a flat, parent-linked list
 *  plus the head (visible leaf). Matches @assistant-ui/core's ExportedMessageRepository. */
export type RepositorySnapshot = ExportedMessageRepository;

/** An image attached to a user message, as carried by a MESSAGE_IMAGES event. */
export interface MessageImageRef {
  assetId: string;
  mimeType: string;
  /** Root-absolute assets route the server emits: /conversations/:id/assets/:assetId. */
  url: string;
}

/**
 * Append each user message's attached images (MESSAGE_IMAGES rides the log, but the
 * AbstractAgent base applier ignores it) so they survive replay/refresh as attachments.
 *
 * The image MUST be emitted in the AG-UI WIRE shape `{type:"image", source:{type:"url",
 * value}}`: fromAgUiMessages → toSnapshotAttachments only materializes a user-message
 * attachment from a part that has a `source`. The assistant-ui content-part shape
 * `{type:"image", image}` has no `source`, so it is SILENTLY DROPPED — the message folds
 * to text-only and renders as an empty bubble (the live send shows the image only because
 * the composer supplies its own File-backed attachment; the drop bites on replay). See the
 * companion test.
 *
 * `baseUrl` is prefixed onto the (root-absolute) asset url so the rendered <img> resolves
 * through the same API base as every other request (client.ts prefixes it): "" at origin
 * root (prod), the webService path prefix under the dev preview, where an unprefixed
 * /conversations/... would resolve outside the proxy and 404.
 */
export function enrichMessagesWithImages(
  foldedMessages: readonly unknown[],
  getImages: (messageId: string) => readonly MessageImageRef[] | undefined,
  baseUrl: string,
): unknown[] {
  return foldedMessages.map((m) => {
    const msg = m as { id?: string; content?: unknown };
    const imgs = msg.id ? getImages(msg.id) : undefined;
    if (!imgs?.length) return m;
    const parts = Array.isArray(msg.content)
      ? [...(msg.content as unknown[])]
      : msg.content
        ? [{ type: "text", text: msg.content }]
        : [];
    for (const img of imgs) {
      parts.push({ type: "image", source: { type: "url", value: baseUrl + img.url, mimeType: img.mimeType } });
    }
    return { ...msg, content: parts };
  });
}

/**
 * Convert our folded AG-UI message array (post image-enrichment + system-splice)
 * into an ExportedMessageRepository with a linear parent chain.
 *
 * Uses `fromBranchableArray`, which PRESERVES each message's id (it throws if an id
 * is missing) — unlike `fromArray`, which re-generates ids and would defeat the
 * incremental reconcile. Our ids are log-derived (messageId / toolCallId) or the
 * deterministic `sys:` splice, so they're stable across pushes → the core keeps
 * unchanged messages in place (no re-paint) and only adds/removes what changed.
 *
 * IMPORTANT: returns a NEW object each call (never memoized by reference) — the
 * external-store core fast-paths on `oldStore.messageRepository === store.messageRepository`
 * and would SKIP the reconcile entirely if handed the same object. Stable inner ids
 * (not object identity) are what make the reconcile a no-op for unchanged messages.
 */
export function toRepositorySnapshot(foldedMessages: readonly unknown[]): RepositorySnapshot {
  // fromAgUiMessages does the faithful conversion (text/tool-calls/reasoning/images)
  // — the same converter the old reset() path used, so message shape is unchanged.
  const messages = fromAgUiMessages(foldedMessages as never[]);
  // DEDUPE BY ID. fromBranchableArray links each item into a parent tree, and linking
  // the SAME id twice throws inside assistant-ui:
  //   "MessageRepository(performOp/link): A message with the same id already exists
  //    in the parent tree."
  // That throw happens during render, so it takes down <ConversationRuntime> and the
  // user gets a BLANK WHITE PAGE — the entire conversation is unreachable until the
  // duplicate ages out of the fold. Observed on CI reloading a revived conversation
  // (test/e2e/suspended-recovery.spec.ts). The server mints UUID ids, so a duplicate
  // is a FOLD-side artifact, but wherever it comes from, dropping the repeat is
  // strictly better than crashing the whole UI: the first occurrence renders and the
  // conversation stays usable.
  const seen = new Set<string>();
  const unique = messages.filter((m) => {
    const id = (m as { id?: string }).id;
    if (!id) return true; // no id to collide on — keep it
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const items = unique.map((message, i) => ({
    message,
    parentId: i > 0 ? (unique[i - 1] as { id: string }).id : null,
  }));
  const headId = unique.length ? (unique.at(-1) as { id: string }).id : null;
  return ExportedMessageRepository.fromBranchableArray(items, { headId });
}
