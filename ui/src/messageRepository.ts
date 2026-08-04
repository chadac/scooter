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
  const items = messages.map((message, i) => ({
    message,
    parentId: i > 0 ? (messages[i - 1] as { id: string }).id : null,
  }));
  const headId = messages.length ? (messages.at(-1) as { id: string }).id : null;
  return ExportedMessageRepository.fromBranchableArray(items, { headId });
}
