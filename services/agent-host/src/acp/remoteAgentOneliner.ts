/**
 * Builds the Settings "Connect your Claude agent" payload: an owner-bound join token + the
 * ready-to-copy `docker run` one-liner (token + wss URL baked in). Separated for testability.
 * See todo/docs/BYO_CLAUDE_REMOTE_AGENT.md §H/§I.
 */

import { mintJoinToken } from "../auth/remoteAgentToken.js";

/** The published container image (ghcr). Overridable for a private registry / a pinned tag. */
const DEFAULT_IMAGE = "ghcr.io/chadac/scooter-remote-agent:latest";

/** Derive the wss connect URL from the deployment's public base URL. http→ws, https→wss; a bare
 *  host defaults to wss. Always the /remote-agent/connect path (same host as the UI). */
export function connectWsUrl(publicUrl: string | undefined): string {
  const base = (publicUrl ?? "").trim().replace(/\/$/, "");
  if (!base) return "wss://<your-scooter-host>/remote-agent/connect";
  if (base.startsWith("https://")) return base.replace(/^https:\/\//, "wss://") + "/remote-agent/connect";
  if (base.startsWith("http://")) return base.replace(/^http:\/\//, "ws://") + "/remote-agent/connect";
  return `wss://${base}/remote-agent/connect`;
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
  publicUrl?: string;
  isConnected(owner: string): boolean;
  image?: string;
  /** Join-token TTL (seconds). Long enough to copy + start the container. */
  ttlSeconds?: number;
}

/** The `remoteAgent` dep the management API's Settings routes consume. */
export function createRemoteAgentUi(deps: RemoteAgentUiDeps) {
  const wsUrl = connectWsUrl(deps.publicUrl);
  return {
    mint(owner: string) {
      const token = mintJoinToken(owner, deps.joinSecret, { ttlSeconds: deps.ttlSeconds ?? 900 });
      return { token, wsUrl, dockerCommand: dockerCommand(wsUrl, token, deps.image) };
    },
    isConnected: deps.isConnected,
  };
}
