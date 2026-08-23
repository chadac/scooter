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
/** Reserved prefix for sandbox-declared servers (not resolvable yet). */
export const SANDBOX_PREFIX = "sandbox:";

/** What a resolved target points at. */
export interface ResolvedTarget {
  /** The absolute URL the agent-host will call on the container's behalf. */
  url: string;
  /** For logs: which rule matched. */
  rule: "scooter-env" | "sandbox";
}

export interface TunnelTargetDeps {
  /** The in-process MCP endpoint's URL for a conversation (mcpEndpoint.urlFor). Absent when
   *  the endpoint is not configured — then scooter-env simply is not offered. */
  mcpUrlFor?: (conversationId: string) => string;
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
    // The conversation comes from the caller (the stream's session), so the ?conv= scope is
    // never something the container chose.
    return { ok: true, target: { url: deps.mcpUrlFor(conversationId), rule: "scooter-env" } };
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
): Array<{ type: "http"; name: string; url: string; headers: string[] }> {
  if (!deps.mcpUrlFor) return []; // nothing to offer -> the container starts no proxy
  // The URL here is a PLACEHOLDER: the container replaces it with its own local proxy address.
  // What travels over the wire — and what the agent-host resolves — is the NAME.
  void conversationId;
  return [{ type: "http", name: SCOOTER_ENV, url: `tunnel://${SCOOTER_ENV}`, headers: [] }];
}
