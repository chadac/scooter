/**
 * Conversation-list stream client: subscribes to GET /conversations/events, which is the
 * sidebar's ONLY source of the conversation list — there is no longer a periodic full-list
 * fetch behind it. The server emits an initial `snapshot` (the visible list, same scope and
 * shape as GET /conversations), then `upsert` frames as conversations are created or change
 * and `remove` frames as they end.
 *
 * Because nothing else reconciles the list, every failure path has to end in a reconnect, and
 * a reconnect re-snapshots: a dropped connection, a stale socket the watchdog below kills, and
 * the server's own "you fell behind" resync all converge on a fresh full list. Why: PR #780.
 */

import type { AgentHostConfig, ConversationScope, ConversationView } from "./client.js";

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

export interface ConversationSubscription {
  close(): void;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * How long the stream may be silent before it is treated as dead and reconnected. The server
 * sends a heartbeat comment every 25s, so silence past this is the connection, not the server
 * having nothing to say — a TCP connection black-holed by a dropped NAT mapping or a proxy
 * restart stays readable forever and never errors. Why: PR #780.
 */
const STALE_AFTER_MS = 60_000;

/** Open the conversation-list stream for `scope` ("mine" | "all"); it reconnects on drop and returns a handle to close. */
export function subscribeConversations(
  config: AgentHostConfig,
  scope: ConversationScope,
  callbacks: ConversationStreamCallbacks,
  deps?: { fetchImpl?: typeof fetch; staleAfterMs?: number },
): ConversationSubscription {
  const base = config.baseUrl.replace(/\/$/, "");
  const url = `${base}/conversations/events?scope=${encodeURIComponent(scope)}`;
  const doFetch = deps?.fetchImpl ?? fetch;
  const staleAfterMs = deps?.staleAfterMs ?? STALE_AFTER_MS;

  let closed = false;
  let controller: AbortController | undefined;

  const apply = (frame: ConversationStreamFrame): void => {
    if (frame.kind === "snapshot") callbacks.onSnapshot(frame.conversations);
    else if (frame.kind === "upsert") callbacks.onUpsert(frame.conversation);
    else if (frame.kind === "remove" && frame.id) callbacks.onRemove(frame.id);
    else if (frame.kind === "folders") callbacks.onFolders?.();
  };

  // The watchdog aborts the fetch, which surfaces as a read error and reconnects through the
  // loop below — and a reconnect re-snapshots, so a hung socket also repairs whatever it missed.
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const armWatchdog = (c: AbortController) => {
    if (watchdog !== undefined) clearTimeout(watchdog);
    watchdog = setTimeout(() => c.abort(), staleAfterMs);
  };
  const disarmWatchdog = () => {
    if (watchdog !== undefined) clearTimeout(watchdog);
    watchdog = undefined;
  };

  const run = async () => {
    while (!closed) {
      const c = new AbortController();
      controller = c;
      // Armed before the fetch: a connect that never responds is as dead as one that stops.
      armWatchdog(c);
      try {
        const res = await doFetch(url, {
          headers: {
            Accept: "text/event-stream",
            ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
          },
          // Firefox makes identical stored GETs wait on a never-ending stream.
          cache: "no-store",
          signal: c.signal,
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
          // Any byte counts, heartbeat comments included: the point is liveness, not content.
          armWatchdog(c);
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
        /* network drop, stale-socket abort or close(): reconnect unless closed */
      }
      disarmWatchdog();
      if (!closed) await delay(500);
    }
  };

  void run();

  return {
    close() {
      closed = true;
      disarmWatchdog();
      controller?.abort();
    },
  };
}
