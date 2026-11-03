/**
 * Tell contribs when a conversation starts waiting on the user. Each pending interrupt (a
 * question the agent asked, or an approval) is POSTed to every contrib that set
 * `services.broker.notifyAwaitingInput`, so it can surface the wait where the user is:
 * Slack posts it to the conversation's thread. The platform does not know what the
 * contrib does with it. Delivery is best-effort: a failure is logged, never retried.
 */

import type { AguiEvent } from "../bridge.js";
import { formatError, logger } from "../log.js";
import type { ConversationLink } from "./manager.js";
import type { SessionId } from "../types.js";

const log = logger("awaitingInputNotify");

/** One contrib's route on the broker, from AWAITING_INPUT_NOTIFY_JSON. */
export interface AwaitingInputNotifyTarget {
  path: string;
}

/** Parse AWAITING_INPUT_NOTIFY_JSON; unset or malformed means no contrib is told. */
export function parseAwaitingInputNotify(raw: string | undefined): Record<string, AwaitingInputNotifyTarget> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, AwaitingInputNotifyTarget> = {};
    for (const [name, cfg] of Object.entries(parsed as Record<string, unknown>)) {
      const path = (cfg as { path?: unknown } | null)?.path;
      if (typeof path === "string" && path.startsWith("/")) out[name] = { path };
    }
    return out;
  } catch (e) {
    log.error("AWAITING_INPUT_NOTIFY_JSON is not valid JSON; no contrib will hear of pending questions", {
      error: formatError(e),
    });
    return {};
  }
}

/** What a contrib receives for one pending interrupt. */
export interface AwaitingInputNotice {
  conversationId: string;
  /** The conversation in the UI, where the user answers; absent without PUBLIC_URL. */
  conversationUrl?: string;
  links: ConversationLink[];
  interrupt: {
    id: string;
    message: string;
    /** The contrib request's kind, e.g. `ask-user.questions`; absent for a plain choice. */
    kind?: string;
    data?: unknown;
    options: Array<{ optionId: string; name: string }>;
  };
}

export interface AwaitingInputNotifierDeps {
  targets: Record<string, AwaitingInputNotifyTarget>;
  /** Broker base URL and the agent-host's auth headers, or null when there is no broker. */
  broker: () => Promise<{ url: string; headers: Record<string, string> } | null>;
  listLinks: (id: SessionId) => Promise<ConversationLink[]>;
  publicUrl?: string;
  fetch?: typeof fetch;
}

// A re-raise after a revive appends the same interrupt again; tell contribs once.
const SEEN_MAX = 4096;

/** Returns the onAppend callback; null when no contrib wants to hear. */
export function createAwaitingInputNotifier(
  deps: AwaitingInputNotifierDeps,
): ((id: SessionId, event: AguiEvent) => Promise<void>) | null {
  const names = Object.keys(deps.targets);
  if (names.length === 0) return null;
  const doFetch = deps.fetch ?? fetch;
  const seen = new Set<string>();

  const firstSighting = (key: string): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string);
    return true;
  };

  return async (id, event) => {
    if (event.type !== "RUN_FINISHED" || event.outcome?.type !== "interrupt") return;
    const fresh = event.outcome.interrupts.filter((i) => firstSighting(`${id}:${i.id}`));
    if (fresh.length === 0) return;
    const broker = await deps.broker().catch((e) => {
      log.warn("no broker auth; pending question not relayed", { conversation_id: id, error: formatError(e) });
      return null;
    });
    if (!broker) return;
    const links = await deps.listLinks(id).catch((e) => {
      log.warn("could not read links for a pending question", { conversation_id: id, error: formatError(e) });
      return [] as ConversationLink[];
    });
    const conversationUrl = deps.publicUrl
      ? `${deps.publicUrl.replace(/\/$/, "")}/?thread=${encodeURIComponent(id)}`
      : undefined;
    for (const i of fresh) {
      const meta = (i.metadata ?? {}) as { kind?: unknown; data?: unknown; options?: unknown };
      const options = Array.isArray(meta.options)
        ? (meta.options as Array<{ optionId?: unknown; name?: unknown }>)
            .filter((o) => typeof o?.optionId === "string")
            .map((o) => ({ optionId: o.optionId as string, name: typeof o.name === "string" ? o.name : (o.optionId as string) }))
        : [];
      const notice: AwaitingInputNotice = {
        conversationId: id,
        ...(conversationUrl ? { conversationUrl } : {}),
        links,
        interrupt: {
          id: i.id,
          message: i.message ?? "",
          ...(typeof meta.kind === "string" ? { kind: meta.kind } : {}),
          ...(meta.data !== undefined ? { data: meta.data } : {}),
          options,
        },
      };
      await Promise.all(
        names.map(async (contrib) => {
          try {
            const res = await doFetch(`${broker.url}${deps.targets[contrib].path}`, {
              method: "POST",
              headers: broker.headers,
              body: JSON.stringify(notice),
            });
            if (!res.ok) {
              log.warn("contrib refused a pending-question notice", {
                conversation_id: id, contrib, status: res.status, body: (await res.text().catch(() => "")).slice(0, 500),
              });
            }
          } catch (e) {
            log.warn("pending-question notice failed", { conversation_id: id, contrib, error: formatError(e) });
          }
        }),
      );
    }
  };
}
