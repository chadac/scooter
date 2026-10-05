/**
 * Conversation tokens — the platform primitive that says "this caller is acting for
 * conversation X", minted by the agent-host and verified by BOTH MCP servers (the
 * agent-host's own `scooter-control` endpoint, and the broker's `scooter-broker`).
 *
 * WHAT IT REPLACES. The MCP endpoint used to take the conversation from a `?conv=`
 * query param on a route with no caller authentication of its own, so anything that
 * could reach the agent-host's port could name any conversation and get that
 * conversation's sandbox exec, subagents and scheduled tasks. The id now comes only
 * from a signed token. See issue #700.
 *
 * WHY HS256 AND NOT ED25519/JWKS. The asymmetric version protects against an
 * attacker who can read the broker's signing key but cannot otherwise act as the
 * broker — a scenario that does not exist here, because the broker already holds
 * every integration credential these tools wrap, and nothing else verifies these
 * tokens. One mounted Secret, no JWKS endpoint, no fetch-and-cache. If a third
 * verifier ever appears, swapping in Ed25519 is a change to sign + verify with the
 * claim set untouched.
 *
 * TTL, AND WHY IT IS LONG. On the broker path the token never travels alone: the
 * broker also requires a projected ServiceAccount token from an allowlisted caller,
 * and kubelet rotation makes THAT the freshness guarantee — a stolen conversation
 * token alone buys nothing there. On the agent-host path it does stand alone, which
 * is what bounds the TTL rather than removing it. The default is days, not minutes,
 * because the token is handed to the agent at session creation and an agent session
 * outlives any short expiry; a token that expires mid-conversation surfaces as tools
 * that mysteriously start failing.
 *
 * DO NOT PUT A MINTED TOKEN IN A SESSION FINGERPRINT. `iat` differs on every mint,
 * so fingerprinting header VALUES would make every re-mint look like a changed
 * offered-server set and rebuild the agent session in a loop. mcpServerRegistry's
 * fingerprintOffered covers header NAMES for this reason.
 */

import { signHs256, verifyHs256 } from "./hs256.js";

/** Audience. Pinned so a BYOC join token (aud "remote-agent") can never be replayed
 *  as a conversation token, and vice versa. */
export const CONV_TOKEN_AUDIENCE = "scooter-mcp";

/** Issuer, carried so the broker can say WHICH component vouched for the id. */
export const CONV_TOKEN_ISSUER = "scooter-agent-host";

/** 7 days. See the TTL note above; override with CONV_TOKEN_TTL_SECONDS. */
export const DEFAULT_CONV_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface ConvClaims {
  /** Audience — always CONV_TOKEN_AUDIENCE. */
  aud: string;
  /** Issuer — always CONV_TOKEN_ISSUER. */
  iss: string;
  /** The conversation this caller may act for. THE claim; everything else is context. */
  sub: string;
  /** The Scooter user who owns the conversation, when known. Carried so a tool can
   *  scope by owner (the scheduler already does) without a lookup. */
  owner?: string;
  /** Seconds-since-epoch expiry. */
  exp: number;
  /** Issued-at (seconds). */
  iat: number;
}

/** Mint a token binding the bearer to one conversation. */
export function mintConvToken(
  conversationId: string,
  secret: string,
  opts: { owner?: string; ttlSeconds?: number; now?: number } = {},
): string {
  if (!conversationId) throw new Error("mintConvToken: conversationId is required");
  if (!secret) throw new Error("mintConvToken: secret is required");
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const claims: ConvClaims = {
    aud: CONV_TOKEN_AUDIENCE,
    iss: CONV_TOKEN_ISSUER,
    sub: conversationId,
    iat: now,
    exp: now + (opts.ttlSeconds ?? DEFAULT_CONV_TOKEN_TTL_SECONDS),
    ...(opts.owner ? { owner: opts.owner } : {}),
  };
  return signHs256(claims, secret);
}

export type ConvTokenResult =
  | { ok: true; conversationId: string; owner?: string }
  | { ok: false; reason: string };

/**
 * Verify a conversation token: signature, audience, issuer, expiry, and a non-empty
 * subject. Returns the conversation id. Never throws — a bad token is a 401/403, not
 * a 500.
 */
export function verifyConvToken(
  token: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): ConvTokenResult {
  if (!secret) return { ok: false, reason: "no conversation-token secret configured" };
  const res = verifyHs256<ConvClaims>(token, secret);
  if (!res.ok) return res;
  const c = res.claims;
  if (c.aud !== CONV_TOKEN_AUDIENCE) return { ok: false, reason: "wrong audience" };
  if (c.iss !== CONV_TOKEN_ISSUER) return { ok: false, reason: "wrong issuer" };
  if (typeof c.sub !== "string" || !c.sub) return { ok: false, reason: "no conversation" };
  if (typeof c.exp !== "number" || c.exp <= now) return { ok: false, reason: "expired" };
  return { ok: true, conversationId: c.sub, ...(c.owner ? { owner: c.owner } : {}) };
}

/** Read a Bearer token out of an Authorization header value. The conversation token
 *  travels in a HEADER, never the URL: an MCP endpoint URL is logged by the agent, the
 *  proxy and the access log, and a credential in a query string ends up in all three. */
export function bearerFrom(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const m = /^bearer\s+(.+)$/i.exec(authorization.trim());
  return m ? m[1].trim() : undefined;
}
