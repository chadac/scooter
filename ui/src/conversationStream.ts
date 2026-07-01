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

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Open the conversation-list stream. `scope` mirrors GET /conversations
 * ("mine" | "all"). Resilient: reconnects on drop (the 10s poll remains the
 * backstop). Returns a handle to close.
 */
export function subscribeConversations(
  config: AgentHostConfig,
  scope: "mine" | "all",
  callbacks: ConversationStreamCallbacks,
  deps?: { fetchImpl?: typeof fetch },
): ConversationSubscription {
  const base = config.baseUrl.replace(/\/$/, "");
  const url = `${base}/conversations/events?scope=${encodeURIComponent(scope)}`;
  const doFetch = deps?.fetchImpl ?? fetch;

  let closed = false;
  let controller: AbortController | undefined;

  const apply = (frame: ConversationStreamFrame): void => {
    if (frame.kind === "snapshot") callbacks.onSnapshot(frame.conversations);
    else if (frame.kind === "upsert") callbacks.onUpsert(frame.conversation);
  };

  const run = async () => {
    while (!closed) {
      controller = new AbortController();
      try {
        const res = await doFetch(url, {
          headers: {
            Accept: "text/event-stream",
            ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
          },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          await delay(1000);
          continue;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = raw.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            let frame: ConversationStreamFrame;
            try {
              frame = JSON.parse(line.slice(5).trim()) as ConversationStreamFrame;
            } catch (e) {
              console.warn("[conversationStream] dropping unparseable frame:", line.slice(0, 200), e);
              continue;
            }
            apply(frame);
          }
        }
      } catch {
        /* network drop / abort — reconnect (the poll is the backstop meanwhile) */
      }
      if (!closed) await delay(500);
    }
  };

  void run();

  return {
    close() {
      closed = true;
      controller?.abort();
    },
  };
}
