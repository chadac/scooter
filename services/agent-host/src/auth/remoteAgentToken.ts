/**
 * Join tokens for bring-your-own-Claude remote agents — a short-lived, owner-bound
 * token the UI mints and the /remote-agent/connect WS upgrade verifies offline. See
 * todo/docs/BYO_CLAUDE_REMOTE_AGENT.md §4.
 *
 * The HS256 mechanics moved to hs256.ts when conversation tokens (#700) needed the
 * same primitive — and needed it to be the ONLY copy, since the broker verifies that
 * token type in Python. What stays here is this token's semantics: the audience that
 * stops it being replayed as a conversation token, the owner binding, the nonce.
 */

import { randomUUID } from "node:crypto";

import { signHs256, verifyHs256 } from "./hs256.js";

const AUDIENCE = "remote-agent";

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

/** Mint a short-lived owner-bound join token. `ttlSeconds` defaults to 10 min (enough to copy the
 *  one-liner + start the container; the container exchanges it for a durable credential on
 *  connect). */
export function mintJoinToken(owner: string, secret: string, opts: { ttlSeconds?: number; now?: number } = {}): string {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const claims: JoinClaims = {
    owner,
    iat: now,
    exp: now + (opts.ttlSeconds ?? 600),
    nonce: randomUUID(),
    aud: AUDIENCE,
  };
  return signHs256(claims, secret);
}

export type VerifyResult =
  | { ok: true; claims: JoinClaims }
  | { ok: false; reason: string };

/** Verify a join token: signature (constant-time), audience, and expiry. Returns the claims (with
 *  the owner) on success. Never throws. */
export function verifyJoinToken(token: string, secret: string, now: number = Math.floor(Date.now() / 1000)): VerifyResult {
  const res = verifyHs256<JoinClaims>(token, secret);
  if (!res.ok) return res;
  const claims = res.claims;
  if (claims.aud !== AUDIENCE) return { ok: false, reason: "wrong audience" };
  if (typeof claims.owner !== "string" || !claims.owner) return { ok: false, reason: "no owner" };
  if (typeof claims.exp !== "number" || claims.exp <= now) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}
