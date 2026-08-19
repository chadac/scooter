/**
 * Registry of connected BYO ("bring your own Claude") remote agents, keyed by OWNER, plus the
 * `remote-personalized` AcpProvider that routes a run to the owner's agent — but ONLY for
 * human-initiated triggers (the compliance guardrail). See todo/docs/BYO_CLAUDE_REMOTE_AGENT.md.
 */

import type { AcpClient } from "./client.js";
import type { ExecBackend } from "../types.js";
import type { AcpProvider, RunContext } from "./provider.js";
import { createRemoteAcpClient } from "./remoteAcpClient.js";
import type { RemoteTransport } from "./remoteProtocol.js";

/**
 * HUMAN-TRIGGER allowlist — the compliance guardrail. A BYO remote agent may ONLY be driven by a
 * human-initiated trigger; a scheduled/automated trigger falls back to the cloud brain. Sources:
 * "ui" (interactive), "slack"|"github"|"gitlab" (@mention). A run with NO source is a plain
 * interactive UI prompt (the primary human case) → treated as human. Anything else — "scheduler",
 * "webhook", "nudge", or any future automated source — is NOT human (allowlist, not denylist): it
 * must be added here explicitly to ever reach a remote agent.
 */
export const HUMAN_TRIGGER_SOURCES: ReadonlySet<string> = new Set(["ui", "slack", "github", "gitlab"]);

/** Is this run human-initiated (eligible for a BYO remote agent)? Undefined source = interactive UI. */
export function isHumanTrigger(source: string | undefined): boolean {
  return source === undefined || HUMAN_TRIGGER_SOURCES.has(source);
}

/** One connected remote agent — its live transport, bound to the owner it registered as. */
export interface AgentConnection {
  readonly owner: string;
  readonly transport: RemoteTransport;
}

export interface RemoteAgentRegistry {
  /** Register (or REPLACE) the connection for an owner. Latest-wins: a re-register (reconnect, or
   *  a second machine) supersedes the prior connection, which is closed. */
  register(conn: AgentConnection): void;
  /** Remove an owner's connection (on WS close / unregister). No-op if not the current one. */
  unregister(owner: string, transport: RemoteTransport): void;
  /** The live connection for an owner, if one is currently registered AND open. */
  get(owner: string): AgentConnection | undefined;
  /** Whether an owner has a live, open agent right now (drives the provider's eligible()). */
  has(owner: string): boolean;
}

/** Optional durable-binding hooks — persist online/offline to the shared DB so the badge is
 *  cross-replica + restart-durable (see remoteAgentStore.ts). Best-effort; fire-and-forget. */
export interface RemoteAgentRegistryHooks {
  onOnline?: (owner: string) => void;
  onOffline?: (owner: string) => void;
}

export function createRemoteAgentRegistry(hooks: RemoteAgentRegistryHooks = {}): RemoteAgentRegistry {
  const byOwner = new Map<string, AgentConnection>();
  return {
    register(conn) {
      const prev = byOwner.get(conn.owner);
      byOwner.set(conn.owner, conn);
      // Latest-wins: drop the superseded connection so we never route to a stale agent.
      if (prev && prev.transport !== conn.transport) prev.transport.close();
      hooks.onOnline?.(conn.owner); // persist ONLINE (durable badge)
    },
    unregister(owner, transport) {
      const cur = byOwner.get(owner);
      // Only clear if THIS transport is still the registered one (a late close of a superseded
      // connection must not evict the new one — nor flip the reconnected owner offline).
      if (cur && cur.transport === transport) {
        byOwner.delete(owner);
        hooks.onOffline?.(owner); // persist OFFLINE
      }
    },
    get(owner) {
      const conn = byOwner.get(owner);
      if (!conn) return undefined;
      if (!conn.transport.isOpen()) {
        byOwner.delete(owner);
        return undefined;
      }
      return conn;
    },
    has(owner) {
      return this.get(owner) !== undefined;
    },
  };
}

/**
 * The `remote-personalized` provider: eligible when the run's OWNER has a live registered agent AND
 * the trigger is human (the guardrail). Higher priority than the cloud floor, so a human run
 * prefers the owner's own Claude; a scheduled run (or an offline agent) falls to the floor.
 * createClient binds a RemoteAcpClient to the owner's connection (tools exec into the CLOUD sandbox
 * via the passed ExecBackend).
 */
export function createRemotePersonalizedProvider(deps: {
  registry: RemoteAgentRegistry;
  /** The CLOUD sandbox ExecBackend for this conversation — the agent's tools tunnel here. */
  exec: ExecBackend;
  /** Priority above the cloud floor. Default 10. */
  priority?: number;
}): AcpProvider {
  return {
    id: "remote-personalized",
    kind: "claude",
    priority: deps.priority ?? 10,
    eligible(ctx: RunContext): boolean {
      return ctx.owner !== undefined && isHumanTrigger(ctx.source) && deps.registry.has(ctx.owner);
    },
    createClient(ctx: RunContext): AcpClient {
      const conn = ctx.owner !== undefined ? deps.registry.get(ctx.owner) : undefined;
      if (!conn) {
        // eligible() gates this, but guard so a race (agent dropped between resolve + create)
        // fails LOUD — the bridge surfaces a RUN_ERROR rather than a silent hang.
        throw new Error(`no live remote agent for owner ${ctx.owner ?? "-"}`);
      }
      return createRemoteAcpClient({ transport: conn.transport, exec: deps.exec });
    },
  };
}
