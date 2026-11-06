/**
 * The BYOC session registry: who owns which container socket. A single component owns the
 * sockets and everyone else resolves by owner, which lets any agent-host replica drive any
 * container. The socket is in-memory while the owner -> session mapping is durable, so
 * liveness means the durable row exists and the socket is present.
 */

import { randomUUID } from "node:crypto";

import { mintJoinToken, verifyJoinToken } from "./joinToken.js";

/** The minimum a socket must do for the registry to hold it. */
export interface ContainerSocket {
  send(data: string): void;
  /** Close, optionally with an application code and reason so the container can log why and pick its retry cadence. */
  close(code?: number, reason?: string): void;
}

/** Application close code: another container for the same owner connected. */
export const CLOSE_SUPERSEDED = 4002;

/** The durable half: the `remote_agents` table with its `session_id` column. */
export interface SessionStore {
  put(owner: string, sessionId: string): Promise<void>;
  setStatus(owner: string, status: "online" | "offline"): Promise<void>;
  getByOwner(owner: string): Promise<{ owner: string; sessionId: string; status: "online" | "offline" } | null>;
  close(): Promise<void>;
}

export interface ResolvedSession {
  sessionId: string;
  owner: string;
  /** Present only while a container is connected to this process. */
  socket?: ContainerSocket;
  /** socket !== undefined, the only trustworthy liveness signal for routing. */
  online: boolean;
}

export type AttachResult = { ok: true; sessionId: string } | { ok: false; reason: string };

export interface SessionRegistryConfig {
  store: SessionStore;
  /** HMAC secret for join tokens. */
  secret: string;
  /** Join-token TTL, short because it only has to survive copying the one-liner. */
  tokenTtlSeconds?: number;
}

export interface SessionRegistry {
  mint(owner: string): Promise<{ sessionId: string; token: string }>;
  attach(sessionId: string, token: string, socket: ContainerSocket): AttachResult;
  /** Load the owner's stored session into memory if absent, so a restart keeps its id. */
  recover(owner: string): Promise<void>;
  /** Attach a device-authenticated container by its verified `owner` (the owner's current session, else a fresh persisted one, since `urlSessionId` may be stale), returning the sessionId actually attached. */
  attachAuthenticated(urlSessionId: string, owner: string, socket: ContainerSocket): AttachResult;
  detach(sessionId: string): void;
  /** Detach only if `socket` is still the current one. */
  detachIfCurrent(sessionId: string, socket: ContainerSocket): void;
  resolveByOwner(owner: string): ResolvedSession | null;
  resolveBySession(sessionId: string): ResolvedSession | null;
}

export function createSessionRegistry(config: SessionRegistryConfig): SessionRegistry {
  const { store, secret } = config;
  // sessionId -> the session's owner and its live socket, if any.
  const sessions = new Map<string, { owner: string; socket?: ContainerSocket }>();
  // owner -> sessionId, a read index so resolveByOwner stays O(1).
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
      // Supersede any previous session for this owner, or a stale container could keep serving the owner's prompts.
      const previous = byOwner.get(owner);
      if (previous) sessions.delete(previous);
      sessions.set(sessionId, { owner });
      byOwner.set(owner, sessionId);
      // Persist before any socket exists, so the UI can show the minted state and a restart mid-setup does not lose it.
      await store.put(owner, sessionId);
      return { sessionId, token };
    },

    attach(sessionId, token, socket) {
      const s = sessions.get(sessionId);
      if (!s) return { ok: false, reason: "unknown session" };
      const verified = verifyJoinToken(token, secret);
      if (!verified.ok) return { ok: false, reason: verified.reason };
      // A valid token must also belong to the owner of this session, or anyone with a token of their own could attach to someone else's session.
      if (verified.claims.owner !== s.owner) return { ok: false, reason: "owner mismatch" };
      // A reconnect supersedes the old socket.
      if (s.socket && s.socket !== socket) {
        s.socket.close(CLOSE_SUPERSEDED, "another container connected for this owner");
      }
      s.socket = socket;
      void store.setStatus(s.owner, "online").catch(() => {});
      return { ok: true, sessionId };
    },

    async recover(owner) {
      if (byOwner.has(owner)) return;
      const row = await store.getByOwner(owner).catch(() => null);
      // A mint or attach during the lookup wins over the stored row.
      if (!row || byOwner.has(owner)) return;
      sessions.set(row.sessionId, { owner });
      byOwner.set(owner, row.sessionId);
    },

    attachAuthenticated(urlSessionId, owner, socket) {
      // Attach by the verified owner, never by the URL id, which may be stale or belong to another owner.
      let sessionId = byOwner.get(owner);
      if (!sessionId) {
        // An owner with no stored session gets a fresh one, not a re-mint.
        sessionId = randomUUID();
        sessions.set(sessionId, { owner });
        byOwner.set(owner, sessionId);
        void store.put(owner, sessionId).catch(() => {});
      }
      const s = sessions.get(sessionId)!;
      if (s.socket && s.socket !== socket) {
        s.socket.close(CLOSE_SUPERSEDED, "another container connected for this owner");
      }
      s.socket = socket;
      void store.setStatus(owner, "online").catch(() => {});
      if (sessionId !== urlSessionId) {
        // eslint-disable-next-line no-console
        console.log(
          `[byoc] device re-attach: owner=${owner} url session ${urlSessionId} is stale — attached to ${sessionId}`,
        );
      }
      return { ok: true, sessionId };
    },

    detach(sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return;
      s.socket = undefined;
      void store.setStatus(s.owner, "offline").catch(() => {});
    },

    detachIfCurrent(sessionId, socket) {
      const s = sessions.get(sessionId);
      // A superseded connection's close arrives after the replacement attached and must not drop the current socket.
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
