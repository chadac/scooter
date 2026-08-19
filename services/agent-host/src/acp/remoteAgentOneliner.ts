/**
 * Builds the Settings "Connect your Claude agent" payload: an owner-bound join token + the
 * ready-to-copy `docker run` one-liner (token + wss URL baked in). Separated for testability.
 * See todo/docs/BYO_CLAUDE_REMOTE_AGENT.md §H/§I.
 */

import { mintJoinToken } from "../auth/remoteAgentToken.js";

/** The published container image (ghcr). Overridable for a private registry / a pinned tag. */
const DEFAULT_IMAGE = "ghcr.io/chadac/scooter-remote-agent:latest";

/** The wss connect URL the CONTAINER dials. This is the WEBHOOKS bridge (/claude-bridge/connect),
 *  NOT the agent-host — webhooks has no user-facing auth (the ALB/user-auth that fronts the UI
 *  would otherwise block the container), verifies the join token, and proxies to the agent-host's
 *  internal /remote-agent/connect. `bridgeUrl` is the webhooks public base URL
 *  (REMOTE_AGENT_BRIDGE_URL). http→ws, https→wss; a bare host defaults to wss. */
export function connectWsUrl(bridgeUrl: string | undefined): string {
  const base = (bridgeUrl ?? "").trim().replace(/\/$/, "");
  const path = "/claude-bridge/connect";
  if (!base) return `wss://<your-webhooks-host>${path}`;
  if (base.startsWith("https://")) return base.replace(/^https:\/\//, "wss://") + path;
  if (base.startsWith("http://")) return base.replace(/^http:\/\//, "ws://") + path;
  return `wss://${base}${path}`;
}

/** The full `docker run` one-liner (restart-always service form). The container serves the local
 *  Claude login on 127.0.0.1:1717 (published to the host) on first run, then connects. */
export function dockerCommand(wsUrl: string, token: string, image = DEFAULT_IMAGE): string {
  return [
    "docker run -d --restart always --name scooter-agent",
    "  -p 127.0.0.1:1717:1717",
    "  -v scooter-claude:/root/.claude",
    `  ${image}`,
    `  --url ${wsUrl}`,
    `  --join ${token}`,
  ].join(" \\\n");
}

export interface RemoteAgentUiDeps {
  joinSecret: string;
  /** The WEBHOOKS bridge public base URL (REMOTE_AGENT_BRIDGE_URL) the container dials —
   *  /claude-bridge/connect is appended. The bridge (unauthed) verifies + proxies to the agent-host. */
  bridgeUrl?: string;
  /** Synchronous connected check (in-memory live registry). Use this OR isConnectedAsync. */
  isConnected?: (owner: string) => boolean;
  /** Async connected check (the durable Postgres badge, cross-replica). Preferred when a DB is
   *  wired; falls back to isConnected otherwise. */
  isConnectedAsync?: (owner: string) => Promise<boolean>;
  image?: string;
  /** Join-token TTL (seconds). Long enough to copy + start the container. */
  ttlSeconds?: number;
}

/** The `remoteAgent` dep the management API's Settings routes consume. */
export function createRemoteAgentUi(deps: RemoteAgentUiDeps) {
  const wsUrl = connectWsUrl(deps.bridgeUrl);
  return {
    mint(owner: string) {
      const token = mintJoinToken(owner, deps.joinSecret, { ttlSeconds: deps.ttlSeconds ?? 900 });
      return { token, wsUrl, dockerCommand: dockerCommand(wsUrl, token, deps.image) };
    },
    /** Is the owner's agent connected? Prefers the durable (async) check; falls back to the
     *  sync live-registry check; false if neither is wired. */
    async isConnected(owner: string): Promise<boolean> {
      if (deps.isConnectedAsync) return deps.isConnectedAsync(owner);
      if (deps.isConnected) return deps.isConnected(owner);
      return false;
    },
  };
}
