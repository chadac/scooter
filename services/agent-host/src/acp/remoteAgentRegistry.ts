/**
 * Registry of connected BYO ("bring your own Claude") remote agents, keyed by OWNER, plus the
 * `remote-personalized` AcpProvider that routes a run to the owner's agent — but ONLY for
 * human-initiated triggers (the compliance guardrail). See todo/docs/BYO_CLAUDE_REMOTE_AGENT.md.
 */

import type { AcpClient } from "./client.js";
import type { ExecBackend } from "../types.js";
import type { AcpProvider, RunContext } from "./provider.js";
import { createRemoteAcpClient } from "./remoteAcpClient.js";
import { createByocTransport } from "./byocTransport.js";
import { offeredTunnelServers } from "./tunnelTargets.js";
import { startTunnelClient } from "./tunnelClient.js";
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
  /** The BYOC controller's in-cluster base URL. Ownership is resolved HERE, not from a per-pod map:
   *  the controller holds every container socket, so ANY replica can drive ANY container (§L). The
   *  old per-pod `registry` could only answer for sockets THIS pod happened to hold, so on a
   *  multi-replica fleet a run scheduled elsewhere fell silently to the cloud floor. */
  controllerUrl: string;
  /** The in-process MCP endpoint's URL for a conversation (mcpEndpoint.urlFor). Drives the
   *  tunnel OFFER: absent = no scooter-env is offered and the container starts no proxy,
   *  rather than one that dead-ends on every call. */
  mcpUrlFor?: (conversationId: string) => string;
  /** The CLOUD sandbox ExecBackend for this conversation — the agent's tools tunnel here. */
  exec: ExecBackend;
  /** Priority above the cloud floor. Default 10. */
  priority?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}): AcpProvider {
  const doFetch = deps.fetchImpl ?? fetch;
  const base = deps.controllerUrl.replace(/\/$/, "");
  // owner -> sessionId, learned during eligible() and consumed by createClient() in the SAME run.
  // Not a durable cache: a stale entry would point a run at a container that has since dropped, and
  // the controller is the only authority on who is connected right now.
  const resolved = new Map<string, string>();
  return {
    id: "remote-personalized",
    // Catalog models offered on the user's own container tag themselves "byoc" — these are
    // API-style ids (claude-sonnet-4-5), never Bedrock ids.
    modelTag: "byoc",
    // MCP over the tunnel: offer NAMES the container proxies locally. The bridge's default is
    // the agent-host's own loopback URL, which a laptop cannot reach — that is why a BYO agent
    // had no scooter-env at all.
    mcpServersFor: (conversationId: string) => offeredTunnelServers(conversationId, { mcpUrlFor: deps.mcpUrlFor }),
    kind: "claude",
    priority: deps.priority ?? 10,
    async eligible(ctx: RunContext): Promise<boolean> {
      const hasOwner = ctx.owner !== undefined;
      const human = isHumanTrigger(ctx.source);
      if (!hasOwner || !human) {
        console.log(
          `[remote-personalized] SKIP owner=${ctx.owner ?? "-"} source=${ctx.source ?? "(undefined=ui)"} ` +
            `hasOwner=${hasOwner} humanTrigger=${human} -> falling to the cloud floor`,
        );
        return false;
      }
      const owner = ctx.owner as string;
      try {
        const res = await doFetch(`${base}/byoc/status?owner=${encodeURIComponent(owner)}`, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) {
          console.log(`[remote-personalized] SKIP owner=${owner} controller status ${res.status}`);
          return false;
        }
        const body = (await res.json()) as { sessionId?: string; status?: string };
        // "connected" is the ONLY state that can serve a run: "minted" means the session exists but
        // the container has not dialled in, so routing a prompt there would hang.
        if (body.status !== "connected" || !body.sessionId) {
          console.log(
            `[remote-personalized] SKIP owner=${owner} controller says ${body.status ?? "?"} ` +
              `-> falling to the cloud floor`,
          );
          return false;
        }
        resolved.set(owner, body.sessionId);
        console.log(`[remote-personalized] SELECTED owner=${owner} session=${body.sessionId}`);
        return true;
      } catch (err) {
        // A controller outage must cost the user their personal model for this run, NOT the run.
        console.log(`[remote-personalized] SKIP owner=${owner} controller unreachable (${String(err)})`);
        return false;
      }
    },

    createClient(ctx: RunContext): AcpClient {
      const sessionId = ctx.owner !== undefined ? resolved.get(ctx.owner) : undefined;
      if (!sessionId) {
        // eligible() gates this, but guard so a race (container dropped between resolve + create)
        // fails LOUD — the bridge surfaces a RUN_ERROR rather than a silent hang.
        throw new Error(`no live remote agent for owner ${ctx.owner ?? "-"}`);
      }
      // The pod holds NO socket. Every frame is an HTTP call to the controller, which owns the one
      // duplex WS to the container — so any replica can drive it and a rollout cannot strand a run.
      const transport = createByocTransport({ baseUrl: base, sessionId, fetchImpl: deps.fetchImpl });
      // MCP over the tunnel needs an INBOUND channel: this transport is HTTP/SSE per prompt, so
      // a stream the CONTAINER opens has no way back here. Hold the controller's dedicated
      // inbound stream open for as long as this client lives. Only when scooter-env is actually
      // offered — no offer means no streams to serve.
      const tunnelClient = deps.mcpUrlFor
        ? startTunnelClient({
            // The controller root, NOT the per-session base — startTunnelClient builds its own
            // /byoc/:id/tunnel path (deriving it by stripping the session off `base` would
            // break the moment that shape changes).
            baseUrl: deps.controllerUrl,
            sessionId,
            // SERVER-SIDE scope for every target this container can resolve; never read from
            // a container-supplied frame.
            conversationId: ctx.conversationId ?? "",
            mcpUrlFor: deps.mcpUrlFor,
            fetchImpl: deps.fetchImpl,
          })
        : undefined;
      const client = createRemoteAcpClient({ transport, exec: deps.exec });
      // Tear the inbound stream down with the client, or a dead session keeps a reader (and
      // its reconnect loop) alive forever.
      const origClose = client.close?.bind(client);
      client.close = async () => {
        tunnelClient?.close();
        await origClose?.();
      };
      return client;
    },
  };
}
