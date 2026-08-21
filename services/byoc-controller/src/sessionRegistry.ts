/**
 * The BYOC session registry — who owns which container socket.
 *
 * This is the core of the §L redesign (todo/docs/BYO_CLAUDE_REMOTE_AGENT.md). Before it, each
 * agent-host pod held container sockets in its own memory, so only the pod the container happened
 * to reach could drive that brain — the same shape of bug as the conversation list in #284. Here a
 * single component owns the sockets and everyone else RESOLVES BY OWNER, which is what lets any
 * agent-host replica drive any container.
 *
 * TWO LIFETIMES, deliberately split (§L Q4):
 *   - the SOCKET is in-memory. A TCP connection cannot outlive the process, and the container
 *     already reconnects on its own, so persisting it would buy nothing and risk a stale "online".
 *   - the owner -> session MAPPING is durable. Without it every controller rollout would strand
 *     live conversations until the user noticed and re-minted.
 *
 * LIVENESS therefore means "durable row exists AND socket present". Reporting online from the DB
 * alone would misroute a prompt into a dead socket; reporting it from the socket alone would lose
 * the session across a restart. The UI reads both and can say "reconnecting" instead of lying.
 */

import { randomUUID } from "node:crypto";

import { mintJoinToken, verifyJoinToken } from "./joinToken.js";

/** The minimum a socket must do for the registry to hold it (the real one is a ws.WebSocket). */
export interface ContainerSocket {
  send(data: string): void;
  close(): void;
}

/** The durable half — `remote_agents` extended with a `session_id` column (§L Q4). */
export interface SessionStore {
  put(owner: string, sessionId: string): Promise<void>;
  setStatus(owner: string, status: "online" | "offline"): Promise<void>;
  getByOwner(owner: string): Promise<{ owner: string; sessionId: string; status: "online" | "offline" } | null>;
  close(): Promise<void>;
}

export interface ResolvedSession {
  sessionId: string;
  owner: string;
  /** Present only while a container is actually connected to THIS process. */
  socket?: ContainerSocket;
  /** socket !== undefined — the only trustworthy liveness signal for routing. */
  online: boolean;
}

export type AttachResult = { ok: true } | { ok: false; reason: string };

export interface SessionRegistryConfig {
  store: SessionStore;
  /** HMAC secret for join tokens. */
  secret: string;
  /** Join-token TTL; short by design — it only has to survive copying the one-liner. */
  tokenTtlSeconds?: number;
}

export interface SessionRegistry {
  mint(owner: string): Promise<{ sessionId: string; token: string }>;
  attach(sessionId: string, token: string, socket: ContainerSocket): AttachResult;
  /** Attach when the caller is ALREADY authenticated (a device signature, §P) and so has no join
   *  token to re-verify. `owner` MUST come from a verified source — this trusts it. */
  attachAuthenticated(sessionId: string, owner: string, socket: ContainerSocket): AttachResult;
  detach(sessionId: string): void;
  /** Detach ONLY if `socket` is still the current one (a late close from a superseded connection). */
  detachIfCurrent(sessionId: string, socket: ContainerSocket): void;
  resolveByOwner(owner: string): ResolvedSession | null;
  resolveBySession(sessionId: string): ResolvedSession | null;
}

export function createSessionRegistry(config: SessionRegistryConfig): SessionRegistry {
  const { store, secret } = config;
  // sessionId -> the session's owner + its live socket (if any). In-memory ON PURPOSE (see header).
  const sessions = new Map<string, { owner: string; socket?: ContainerSocket }>();
  // owner -> sessionId, a read index over the same data so resolveByOwner stays O(1).
  const byOwner = new Map<string, string>();

  const view = (sessionId: string): ResolvedSession | null => {
    const s = sessions.get(sessionId);
    if (!s) return null;
    return { sessionId, owner: s.owner, socket: s.socket, online: s.socket !== undefined };
  };

  return {
    async mint(owner) {
      const sessionId = randomUUID();
      const token = mintJoinToken(owner, secret, { ttlSeconds: config.tokenTtlSeconds });
      // Supersede any previous session for this owner: minting is an explicit "start over", and
      // leaving the old id resolvable would let a stale container keep serving the owner's prompts.
      const previous = byOwner.get(owner);
      if (previous) sessions.delete(previous);
      sessions.set(sessionId, { owner });
      byOwner.set(owner, sessionId);
      // Durable BEFORE any socket exists, so the UI can show "waiting for your container" and a
      // restart mid-setup does not lose the session the user is in the middle of creating.
      await store.put(owner, sessionId);
      return { sessionId, token };
    },

    attach(sessionId, token, socket) {
      const s = sessions.get(sessionId);
      if (!s) return { ok: false, reason: "unknown session" };
      const verified = verifyJoinToken(token, secret);
      if (!verified.ok) return { ok: false, reason: verified.reason };
      // THE check that matters: /byoc/ws/:id is reachable unauthenticated (§L Q3), so a valid token
      // is not enough — it must belong to the owner of THIS session. Otherwise anyone holding a
      // token of their own could attach their container to someone else's session and receive that
      // user's prompts.
      if (verified.claims.owner !== s.owner) return { ok: false, reason: "owner mismatch" };
      // A reconnect supersedes the old socket; close it so the container does not keep two live.
      if (s.socket && s.socket !== socket) s.socket.close();
      s.socket = socket;
      void store.setStatus(s.owner, "online").catch(() => {});
      return { ok: true };
    },

    attachAuthenticated(sessionId, owner, socket) {
      const s = sessions.get(sessionId);
      if (!s) return { ok: false, reason: "unknown session" };
      // Still check the owner matches: device auth proves WHO the caller is, not that this session
      // is theirs. Skipping it would let a valid device attach to anyone's session — the same
      // cross-owner hole the token path guards against.
      if (s.owner !== owner) return { ok: false, reason: "owner mismatch" };
      if (s.socket && s.socket !== socket) s.socket.close();
      s.socket = socket;
      void store.setStatus(s.owner, "online").catch(() => {});
      return { ok: true };
    },

    detach(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return;
      s.socket = undefined;
      void store.setStatus(s.owner, "offline").catch(() => {});
    },

    detachIfCurrent(sessionId, socket) {
      const s = sessions.get(sessionId);
      // A close event from a SUPERSEDED connection arrives after the replacement has already
      // attached. Dropping the current socket there would knock a freshly-reconnected owner
      // offline — the guard the existing remoteAgentStore already got right.
      if (!s || s.socket !== socket) return;
      s.socket = undefined;
      void store.setStatus(s.owner, "offline").catch(() => {});
    },

    resolveByOwner(owner) {
      const sessionId = byOwner.get(owner);
      return sessionId ? view(sessionId) : null;
    },

    resolveBySession(sessionId) {
      return view(sessionId);
    },
  };
}
