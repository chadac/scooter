/**
 * Conversation-list stream client: subscribes to GET /conversations/events, which is the
 * sidebar's ONLY source of the conversation list — there is no longer a periodic full-list
 * fetch behind it. The server emits an initial `snapshot` (the visible list, same scope and
 * shape as GET /conversations), then `upsert` frames as conversations are created or change
 * and `remove` frames as they end.
 *
 * Because nothing else reconciles the list, every failure path has to end in a reconnect, and
 * a reconnect re-snapshots: a dropped connection, a stale socket the watchdog kills, and the
 * server's own "you fell behind" resync all converge on a fresh full list. Why: PR #780.
 */

import type { AgentHostConfig, ConversationScope, ConversationView } from "./client.js";
import { openSSE, type SSESubscription } from "./sseClient.js";

/** Frames the /conversations/events SSE emits. */
export type ConversationStreamFrame =
  | { kind: "snapshot"; conversations: ConversationView[] }
  | { kind: "upsert"; conversation: ConversationView }
  | { kind: "remove"; id: string }
  | { kind: "folders" };

export interface ConversationStreamCallbacks {
  /** The initial full visible list (replaces the sidebar's known set). */
  onSnapshot(conversations: ConversationView[]): void;
  /** A created/updated conversation to merge into the sidebar. */
  onUpsert(conversation: ConversationView): void;
  /** A conversation that is gone, by server id; the row carries no data because it no longer exists. */
  onRemove(id: string): void;
  /** The viewer's folders changed (another tab or device); refetch them. */
  onFolders?(): void;
}

export type ConversationSubscription = SSESubscription;

/** Open the conversation-list stream for `scope` ("mine" | "all"); it reconnects on drop and returns a handle to close. */
export function subscribeConversations(
  config: AgentHostConfig,
  scope: ConversationScope,
  callbacks: ConversationStreamCallbacks,
  deps?: { fetchImpl?: typeof fetch; staleAfterMs?: number },
): ConversationSubscription {
  const base = config.baseUrl.replace(/\/$/, "");
  const url = `${base}/conversations/events?scope=${encodeURIComponent(scope)}`;
  return openSSE<ConversationStreamFrame>(
    url,
    {
      onFrame(frame) {
        if (frame.kind === "snapshot") callbacks.onSnapshot(frame.conversations);
        else if (frame.kind === "upsert") callbacks.onUpsert(frame.conversation);
        else if (frame.kind === "remove" && frame.id) callbacks.onRemove(frame.id);
        else if (frame.kind === "folders") callbacks.onFolders?.();
      },
    },
    { token: config.token, fetchImpl: deps?.fetchImpl, staleAfterMs: deps?.staleAfterMs, label: "conversationStream" },
  );
}
