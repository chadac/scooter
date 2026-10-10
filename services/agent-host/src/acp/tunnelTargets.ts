/**
 * Tunnel target resolution — the security boundary for MCP-over-the-wire (BYOC only).
 *
 * A container asks for a NAMED target ("scooter-env"); this maps it to a real URL. Names, not
 * host:port, so a user's machine can never reach arbitrary cluster addresses through the
 * tunnel — the container can only reach servers the platform decided to offer it.
 *
 * THE CONVERSATION ID IS SERVER-SIDE. It comes from the stream's session (the `sid` the relay
 * stamps, mapped to the conversation the agent-host is driving), NEVER from the frame payload.
 * Taking it from the payload would let a container name another conversation's resources —
 * exactly the cross-owner hole the attach path guards against.
 *
 * `sandbox:<name>` is RESERVED (the agent will declare MCP servers in its nixosConfiguration
 * and pick them up on the next message) but is not resolvable yet — it fails with a reason
 * naming that, rather than half-working.
 */

/** The one target every conversation gets: the agent-host's in-process MCP endpoint. */
export const SCOOTER_ENV = "scooter-env";
/** The broker's MCP endpoint, proxied: the CONTRIB provider tools (github, gitlab,
 *  jira, slack). Offered separately from scooter-env because it is a different
 *  upstream with its own auth -- the proxy attaches the rotating SA token. */
export const SCOOTER_BROKER = "scooter-broker";
/** Reserved prefix for sandbox-declared servers (not resolvable yet). */
export const SANDBOX_PREFIX = "sandbox:";

/** What a resolved target points at. */
export interface ResolvedTarget {
  /** The absolute URL the agent-host will call on the container's behalf. */
  url: string;
  /** For logs: which rule matched. */
  rule: "scooter-env" | "scooter-broker" | "sandbox";
  /**
   * Headers the AGENT-HOST injects on the proxied request — the conversation token.
   *
   * Server-side for the same reason the conversation id is: the container runs on the
   * user's machine, and a credential handed to it is a credential they hold. The
   * container's own headers are forwarded too, so these must OVERWRITE rather than
   * merge — see the open handler in tunnelService.ts. Why: issue #700.
   */
  headers: Array<{ name: string; value: string }>;
}

export interface TunnelTargetDeps {
  /** The in-process MCP endpoint's URL for a conversation (mcpEndpoint.urlFor). Absent when
   *  the endpoint is not configured — then scooter-env simply is not offered. */
  mcpUrlFor?: (conversationId: string) => string;
  /** The conversation token headers for that endpoint (mcpEndpoint.headersFor). Absent, or
   *  empty, when no signing secret is configured — then the endpoint is unauthenticated and
   *  the tunnel behaves exactly as it did before. */
  mcpHeadersFor?: (conversationId: string) => Array<{ name: string; value: string }>;
  /** The broker MCP proxy's URL (brokerMcpProxy.url). Absent when the broker is not
   *  configured -- then scooter-broker simply is not offered. */
  brokerMcpUrlFor?: () => string;
}

export type TunnelResolution =
  | { ok: true; target: ResolvedTarget }
  | { ok: false; reason: string };

/**
 * Resolve `target` for a stream belonging to `conversationId`.
 *
 */
export function resolveTunnelTarget(
  target: string,
  conversationId: string,
  deps: TunnelTargetDeps,
): TunnelResolution {
  if (target === SCOOTER_ENV) {
    if (!deps.mcpUrlFor) return { ok: false, reason: "scooter-env is not configured on this deployment" };
    // The conversation comes from the caller (the stream's session), so the scope is never
    // something the container chose — and since #700 it is carried by a token the agent-host
    // mints HERE rather than by a query param, which is what makes that true of the endpoint
    // too and not only of this resolver.
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
    // Same conversation token as scooter-env: the proxy verifies it, then attaches
    // the broker SA token itself. The container never sees either.
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
  // Everything else — including anything host:port shaped — is refused. Names only: this is
  // what stops the tunnel from becoming arbitrary cluster network access from a laptop.
  return { ok: false, reason: `unknown target ${JSON.stringify(target)}` };
}

/**
 * The servers to OFFER a session, as `new_session`'s mcpServers entries. The container starts
 * one local proxy per entry; `url` is a placeholder the container replaces with its own
 * loopback address — what matters over the wire is the NAME.
 *
 */
export function offeredTunnelServers(
  conversationId: string,
  deps: TunnelTargetDeps,
): Array<{ type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> }> {
  if (!deps.mcpUrlFor) return []; // nothing to offer -> the container starts no proxy
  // The URL here is a PLACEHOLDER: the container replaces it with its own local proxy address.
  // What travels over the wire — and what the agent-host resolves — is the NAME.
  void conversationId;
  return [
    { type: "http", name: SCOOTER_ENV, url: `tunnel://${SCOOTER_ENV}`, headers: [] },
    // The contrib provider tools. Without this a BYO agent has the github SKILL
    // telling it to call agent-broker and no github tool to call.
    ...(deps.brokerMcpUrlFor
      ? [{ type: "http" as const, name: SCOOTER_BROKER, url: `tunnel://${SCOOTER_BROKER}`, headers: [] }]
      : []),
  ];
}
