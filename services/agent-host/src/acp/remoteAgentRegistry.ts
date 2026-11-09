/**
 * Registry of connected bring-your-own-Claude remote agents keyed by owner, plus the
 * `remote-personalized` AcpProvider that routes a run to the owner's agent only for
 * human-initiated triggers (the compliance guardrail).
 */

import { formatError, logger } from "../log.js";
import type { AcpClient } from "./client.js";
import type { AguiEvent } from "../bridge.js";
import type { ExecBackend } from "../types.js";
import type { AcpProvider, RunContext } from "./provider.js";
import { createRemoteAcpClient } from "./remoteAcpClient.js";
import { createByocTransport } from "./byocTransport.js";
import { offeredTunnelServers } from "./tunnelTargets.js";
import { startTunnelClient } from "./tunnelClient.js";
import { modelAllowedFor, type ModelCatalog } from "../agent/models.js";
import type { RemoteTransport } from "./remoteProtocol.js";

const log = logger("remote-personalized");
const tunnelLog = logger("tunnel");

/** The human-trigger allowlist: a BYO remote agent may only be driven by one of these sources (or an undefined source, a plain UI prompt), and any other source must be added here explicitly. */
export const HUMAN_TRIGGER_SOURCES: ReadonlySet<string> = new Set(["ui", "slack", "github", "gitlab"]);

/** Whether this run is human-initiated and so eligible for a BYO remote agent. */
export function isHumanTrigger(source: string | undefined): boolean {
  return source === undefined || HUMAN_TRIGGER_SOURCES.has(source);
}

/** Platform-injected follow-up sources; they inherit their cause's trigger. */
export const DERIVED_SOURCES: ReadonlySet<string> = new Set(["resume", "subagent", "background job", "parent-clarification"]);

/** Whether the log's latest direct trigger was human; none fails closed. */
export function humanTriggerFromLog(events: readonly AguiEvent[]): boolean {
  return latestTrigger(events) ?? false;
}

/** The latest direct trigger's humanness; undefined when none. */
export function latestTrigger(events: readonly AguiEvent[]): boolean | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "TEXT_MESSAGE_START" && e.role === "user") return true;
    // Hook notes are run output, not prompts.
    if (e.type === "SYSTEM_MESSAGE" && e.source !== "hook" && !DERIVED_SOURCES.has(e.source)) {
      return isHumanTrigger(e.source);
    }
  }
  return undefined;
}

/** One connected remote agent: its live transport, bound to the owner it registered as. */
export interface AgentConnection {
  readonly owner: string;
  readonly transport: RemoteTransport;
}

export interface RemoteAgentRegistry {
  /** Register the connection for an owner, latest-wins; a superseded connection is closed. */
  register(conn: AgentConnection): void;
  /** Remove an owner's connection; a no-op if it is not the current one. */
  unregister(owner: string, transport: RemoteTransport): void;
  /** The live connection for an owner, if one is registered and open. */
  get(owner: string): AgentConnection | undefined;
  /** Whether an owner has a live, open agent right now. */
  has(owner: string): boolean;
}

/** Best-effort hooks that persist online/offline to the shared DB (remoteAgentStore.ts). */
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
      // Latest-wins: close the superseded connection.
      if (prev && prev.transport !== conn.transport) prev.transport.close();
      hooks.onOnline?.(conn.owner);
    },
    unregister(owner, transport) {
      const cur = byOwner.get(owner);
      // A late close of a superseded connection must not evict the new one.
      if (cur && cur.transport === transport) {
        byOwner.delete(owner);
        hooks.onOffline?.(owner);
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
 * The `remote-personalized` provider: eligible when the run's owner has a connected agent
 * and the trigger is human, at a higher priority than the cloud floor. createClient binds
 * a RemoteAcpClient to the owner's connection, with tools exec'ing into the cloud sandbox
 * via the passed ExecBackend.
 */
export function createRemotePersonalizedProvider(deps: {
  /** The BYOC controller's in-cluster base URL, which holds every container socket so any replica can drive any container. */
  controllerUrl: string;
  /** The conversation-token headers for the MCP endpoint, injected by the agent-host when it proxies so the container never holds one. */
  mcpHeadersFor?: (conversationId: string) => Array<{ name: string; value: string }>;
  /** The broker MCP proxy's URL, so a BYO agent is offered the contrib provider
   *  tools (github, gitlab, jira, slack) and not only scooter-env. */
  brokerMcpUrlFor?: () => string;
  /** The model catalog, so eligibility can honor a cloud-only model pick; absent means no
   *  model gate. */
  catalog?: ModelCatalog;
  /** The in-process MCP endpoint's URL for a conversation (mcpEndpoint.urlFor), which drives
   *  the tunnel offer; absent means no scooter-env is offered and the container starts no proxy. */
  mcpUrlFor?: (conversationId: string) => string;
  /** The cloud sandbox ExecBackend the agent's tools tunnel into. */
  exec: ExecBackend;
  /** Priority above the cloud floor, defaulting to 10. */
  priority?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  streamIdleMs?: number;
}): AcpProvider {
  const doFetch = deps.fetchImpl ?? fetch;
  const base = deps.controllerUrl.replace(/\/$/, "");
  // owner -> sessionId, learned during eligible() and consumed by createClient() in the same run.
  const resolved = new Map<string, string>();
  return {
    id: "remote-personalized",
    // Catalog models offered on the user's own container tag themselves "byoc".
    modelTag: "byoc",
    // MCP over the tunnel offers names the container proxies locally, since a laptop cannot
    // reach the agent-host's loopback URL.
    mcpServersFor: (conversationId: string) =>
      offeredTunnelServers(conversationId, {
        mcpUrlFor: deps.mcpUrlFor,
        mcpHeadersFor: deps.mcpHeadersFor,
        brokerMcpUrlFor: deps.brokerMcpUrlFor,
      }),
    kind: "claude",
    // The container shares nothing with this pod: no skills directory, no prompt of its own,
    // so both travel with new_session.
    needsSkillPayloads: true,
    needsSystemPrompt: true,
    priority: deps.priority ?? 10,
    async eligible(ctx: RunContext): Promise<boolean> {
      const hasOwner = ctx.owner !== undefined;
      const human = ctx.humanInitiated ?? isHumanTrigger(ctx.source);
      if (!hasOwner || !human) {
        log.info("SKIP — falling to the cloud floor", {
          conversation_id: ctx.conversationId,
          owner: ctx.owner,
          source: ctx.source,
          inherited: ctx.humanInitiated !== undefined,
          has_owner: hasOwner,
          human_trigger: human,
        });
        return false;
      }
      // The model gate: the catalog tags each model with the providers that serve it, so a
      // model this "byoc" provider cannot serve declines here and the run falls to the next
      // candidate.
      if (ctx.model && deps.catalog && !modelAllowedFor(deps.catalog, ctx.model, "byoc")) {
        log.info("SKIP — model not offered on byoc, falling to the cloud floor", {
          conversation_id: ctx.conversationId,
          owner: ctx.owner,
          model: ctx.model,
        });
        return false;
      }
      const owner = ctx.owner as string;
      try {
        const res = await doFetch(`${base}/byoc/status?owner=${encodeURIComponent(owner)}`, {
          headers: { Accept: "application/json" },
          // A pooled connection can be dead without erroring.
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) {
          log.info("SKIP — controller status not ok", {
            conversation_id: ctx.conversationId,
            owner,
            status: res.status,
          });
          return false;
        }
        const body = (await res.json()) as { sessionId?: string; status?: string };
        // Only "connected" can serve a run; "minted" means the container has not dialled in yet.
        if (body.status !== "connected" || !body.sessionId) {
          log.info("SKIP — container not connected, falling to the cloud floor", {
            conversation_id: ctx.conversationId,
            owner,
            byoc_status: body.status,
          });
          return false;
        }
        resolved.set(owner, body.sessionId);
        log.info("SELECTED", {
          conversation_id: ctx.conversationId,
          owner,
          session_id: body.sessionId,
        });
        return true;
      } catch (err) {
        // A controller outage costs the user their personal model for this run, not the run.
        log.info("SKIP — controller unreachable", {
          conversation_id: ctx.conversationId,
          owner,
          error: formatError(err),
        });
        return false;
      }
    },

    createClient(ctx: RunContext): AcpClient {
      const sessionId = ctx.owner !== undefined ? resolved.get(ctx.owner) : undefined;
      if (!sessionId) {
        // A container dropped between resolve and create fails loud as a RUN_ERROR.
        throw new Error(`no live remote agent for owner ${ctx.owner ?? "-"}`);
      }
      // The pod holds no socket: every frame is an HTTP call to the controller, which owns
      // the one duplex WS to the container.
      const transport = createByocTransport({ baseUrl: base, sessionId, fetchImpl: deps.fetchImpl, idleMs: deps.streamIdleMs });
      // ACP sessions this client opened; the shared stream also carries other conversations'.
      const acpSessions = new Set<string>();
      // A stream the container opens needs an inbound channel, so hold the controller's
      // dedicated inbound stream open for as long as this client lives, but only when
      // scooter-env is actually offered.
      if (!deps.mcpUrlFor) {
        tunnelLog.info("NOT started: no MCP endpoint configured — the BYO agent gets sandbox tools only", {
          conversation_id: ctx.conversationId,
          session_id: sessionId,
        });
      }
      const tunnelClient = deps.mcpUrlFor
        ? startTunnelClient({
            // The controller root, since startTunnelClient builds its own /byoc/:id/tunnel path.
            baseUrl: deps.controllerUrl,
            sessionId,
            // Server-side scope for every target this container can resolve, never read from a container-supplied frame.
            conversationId: ctx.conversationId ?? "",
            mcpUrlFor: deps.mcpUrlFor,
            // The conversation token is injected here as the target resolves, since the
            // offer ships headers:[] so the container never holds a credential.
            mcpHeadersFor: deps.mcpHeadersFor,
            // The inbound stream must resolve scooter-broker too, so the offer and the
            // resolver are fed from the same place.
            brokerMcpUrlFor: deps.brokerMcpUrlFor,
            fetchImpl: deps.fetchImpl,
            idleMs: deps.streamIdleMs,
            ownsSession: (sid) => acpSessions.has(sid),
          })
        : undefined;
      const client = createRemoteAcpClient({ transport, exec: deps.exec });
      const origNewSession = client.newSession.bind(client);
      client.newSession = async (params) => {
        const res = await origNewSession(params);
        acpSessions.add(res.sessionId);
        return res;
      };
      // Tear the inbound stream down with the client, or a dead session keeps its reader alive forever.
      const origClose = client.close?.bind(client);
      client.close = async () => {
        tunnelClient?.close();
        await origClose?.();
      };
      return client;
    },
  };
}
