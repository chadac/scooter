/**
 * Conversation-token contract (issue #700).
 *
 * The high-value assertions here are the NEGATIVE ones: this token is the only thing
 * standing between a caller and another conversation's sandbox exec, subagents and
 * scheduled tasks, now that `?conv=` is gone.
 *
 * It also pins the wire format against the frozen cross-language vector, because the
 * broker verifies these tokens in Python. A change here that alters the encoding
 * fails `services/broker/tests/test_conv_token.py` too.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CONV_TOKEN_AUDIENCE,
  CONV_TOKEN_ISSUER,
  bearerFrom,
  mintConvToken,
  verifyConvToken,
} from "../../src/auth/convToken.js";
import { signHs256 } from "../../src/auth/hs256.js";

const vector = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/conv-token.json", import.meta.url)), "utf8"),
) as {
  secret: string;
  token: string;
  claims: { aud: string; iss: string; sub: string; owner: string; iat: number; exp: number };
  verifyAtEpochSeconds: number;
  expiredAtEpochSeconds: number;
};

const SECRET = "a-test-secret";

describe("conversation token", () => {
  it("round-trips the conversation id and owner", () => {
    const token = mintConvToken("conv-1", SECRET, { owner: "alice@example.com" });
    const res = verifyConvToken(token, SECRET);
    expect(res).toEqual({ ok: true, conversationId: "conv-1", owner: "alice@example.com" });
  });

  it("omits owner when none was given rather than carrying an empty one", () => {
    const res = verifyConvToken(mintConvToken("conv-1", SECRET), SECRET);
    expect(res).toEqual({ ok: true, conversationId: "conv-1" });
  });

  // THE test. A token minted for one conversation must not verify as another, and the
  // only way to get a conversation id out of this module is to have signed it.
  it("cannot be re-pointed at another conversation", () => {
    const token = mintConvToken("conv-victim", SECRET);
    const [h, payload, sig] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    claims.sub = "conv-attacker";
    const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${sig}`;
    expect(verifyConvToken(forged, SECRET)).toEqual({ ok: false, reason: "bad signature" });
  });

  it("rejects a token signed with a different secret", () => {
    const token = mintConvToken("conv-1", "some-other-secret");
    expect(verifyConvToken(token, SECRET)).toEqual({ ok: false, reason: "bad signature" });
  });

  // alg confusion: verify() recomputes an HS256 MAC, so a token asking for `none`
  // fails the signature comparison instead of selecting a no-op algorithm.
  it("rejects an alg:none token with an empty signature", () => {
    const claims = { aud: CONV_TOKEN_AUDIENCE, iss: CONV_TOKEN_ISSUER, sub: "conv-1", exp: 9999999999, iat: 0 };
    const h = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
    expect(verifyConvToken(`${h}.${p}.`, SECRET).ok).toBe(false);
  });

  it("rejects a BYOC join token replayed as a conversation token", () => {
    // Same secret, same algorithm, different audience — which is exactly why the
    // audience is pinned on both token types.
    const joinish = signHs256({ aud: "remote-agent", iss: CONV_TOKEN_ISSUER, sub: "conv-1", exp: 9999999999, iat: 0 }, SECRET);
    expect(verifyConvToken(joinish, SECRET)).toEqual({ ok: false, reason: "wrong audience" });
  });

  it("rejects a token from an unexpected issuer", () => {
    const other = signHs256({ aud: CONV_TOKEN_AUDIENCE, iss: "somebody-else", sub: "conv-1", exp: 9999999999, iat: 0 }, SECRET);
    expect(verifyConvToken(other, SECRET)).toEqual({ ok: false, reason: "wrong issuer" });
  });

  it("rejects an expired token, and accepts it one second before expiry", () => {
    const token = mintConvToken("conv-1", SECRET, { ttlSeconds: 100, now: 1_000 });
    expect(verifyConvToken(token, SECRET, 1_099).ok).toBe(true);
    expect(verifyConvToken(token, SECRET, 1_100)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a malformed token without throwing", () => {
    for (const bad of ["", "nope", "a.b", "a.b.c.d"]) {
      expect(verifyConvToken(bad, SECRET).ok).toBe(false);
    }
  });

  // A missing secret must FAIL CLOSED. Verifying against "" would otherwise accept
  // anything an attacker signed with "" — the worst possible misconfiguration.
  it("fails closed when no secret is configured", () => {
    const token = mintConvToken("conv-1", SECRET);
    expect(verifyConvToken(token, "")).toEqual({
      ok: false,
      reason: "no conversation-token secret configured",
    });
  });

  it("refuses to mint without a conversation id or a secret", () => {
    expect(() => mintConvToken("", SECRET)).toThrow(/conversationId is required/);
    expect(() => mintConvToken("conv-1", "")).toThrow(/secret is required/);
  });

  describe("the frozen cross-language vector", () => {
    it("verifies the committed token (the broker's pytest asserts the same)", () => {
      const res = verifyConvToken(vector.token, vector.secret, vector.verifyAtEpochSeconds);
      expect(res).toEqual({
        ok: true,
        conversationId: vector.claims.sub,
        owner: vector.claims.owner,
      });
    });

    it("still re-mints byte-identically from the vector's claims", () => {
      // Pins the ENCODING (claim order, base64url, no padding), not just the claims —
      // the part the Python side cannot tell us is wrong, since it only verifies.
      const reminted = mintConvToken(vector.claims.sub, vector.secret, {
        owner: vector.claims.owner,
        now: vector.claims.iat,
        ttlSeconds: vector.claims.exp - vector.claims.iat,
      });
      expect(reminted).toBe(vector.token);
    });

    it("treats the vector as expired past its exp", () => {
      expect(verifyConvToken(vector.token, vector.secret, vector.expiredAtEpochSeconds)).toEqual({
        ok: false,
        reason: "expired",
      });
    });
  });

  describe("bearerFrom", () => {
    it("extracts a bearer token case-insensitively", () => {
      expect(bearerFrom("Bearer abc")).toBe("abc");
      expect(bearerFrom("bearer  abc  ")).toBe("abc");
      expect(bearerFrom("BEARER abc")).toBe("abc");
    });
    it("returns undefined for anything else", () => {
      for (const bad of [undefined, "", "abc", "Basic abc", "Bearer"]) {
        expect(bearerFrom(bad as string | undefined)).toBeUndefined();
      }
    });
  });
});
