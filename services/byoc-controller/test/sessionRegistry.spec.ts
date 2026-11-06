/**
 * Tier 1 contract for the BYOC session registry, which agent-hosts resolve a container by
 * owner through:
 *
 *   mint(owner)            -> a session id and an owner-bound join token
 *   attach(id, socket)     -> only with a valid token for that session's owner
 *   resolveByOwner(owner)  -> the live session, from any caller
 *
 * The socket is in-memory while the owner->session mapping is durable.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { createSessionRegistry, type SessionRegistry, type SessionStore } from "../src/sessionRegistry.js";
import { mintJoinToken } from "../src/joinToken.js";

const SECRET = "test-secret";

/** In-memory stand-in for the Postgres-backed store, the durable half only. */
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

/** A stand-in for the container's WebSocket with only what the registry touches. */
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
    expect(token.split(".")).toHaveLength(3); // a JWT shape
    // The durable mapping exists before any socket connects.
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
    // A valid token for someone else: the token's owner must be checked against the session's owner.
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
    expect(reg.resolveByOwner("alice")?.online).toBe(false); // minted, no container yet
    reg.attach(sessionId, token, fakeSocket());
    expect(reg.resolveByOwner("alice")?.online).toBe(true);
    reg.detach(sessionId);
    // The durable row survives but liveness comes from the in-memory socket, never the DB.
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
    // A late close from the old connection must not flip an owner that has already reconnected.
    const { sessionId, token } = await reg.mint("alice");
    const first = fakeSocket();
    reg.attach(sessionId, token, first);
    const second = fakeSocket();
    reg.attach(sessionId, token, second); // reconnect supersedes `first`
    reg.detachIfCurrent(sessionId, first); // the old socket's close arrives late
    expect(reg.resolveByOwner("alice")?.online).toBe(true);
    expect(reg.resolveByOwner("alice")?.socket).toBe(second);
  });

  it("attachAuthenticated binds a socket WITHOUT a join token (the device-auth path, §P)", async () => {
    const { sessionId } = await reg.mint("alice");
    const sock = fakeSocket();
    expect(reg.attachAuthenticated(sessionId, "alice", sock).ok).toBe(true);
    expect(reg.resolveByOwner("alice")?.socket).toBe(sock);
  });

  it("attachAuthenticated NEVER attaches to another owner's session (cross-owner)", async () => {
    // Under attach-by-owner semantics mallory lands on mallory's own session and alice's stays socketless.
    const { sessionId } = await reg.mint("alice");
    const r = reg.attachAuthenticated(sessionId, "mallory", fakeSocket());
    expect(r.ok).toBe(true);
    expect(r.ok && r.sessionId).not.toBe(sessionId);
    expect(reg.resolveByOwner("alice")?.socket).toBeUndefined();
  });

  it("a STALE session URL re-attaches to the owner's CURRENT session (the 1005-loop fix)", async () => {
    // The signature proves the owner; the URL id baked into --url is a stale hint after a re-mint.
    const old = await reg.mint("alice");
    const current = await reg.mint("alice"); // supersedes old.sessionId
    const sock = fakeSocket();
    const r = reg.attachAuthenticated(old.sessionId, "alice", sock);
    expect(r.ok).toBe(true);
    expect(r.ok && r.sessionId).toBe(current.sessionId);
    expect(reg.resolveByOwner("alice")?.socket).toBe(sock);
  });

  it("an owner with NO session at all gets one CREATED on device attach (restart recovery)", async () => {
    // A controller restart empties the in-memory sessions, and a registered device dialing in afterwards must not need a re-mint.
    const sock = fakeSocket();
    const r = reg.attachAuthenticated("long-dead-session", "alice", sock);
    expect(r.ok).toBe(true);
    const resolved = reg.resolveByOwner("alice");
    expect(resolved?.socket).toBe(sock);
    expect(resolved?.online).toBe(true);
    // The mapping is durable, so /byoc/status agrees.
    expect(store.rows.get("alice")?.sessionId).toBe(r.ok ? r.sessionId : "?");
  });

  it("after a restart, recover + device attach reclaims the STORED session id", async () => {
    const { sessionId } = await reg.mint("alice");
    // A fresh registry over the same store is what a controller restart looks like.
    const restarted = createSessionRegistry({ store, secret: SECRET });
    await restarted.recover("alice");
    const sock = fakeSocket();
    const r = restarted.attachAuthenticated(sessionId, "alice", sock);
    expect(r.ok && r.sessionId).toBe(sessionId);
    expect(restarted.resolveByOwner("alice")?.socket).toBe(sock);
    expect(store.rows.get("alice")?.sessionId).toBe(sessionId);
  });

  it("recover never replaces a session already in memory", async () => {
    await reg.mint("alice");
    const current = await reg.mint("alice");
    store.rows.set("alice", { sessionId: "older-row", status: "offline" });
    await reg.recover("alice");
    expect(reg.resolveByOwner("alice")?.sessionId).toBe(current.sessionId);
  });

  it("recover is a no-op when the store fails or has no row", async () => {
    const failing = createSessionRegistry({
      store: { ...store, getByOwner: async () => { throw new Error("db down"); } },
      secret: SECRET,
    });
    await failing.recover("alice");
    expect(failing.resolveByOwner("alice")).toBeNull();
    await reg.recover("nobody");
    expect(reg.resolveByOwner("nobody")).toBeNull();
  });

  it("resolveByOwner returns null for an owner with no session", () => {
    expect(reg.resolveByOwner("nobody")).toBeNull();
  });
});
