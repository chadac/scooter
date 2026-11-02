/**
 * Tunnel target resolution, the security boundary for MCP-over-the-wire (BYOC only).
 * A container asks for a named target and this maps it to a real URL; names rather
 * than host:port mean a user's machine can only reach servers the platform offers it.
 * The conversation id is supplied server-side from the stream's session, never from
 * the frame payload, so a container cannot name another conversation's resources.
 * `sandbox-<name>` is reserved but not resolvable over the tunnel yet.
 */

import { SANDBOX_PREFIX } from "../agent/mcpServerRegistry.js";

/** The one target every conversation gets: the agent-host's in-process MCP endpoint. */
export const SCOOTER_ENV = "scooter-env";
/** The broker's MCP endpoint, proxied: the contrib provider tools (github, gitlab, jira,
 *  slack), offered separately from scooter-env since it is a different upstream whose
 *  rotating SA token the proxy attaches. */
export const SCOOTER_BROKER = "scooter-broker";

/** What a resolved target points at. */
export interface ResolvedTarget {
  /** The absolute URL the agent-host will call on the container's behalf. */
  url: string;
  /** For logs: which rule matched. */
  rule: "scooter-env" | "scooter-broker" | "sandbox";
  /** Headers the agent-host injects on the proxied request (the conversation token), supplied
   *  server-side since a credential handed to the container is one the user holds, and
   *  overwriting rather than merging with the container's own headers. */
  headers: Array<{ name: string; value: string }>;
}

export interface TunnelTargetDeps {
  /** The in-process MCP endpoint's URL for a conversation; absent means scooter-env is not offered. */
  mcpUrlFor?: (conversationId: string) => string;
  /** The conversation-token headers for that endpoint; absent or empty when no signing secret is configured. */
  mcpHeadersFor?: (conversationId: string) => Array<{ name: string; value: string }>;
  /** The broker MCP proxy's URL (brokerMcpProxy.url); absent when the broker is not
   *  configured, so scooter-broker is not offered. */
  brokerMcpUrlFor?: () => string;
}

export type TunnelResolution =
  | { ok: true; target: ResolvedTarget }
  | { ok: false; reason: string };

/** Resolve `target` for a stream belonging to `conversationId`. */
export function resolveTunnelTarget(
  target: string,
  conversationId: string,
  deps: TunnelTargetDeps,
): TunnelResolution {
  if (target === SCOOTER_ENV) {
    if (!deps.mcpUrlFor) return { ok: false, reason: "scooter-env is not configured on this deployment" };
    // The scope comes from the stream's session and travels in a token minted here, never
    // from anything the container chose.
    return {
      ok: true,
      target: {
        url: deps.mcpUrlFor(conversationId),
        rule: "scooter-env",
        headers: deps.mcpHeadersFor?.(conversationId) ?? [],
      },
    };
  }
  if (target === SCOOTER_BROKER) {
    if (!deps.brokerMcpUrlFor)
      return { ok: false, reason: "scooter-broker is not configured on this deployment" };
    // The same conversation token as scooter-env, which the proxy verifies before attaching
    // the broker SA token itself, so the container never sees either.
    return {
      ok: true,
      target: {
        url: deps.brokerMcpUrlFor(),
        rule: "scooter-broker",
        headers: deps.mcpHeadersFor?.(conversationId) ?? [],
      },
    };
  }
  if (target.startsWith(SANDBOX_PREFIX)) {
    return {
      ok: false,
      reason: "sandbox-declared MCP servers are not supported yet (the target name is reserved)",
    };
  }
  // Everything else, including anything host:port shaped, is refused.
  return { ok: false, reason: `unknown target ${JSON.stringify(target)}` };
}

/** The servers to offer a session as `new_session` mcpServers entries; the container starts one local proxy per entry and replaces the placeholder `url`, since only the name matters over the wire. */
export function offeredTunnelServers(
  conversationId: string,
  deps: TunnelTargetDeps,
): Array<{ type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> }> {
  if (!deps.mcpUrlFor) return []; // nothing to offer, so the container starts no proxy
  void conversationId;
  return [
    { type: "http", name: SCOOTER_ENV, url: `tunnel://${SCOOTER_ENV}`, headers: [] },
    // The contrib provider tools, without which a BYO agent has the github skill but no
    // github tool to call.
    ...(deps.brokerMcpUrlFor
      ? [{ type: "http" as const, name: SCOOTER_BROKER, url: `tunnel://${SCOOTER_BROKER}`, headers: [] }]
      : []),
  ];
}
