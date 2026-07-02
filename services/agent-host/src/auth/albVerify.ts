/**
 * OPTIONAL AWS ALB OIDC JWT signature verification.
 *
 * The alb-oidc resolver (identity.ts) trust-DECODES the x-amzn-oidc-data JWT (the
 * ALB is the trust boundary). This adds cryptographic verification for deployments
 * that want it: extract the JWT's `kid`, fetch ALB's public key for that kid from
 * the regional endpoint, and verify the ES256 signature before the claims are
 * trusted. If verification FAILS, the email/name from the JWT are DROPPED (the
 * sub — which comes from a separate header, not the JWT — still identifies the
 * user; we just don't trust unverified claims).
 *
 * Async (a key fetch), so it's applied as a wrapper over the sync resolver at the
 * same seam as the identity store. Keys are cached by kid. Verification failures
 * and fetch errors degrade to "unverified → drop claims", never throw into the
 * request path.
 *
 * ALB public keys: https://public-keys.auth.elb.<region>.amazonaws.com/<kid>
 * (PEM, EC P-256). See the AWS ALB "authenticate-oidc" docs.
 */

import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { AsyncIdentityResolver, UserContext } from "./identity.js";

export interface AlbVerifyConfig {
  region: string;
  /** The data header to verify (default "x-amzn-oidc-data"). */
  dataHeader?: string;
  /** Injectable key fetcher (returns the PEM for a kid) — tests stub this. */
  fetchKey?: (kid: string, region: string) => Promise<string | undefined>;
}

/** Base64url-decode to a Buffer. */
function b64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Parse the JWT header (first segment) → its object. {} on failure. */
function jwtHeader(token: string): Record<string, unknown> {
  const seg = token.split(".")[0];
  if (!seg) return {};
  try {
    return JSON.parse(b64url(seg).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Default key fetcher: GET the regional ALB public-key endpoint (PEM). */
async function defaultFetchKey(kid: string, region: string): Promise<string | undefined> {
  const url = `https://public-keys.auth.elb.${region}.amazonaws.com/${encodeURIComponent(kid)}`;
  const res = await fetch(url);
  if (!res.ok) return undefined;
  return (await res.text()).trim();
}

/**
 * Verify an ALB OIDC JWT's ES256 signature against the key for its kid. Returns
 * true only on a valid signature. Any error (no kid, key fetch fails, bad
 * signature, malformed token) → false. `keyFor` supplies the PEM per kid.
 */
export async function verifyAlbJwt(
  token: string,
  keyFor: (kid: string) => Promise<string | undefined>,
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const kid = jwtHeader(token).kid;
  if (typeof kid !== "string" || !kid) return false;
  try {
    const pem = await keyFor(kid);
    if (!pem) return false;
    const key = createPublicKey(pem);
    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, "utf8");
    const signature = b64url(parts[2]);
    // ALB uses ES256; the JWS signature is the raw R||S (JOSE / IEEE-P1363), which
    // crypto.verify accepts with dsaEncoding "ieee-p1363" (no DER conversion).
    return cryptoVerify("sha256", signingInput, { key, dsaEncoding: "ieee-p1363" }, signature);
  } catch {
    return false;
  }
}

/** A kid→PEM cache over a fetcher (the ALB rotates keys rarely; cache is fine). */
export function createKeyCache(fetchKey: (kid: string, region: string) => Promise<string | undefined>, region: string) {
  const cache = new Map<string, string>();
  return async (kid: string): Promise<string | undefined> => {
    const hit = cache.get(kid);
    if (hit) return hit;
    const pem = await fetchKey(kid, region).catch(() => undefined);
    if (pem) cache.set(kid, pem);
    return pem;
  };
}

/**
 * Wrap an IdentityResolver so, when it produced identity from the ALB data JWT,
 * that JWT's signature is verified. On failure the claims (email/name) are
 * dropped but the sub-based id is kept. Anonymous / no-JWT requests pass through.
 */
export function withAlbVerification(
  resolver: AsyncIdentityResolver,
  config: AlbVerifyConfig,
): { resolve(req: IncomingMessage): Promise<UserContext> } {
  const dataHeader = (config.dataHeader ?? "x-amzn-oidc-data").toLowerCase();
  const keyFor = createKeyCache(config.fetchKey ?? defaultFetchKey, config.region);
  return {
    async resolve(req) {
      const user = await resolver.resolve(req);
      if (user.anonymous) return user;
      const raw = req.headers[dataHeader];
      const token = (Array.isArray(raw) ? raw[0] : raw)?.trim();
      // No JWT to verify (e.g. header-mode identity) → nothing to gate.
      if (!token) return user;
      const ok = await verifyAlbJwt(token, keyFor);
      if (ok) return user;
      // Unverified: keep the id (from the separate identity header), drop claims.
      // eslint-disable-next-line no-console
      console.warn("[albVerify] x-amzn-oidc-data signature did NOT verify — dropping unverified claims");
      return { id: user.id, anonymous: false };
    },
  };
}
