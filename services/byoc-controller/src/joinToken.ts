/**
 * Join tokens for bring-your-own-Claude (BYOC) — a minimal HS256 JWT signed by a controller secret
 * (no external dep; node:crypto HMAC). The UI mints a short-lived, owner-bound token; the
 * /byoc/ws/:id WS upgrade verifies it offline and extracts the owner.
 *
 * Moved from the agent-host (`auth/remoteAgentToken.ts`) per todo/docs/BYO_CLAUDE_REMOTE_AGENT.md
 * §L: the controller owns the container socket now, so it owns the token that gates it.
 *
 * AUDIENCE IS DELIBERATELY DIFFERENT from the old "remote-agent". The BYOC connect path is the one
 * endpoint exposed UNAUTHENTICATED on the ingress (§L Q3) — if it accepted the old audience, a
 * token minted for the retired webhooks bridge would be replayable straight at it. The audience
 * check below is the whole reason that is not possible.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const AUDIENCE = "byoc";

export interface JoinClaims {
  /** The Scooter user the agent is bound to (routing + fencing key). */
  owner: string;
  /** Seconds-since-epoch expiry. */
  exp: number;
  /** Issued-at (seconds). */
  iat: number;
  /** Single-use nonce (CSRF / replay marker; the connect side may track recent nonces). */
  nonce: string;
  /** Audience — always "remote-agent"; rejected otherwise so a token minted for something else
   *  can't be replayed here. */
  aud: string;
}

const b64url = (buf: Buffer): string => buf.toString("base64url");
const fromB64url = (s: string): Buffer => Buffer.from(s, "base64url");

function sign(data: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(data).digest());
}

/** Mint a short-lived owner-bound join token. `ttlSeconds` defaults to 10 min (enough to copy the
 *  one-liner + start the container; the container exchanges it for a durable credential on
 *  connect). */
export function mintJoinToken(owner: string, secret: string, opts: { ttlSeconds?: number; now?: number } = {}): string {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const claims: JoinClaims = {
    owner,
    iat: now,
    exp: now + (opts.ttlSeconds ?? 600),
    nonce: randomUUID(),
    aud: AUDIENCE,
  };
  const encHeader = b64url(Buffer.from(JSON.stringify(header)));
  const encClaims = b64url(Buffer.from(JSON.stringify(claims)));
  const sig = sign(`${encHeader}.${encClaims}`, secret);
  return `${encHeader}.${encClaims}.${sig}`;
}

export type VerifyResult =
  | { ok: true; claims: JoinClaims }
  | { ok: false; reason: string };

/** Verify a join token: signature (constant-time), audience, and expiry. Returns the claims (with
 *  the owner) on success. Never throws. */
export function verifyJoinToken(token: string, secret: string, now: number = Math.floor(Date.now() / 1000)): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };
  const [encHeader, encClaims, sig] = parts;
  const expected = sign(`${encHeader}.${encClaims}`, secret);
  // Constant-time compare (equal-length base64url of a fixed-size HMAC).
  const a = fromB64url(sig);
  const b = fromB64url(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad signature" };

  let claims: JoinClaims;
  try {
    claims = JSON.parse(fromB64url(encClaims).toString("utf8")) as JoinClaims;
  } catch {
    return { ok: false, reason: "bad claims" };
  }
  if (claims.aud !== AUDIENCE) return { ok: false, reason: "wrong audience" };
  if (typeof claims.owner !== "string" || !claims.owner) return { ok: false, reason: "no owner" };
  if (typeof claims.exp !== "number" || claims.exp <= now) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}
