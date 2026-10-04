/**
 * Minimal HS256 JWT sign/verify on node:crypto — the shared primitive behind every
 * token the agent-host MINTS for something else to verify (BYOC join tokens,
 * conversation tokens).
 *
 * Extracted from remoteAgentToken.ts, which had the only copy. A second caller
 * (convToken.ts) is verified by a DIFFERENT language — the broker, in Python — so
 * the signing format is now a cross-service contract and must have exactly one
 * implementation on this side. See `test/fixtures/conv-token.json` for the frozen
 * vector both suites check.
 *
 * NO EXTERNAL DEP, deliberately: adding a JWT library churns package-lock.json and
 * the nix hash checks `just ci` enforces, to replace ~30 lines of HMAC.
 *
 * ALG CONFUSION IS IMPOSSIBLE HERE, and not by checking the header: verify()
 * recomputes an HS256 MAC and compares, so a token claiming `alg: none` or
 * `alg: RS256` simply fails the comparison. There is no code path that selects an
 * algorithm from attacker-controlled input — which is the bug that makes the
 * generic libraries dangerous when misused.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const b64url = (buf: Buffer): string => buf.toString("base64url");
const fromB64url = (s: string): Buffer => Buffer.from(s, "base64url");

/** The fixed header. Emitted for compatibility with standard JWT parsers (the broker
 *  verifies with pyjwt, which requires it); never READ back on this side. */
const HEADER = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));

function mac(data: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(data).digest());
}

/** Sign `claims` as a compact HS256 JWT. Claims are written verbatim — expiry,
 *  audience and issuer are the caller's to put in. */
export function signHs256(claims: Record<string, unknown>, secret: string): string {
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  return `${HEADER}.${payload}.${mac(`${HEADER}.${payload}`, secret)}`;
}

export type Hs256Result<T> = { ok: true; claims: T } | { ok: false; reason: string };

/**
 * Verify the SIGNATURE and decode the claims. Deliberately checks nothing else:
 * `exp`, `aud` and whatever else a token means are the caller's semantics, and a
 * primitive that silently enforced some of them would invite callers to assume it
 * enforced all of them. Never throws.
 */
export function verifyHs256<T>(token: string, secret: string): Hs256Result<T> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };
  const [encHeader, encClaims, sig] = parts;
  const a = fromB64url(sig);
  const b = fromB64url(mac(`${encHeader}.${encClaims}`, secret));
  // Length check FIRST: timingSafeEqual throws on a length mismatch rather than
  // returning false, so a truncated signature would be an exception in the request
  // path instead of a clean rejection.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad signature" };
  try {
    return { ok: true, claims: JSON.parse(fromB64url(encClaims).toString("utf8")) as T };
  } catch {
    return { ok: false, reason: "bad claims" };
  }
}
