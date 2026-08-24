/**
 * Builds the Settings "Connect your Claude agent" payload: an owner-bound join token + the
 * ready-to-copy `docker run` one-liner (token + wss URL baked in). Separated for testability.
 */

import { mintJoinToken } from "../auth/remoteAgentToken.js";

/** The published container image (ghcr). Overridable for a private registry / a pinned tag. */
// ghcr.io/<owner>/scooter/<image> — the path scheme publish-images.yml actually pushes.
const DEFAULT_IMAGE = "ghcr.io/chadac/scooter/remote-agent:latest";

/** The ws(s) URL the CONTAINER dials, for ONE minted session (§L).
 *
 *  This replaced a STATIC bridge URL (`wss://<host>/claude-bridge/connect`, identical for every
 *  user). The controller path is per-owner — the session id is how it routes a prompt to the right
 *  container — so the URL can only be built AFTER minting. `publicByocUrl` is the public base of
 *  the BYOC ingress; http→ws, https→wss, and a bare host defaults to wss so a copy-paste never
 *  silently downgrades to plaintext. */
export function connectWsUrl(publicByocUrl: string | undefined, sessionId: string): string {
  const base = (publicByocUrl ?? "").trim().replace(/\/$/, "");
  const path = `/byoc/ws/${encodeURIComponent(sessionId)}`;
  if (!base) return `wss://<your-byoc-host>${path}`;
  if (base.startsWith("https://")) return base.replace(/^https:\/\//, "wss://") + path;
  if (base.startsWith("http://")) return base.replace(/^http:\/\//, "ws://") + path;
  return `wss://${base}${path}`;
}

/** The full `docker run` one-liner (restart-always service form). The container serves the local
 *  token-entry page on 127.0.0.1:34579 (published to the host) on first run — the user pastes their
 *  `claude setup-token` output there — then connects. (We can't run Claude's OAuth in-container: the
 *  authorize step is gated by a browser-minted hCaptcha attestation.) */
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
  /** The BYOC controller's IN-CLUSTER base URL — where the session is minted. */
  controllerUrl: string;
  /** The controller's PUBLIC base URL — what the container dials from the user's laptop. */
  publicByocUrl?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Synchronous connected check (in-memory live registry). Use this OR isConnectedAsync. */
  isConnected?: (owner: string) => boolean;
  /** Async connected check (the durable Postgres badge, cross-replica). Preferred when a DB is
   *  wired; falls back to isConnected otherwise. */
  isConnectedAsync?: (owner: string) => Promise<boolean>;
  /** Full status detail from the controller — connected + the owner's most recent REJECTED
   *  connection attempt, so the Settings page can say WHY a container is not connected
   *  instead of a clean "disconnected" identical to never-started. */
  statusAsync?: (owner: string) => Promise<RemoteAgentStatus>;
  image?: string;
  /** Join-token TTL (seconds). Long enough to copy + start the container. */
  ttlSeconds?: number;
}

/** The `remoteAgent` dep the management API's Settings routes consume. */
export function createRemoteAgentUi(deps: RemoteAgentUiDeps) {
  const doFetch = deps.fetchImpl ?? fetch;
  return {
    /** Mint a session on the CONTROLLER, then build the one-liner around it. Async because the
     *  session is per-owner and only the controller can create one — a static URL cannot route. */
    async mint(owner: string) {
      const res = await doFetch(`${deps.controllerUrl.replace(/\/$/, "")}/byoc/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-auth-request-user": owner },
      }).catch((err: unknown) => {
        throw new Error(`could not mint a BYOC session: ${String(err)}`);
      });
      if (!res.ok) {
        // FAIL LOUD. Handing back a one-liner that cannot connect is worse than an error: the user
        // runs it, it retries forever, and nothing says why.
        throw new Error(`could not mint a BYOC session (${res.status})`);
      }
      const { sessionId } = (await res.json()) as { sessionId: string };
      const wsUrl = connectWsUrl(deps.publicByocUrl, sessionId);
      const token = mintJoinToken(owner, deps.joinSecret, { ttlSeconds: deps.ttlSeconds ?? 900 });
      return { token, wsUrl, dockerCommand: dockerCommand(wsUrl, token, deps.image) };
    },
    /** Is the owner's agent connected? Prefers the durable (async) check; falls back to the
     *  sync live-registry check; false if neither is wired. */
    /** Status detail for the Settings page; degrades to the boolean check when the detailed
     *  probe is not wired (tests, legacy composition). */
    async status(owner: string): Promise<RemoteAgentStatus> {
      if (deps.statusAsync) return deps.statusAsync(owner);
      return { connected: await this.isConnected(owner), lastAuthFailure: null };
    },
    async isConnected(owner: string): Promise<boolean> {
      if (deps.isConnectedAsync) return deps.isConnectedAsync(owner);
      if (deps.isConnected) return deps.isConnected(owner);
      return false;
    },
  };
}
