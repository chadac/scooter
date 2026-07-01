/**
 * Conversation-list stream client — subscribes to the agent-host's
 * GET /conversations/events so NEW conversations (e.g. a Slack thread) appear in
 * the sidebar INSTANTLY instead of on the next 10s poll.
 *
 * The server emits an initial `snapshot` (the current visible list, same scope /
 * view-filter as GET /conversations) then `upsert` frames as conversations are
 * created or change (e.g. an agent-assigned title). The UI folds each upsert into
 * the sidebar via the SAME sessionStore.mergeFromServer the poll uses; the poll
 * stays as a reconcile/backstop.
 *
 * Reuses the fetch + ReadableStream SSE parser pattern from integrityStream.ts.
 *
 * Design stage: SIGNATURES ONLY. No bodies.
 */

import type { AgentHostConfig, ConversationView } from "./client.js";

/** Frames the /conversations/events SSE emits. */
export type ConversationStreamFrame =
  | { kind: "snapshot"; conversations: ConversationView[] }
  | { kind: "upsert"; conversation: ConversationView };

export interface ConversationStreamCallbacks {
  /** The initial full visible list (replaces the sidebar's known set). */
  onSnapshot(conversations: ConversationView[]): void;
  /** A created/updated conversation to merge into the sidebar. */
  onUpsert(conversation: ConversationView): void;
}

export interface ConversationSubscription {
  close(): void;
}

/**
 * Open the conversation-list stream. `scope` mirrors GET /conversations
 * ("mine" | "all"). Resilient: reconnects on drop (the 10s poll remains the
 * backstop). Returns a handle to close.
 */
export declare function subscribeConversations(
  config: AgentHostConfig,
  scope: "mine" | "all",
  callbacks: ConversationStreamCallbacks,
): ConversationSubscription;
