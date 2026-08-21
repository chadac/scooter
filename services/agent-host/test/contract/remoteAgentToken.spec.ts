/**
 * Tier 1 contract — the BYO remote-agent join token (HS256, node:crypto). Owner binding + the
 * verify guards the /remote-agent/connect WS relies on. See auth/remoteAgentToken.ts.
 */

import { describe, it, expect } from "vitest";

import { mintJoinToken, verifyJoinToken } from "../../src/auth/remoteAgentToken.js";

const SECRET = "test-secret-abc";

describe("remote-agent join token", () => {
  it("mints + verifies, returning the owner", () => {
    const t = mintJoinToken("alice", SECRET);
    const v = verifyJoinToken(t, SECRET);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.claims.owner).toBe("alice");
  });

  it("rejects a token signed with a DIFFERENT secret (bad signature)", () => {
    const t = mintJoinToken("alice", SECRET);
    const v = verifyJoinToken(t, "other-secret");
    expect(v).toEqual({ ok: false, reason: "bad signature" });
  });

  it("rejects a TAMPERED owner (signature covers the claims)", () => {
    const t = mintJoinToken("alice", SECRET);
    const [h, , s] = t.split(".");
    const forgedClaims = Buffer.from(JSON.stringify({ owner: "bob", exp: 9999999999, iat: 1, nonce: "x", aud: "remote-agent" })).toString("base64url");
    const forged = `${h}.${forgedClaims}.${s}`;
    expect(verifyJoinToken(forged, SECRET).ok).toBe(false);
  });

  it("rejects an EXPIRED token", () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const t = mintJoinToken("alice", SECRET, { ttlSeconds: 5, now: past - 5 });
    expect(verifyJoinToken(t, SECRET)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a malformed token", () => {
    expect(verifyJoinToken("not.a.jwt.at.all", SECRET).ok).toBe(false);
    expect(verifyJoinToken("garbage", SECRET).ok).toBe(false);
  });

  it("honors a custom TTL + a fresh nonce per mint", () => {
    const now = 1_000_000;
    const t = mintJoinToken("alice", SECRET, { ttlSeconds: 60, now });
    const v = verifyJoinToken(t, SECRET, now + 30);
    expect(v.ok).toBe(true);
    // Two mints get distinct nonces (single-use marker).
    const a = mintJoinToken("alice", SECRET);
    const b = mintJoinToken("alice", SECRET);
    const va = verifyJoinToken(a, SECRET);
    const vb = verifyJoinToken(b, SECRET);
    if (va.ok && vb.ok) expect(va.claims.nonce).not.toBe(vb.claims.nonce);
  });
});
