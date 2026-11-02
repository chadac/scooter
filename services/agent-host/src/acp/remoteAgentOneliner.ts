/** Builds the Settings "Connect your Claude agent" payload: an owner-bound join token plus the ready-to-copy `docker run` one-liner. */

import { mintJoinToken } from "../auth/remoteAgentToken.js";

/** The published container image, overridable for a private registry or a pinned tag. */
const DEFAULT_IMAGE = "ghcr.io/chadac-me/scooter/remote-agent:latest";

/** The ws(s) URL the container dials for one minted session, derived from the public BYOC base (a bare host defaults to wss). */
export function connectWsUrl(publicByocUrl: string | undefined, sessionId: string): string {
  const base = (publicByocUrl ?? "").trim().replace(/\/$/, "");
  const path = `/byoc/ws/${encodeURIComponent(sessionId)}`;
  if (!base) return `wss://<your-byoc-host>${path}`;
  if (base.startsWith("https://")) return base.replace(/^https:\/\//, "wss://") + path;
  if (base.startsWith("http://")) return base.replace(/^http:\/\//, "ws://") + path;
  return `wss://${base}${path}`;
}

/** The full `docker run` one-liner; the container serves a local token-entry page on 127.0.0.1:34579 on first run, where the user pastes their `claude setup-token` output. */
export function dockerCommand(wsUrl: string, token: string, image = DEFAULT_IMAGE): string {
  return [
    "docker run -d --restart always --name scooter-agent",
    "  -p 127.0.0.1:34579:34579",
    "  -v scooter-claude:/root/.claude",
    `  ${image}`,
    `  --url ${wsUrl}`,
    `  --join ${token}`,
  ].join(" \\\n");
}

export interface RemoteAgentStatus {
  connected: boolean;
  lastAuthFailure: { reason: string; at: string } | null;
}

export interface RemoteAgentUiDeps {
  joinSecret: string;
  /** The BYOC controller's in-cluster base URL, where the session is minted. */
  controllerUrl: string;
  /** The controller's public base URL, which the container dials from the user's laptop. */
  publicByocUrl?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Synchronous connected check against the in-memory live registry. */
  isConnected?: (owner: string) => boolean;
  /** Async connected check against the durable Postgres badge, preferred over isConnected when wired. */
  isConnectedAsync?: (owner: string) => Promise<boolean>;
  /** Full status from the controller, including the owner's most recent rejected connection attempt. */
  statusAsync?: (owner: string) => Promise<RemoteAgentStatus>;
  image?: string;
  /** Join-token TTL in seconds. */
  ttlSeconds?: number;
}

/** The `remoteAgent` dep the management API's Settings routes consume. */
export function createRemoteAgentUi(deps: RemoteAgentUiDeps) {
  const doFetch = deps.fetchImpl ?? fetch;
  return {
    /** Mint a session on the controller, then build the one-liner around it. */
    async mint(owner: string) {
      const res = await doFetch(`${deps.controllerUrl.replace(/\/$/, "")}/byoc/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-auth-request-user": owner },
      }).catch((err: unknown) => {
        throw new Error(`could not mint a BYOC session: ${String(err)}`);
      });
      if (!res.ok) {
        // A one-liner that cannot connect is worse than an error.
        throw new Error(`could not mint a BYOC session (${res.status})`);
      }
      const { sessionId } = (await res.json()) as { sessionId: string };
      const wsUrl = connectWsUrl(deps.publicByocUrl, sessionId);
      const token = mintJoinToken(owner, deps.joinSecret, { ttlSeconds: deps.ttlSeconds ?? 900 });
      return { token, wsUrl, dockerCommand: dockerCommand(wsUrl, token, deps.image) };
    },
    /** Status detail for the Settings page, degrading to the boolean check when the detailed probe is not wired. */
    async status(owner: string): Promise<RemoteAgentStatus> {
      if (deps.statusAsync) return deps.statusAsync(owner);
      return { connected: await this.isConnected(owner), lastAuthFailure: null };
    },
    /** Whether the owner's agent is connected, preferring the durable check over the live registry. */
    async isConnected(owner: string): Promise<boolean> {
      if (deps.isConnectedAsync) return deps.isConnectedAsync(owner);
      if (deps.isConnected) return deps.isConnected(owner);
      return false;
    },
  };
}
