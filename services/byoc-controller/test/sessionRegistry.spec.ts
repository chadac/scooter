/**
 * Tier 1 contract — the BYOC session registry (increment 1 of todo/docs/BYO_CLAUDE_REMOTE_AGENT.md §M).
 *
 * The registry is the whole point of the §L redesign: agent-hosts resolve a container by OWNER, not
 * by "which pod happens to hold the socket". So the contract under test is:
 *
 *   mint(owner)            -> a session id + an owner-bound join token
 *   attach(id, socket)     -> only with a VALID token for that session's owner
 *   resolveByOwner(owner)  -> the live session, from ANY caller (this is what makes agent-hosts
 *                             stateless — the #284 lesson: ask the component that owns the answer)
 *
 * Two lifetimes, deliberately split (§L Q4): the SOCKET is in-memory (a TCP connection cannot
 * outlive the process) while the owner->session MAPPING is durable, so a controller restart shows
 * "reconnecting" rather than stranding every conversation until the user re-mints.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { createSessionRegistry, type SessionRegistry, type SessionStore } from "../src/sessionRegistry.js";
import { mintJoinToken } from "../src/joinToken.js";

const SECRET = "test-secret";

/** In-memory stand-in for the Postgres-backed store (the real one adds `session_id` to
 *  `remote_agents`). Mirrors the durable half only — sockets never live here. */
function fakeStore(): SessionStore & { rows: Map<string, { sessionId: string; status: string }> } {
  const rows = new Map<string, { sessionId: string; status: string }>();
  return {
    rows,
    async put(owner, sessionId) {
      rows.set(owner, { sessionId, status: "offline" });
    },
    async setStatus(owner, status) {
      const r = rows.get(owner);
      if (r) r.status = status;
    },
    async getByOwner(owner) {
      const r = rows.get(owner);
      return r ? { owner, sessionId: r.sessionId, status: r.status as "online" | "offline" } : null;
    },
    async close() {},
  };
}

/** A stand-in for the container's WebSocket — only what the registry touches. */
function fakeSocket() {
  return { sent: [] as string[], closed: false, send(s: string) { this.sent.push(s); }, close() { this.closed = true; } };
}

describe("BYOC session registry", () => {
  let store: ReturnType<typeof fakeStore>;
  let reg: SessionRegistry;

  beforeEach(() => {
    store = fakeStore();
    reg = createSessionRegistry({ store, secret: SECRET });
  });

  it("mint returns a session id + a token that carries the OWNER", async () => {
    const { sessionId, token } = await reg.mint("alice");
    expect(sessionId).toMatch(/\S/);
    expect(token.split(".")).toHaveLength(3); // a real JWT shape
    // The durable mapping exists immediately — before any socket connects — so the UI can render
    // "waiting for your container" and a restart mid-setup does not lose the session.
    expect((await store.getByOwner("alice"))?.sessionId).toBe(sessionId);
  });

  it("attach binds a socket only with a VALID token for that session", async () => {
    const { sessionId, token } = await reg.mint("alice");
    const sock = fakeSocket();
    expect(reg.attach(sessionId, token, sock).ok).toBe(true);
    expect(reg.resolveByOwner("alice")?.socket).toBe(sock);
  });

  it("attach REJECTS a token signed with the wrong secret", async () => {
    const { sessionId } = await reg.mint("alice");
    const forged = mintJoinToken("alice", "not-the-secret");
    const res = reg.attach(sessionId, forged, fakeSocket());
    expect(res.ok).toBe(false);
    expect(reg.resolveByOwner("alice")?.socket).toBeUndefined();
  });

  it("attach REJECTS a token whose owner does not own the session (cross-owner hijack)", async () => {
    const { sessionId } = await reg.mint("alice");
    // A perfectly valid token — for someone else. The unauthenticated ingress (§L Q3) makes this
    // the attack that matters: anyone can reach /byoc/ws/:id, so the token's owner MUST be checked
    // against the session's owner, not merely verified as well-formed.
    const mallory = mintJoinToken("mallory", SECRET);
    const res = reg.attach(sessionId, mallory, fakeSocket());
    expect(res.ok).toBe(false);
    expect(reg.resolveByOwner("alice")?.socket).toBeUndefined();
  });

  it("attach REJECTS an expired token", async () => {
    const { sessionId } = await reg.mint("alice");
    const expired = mintJoinToken("alice", SECRET, { ttlSeconds: -1 });
    expect(reg.attach(sessionId, expired, fakeSocket()).ok).toBe(false);
  });

  it("resolveByOwner reports ONLINE only while a socket is actually attached", async () => {
    const { sessionId, token } = await reg.mint("alice");
    expect(reg.resolveByOwner("alice")?.online).toBe(false); // minted, container not up yet
    reg.attach(sessionId, token, fakeSocket());
    expect(reg.resolveByOwner("alice")?.online).toBe(true);
    reg.detach(sessionId);
    // Durable row survives; liveness does not. A stale "online" would MISROUTE a prompt to a dead
    // socket, so liveness must come from the in-memory socket, never from the DB.
    expect(reg.resolveByOwner("alice")?.online).toBe(false);
    expect((await store.getByOwner("alice"))?.sessionId).toBe(sessionId);
  });

  it("a RECONNECT re-attaches to the SAME session id (no re-mint, conversations keep working)", async () => {
    const { sessionId, token } = await reg.mint("alice");
    reg.attach(sessionId, token, fakeSocket());
    reg.detach(sessionId);
    const second = fakeSocket();
    expect(reg.attach(sessionId, token, second).ok).toBe(true);
    expect(reg.resolveByOwner("alice")?.socket).toBe(second);
  });

  it("a SUPERSEDED socket closing does not knock the freshly-reconnected one offline", async () => {
    // The guard the existing remoteAgentStore already got right, easy to lose in a rewrite: a late
    // close from the OLD connection must not flip an owner that has already reconnected.
    const { sessionId, token } = await reg.mint("alice");
    const first = fakeSocket();
    reg.attach(sessionId, token, first);
    const second = fakeSocket();
    reg.attach(sessionId, token, second); // reconnect supersedes `first`
    reg.detachIfCurrent(sessionId, first); // the old socket's close arrives LATE
    expect(reg.resolveByOwner("alice")?.online).toBe(true);
    expect(reg.resolveByOwner("alice")?.socket).toBe(second);
  });

  it("attachAuthenticated binds a socket WITHOUT a join token (the device-auth path, §P)", async () => {
    const { sessionId } = await reg.mint("alice");
    const sock = fakeSocket();
    expect(reg.attachAuthenticated(sessionId, "alice", sock).ok).toBe(true);
    expect(reg.resolveByOwner("alice")?.socket).toBe(sock);
  });

  it("attachAuthenticated REJECTS an owner who does not own the session (cross-owner)", async () => {
    const { sessionId } = await reg.mint("alice");
    expect(reg.attachAuthenticated(sessionId, "mallory", fakeSocket()).ok).toBe(false);
    expect(reg.resolveByOwner("alice")?.socket).toBeUndefined();
  });

  it("attachAuthenticated REJECTS an unknown session", () => {
    expect(reg.attachAuthenticated("no-such-session", "alice", fakeSocket()).ok).toBe(false);
  });

  it("resolveByOwner returns null for an owner with no session", () => {
    expect(reg.resolveByOwner("nobody")).toBeNull();
  });
});
