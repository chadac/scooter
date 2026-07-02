/**
 * User identity from a trusted ingress — PROVIDER-AGNOSTIC.
 *
 * The agent-host does NOT do login/OIDC/sessions itself. It trusts that the
 * ingress (Traefik / basic-auth / a forward-auth or oauth2-proxy / an ALB with
 * OIDC / …) authenticates the user and hands us the identity. Different ingresses
 * expose identity differently, so this is pluggable: an `IdentityResolver` reads
 * one request and returns a UserContext. `header` (x-auth-user/x-auth-email) is
 * the default and covers most proxies; `alb-oidc` reads AWS ALB's OIDC headers.
 * More can be added without touching callers.
 *
 * A missing/empty identity is the single `anonymous` user (preserves single-user
 * / local-dev behavior).
 *
 * SECURITY: identity is trusted because the ingress is the trust boundary. The
 * agent-host must not be exposed without an ingress that SETS (and strips any
 * client-supplied) identity headers — else a caller can spoof identity. (The ALB
 * resolver DECODES but does not yet verify the ALB JWT signature; same
 * trust-the-ingress model as the header resolver.)
 *
 * Identity is used for conversation OWNERSHIP (a view filter), NOT access control.
 */

import type { IncomingMessage } from "node:http";

export interface UserContext {
  /** Stable user id: the header value, or the OIDC `sub`, or "anonymous". */
  id: string;
  /** Email, when the ingress provides one (directly or via a decoded token). */
  email?: string;
  /** Display name, when available (e.g. an OIDC `name` claim). */
  name?: string;
  /** True when no identity was present. */
  anonymous: boolean;
}

export const ANONYMOUS_USER = "anonymous";

/** Resolve identity from ONE request. Sync (header/JWT parse only); any DB-backed
 *  enrichment / signature verification is layered on top via async wrappers
 *  (identityStore.ts, albVerify.ts). */
export interface IdentityResolver {
  resolve(req: IncomingMessage): UserContext;
}

/** A resolver that MAY be async (a wrapper doing a DB lookup or key fetch). Both
 *  the base sync resolvers and the async wrappers satisfy this, so wrappers can
 *  compose over each other. */
export interface AsyncIdentityResolver {
  resolve(req: IncomingMessage): UserContext | Promise<UserContext>;
}

// --- header helpers --------------------------------------------------------

/** A single header value (node lowercases header NAMES; values may be string[]). */
function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  const s = (Array.isArray(v) ? v[0] : v)?.trim();
  return s ? s : undefined;
}

// --- header resolver (default; Traefik / basic / forward-auth / oauth2-proxy) --

export interface HeaderIdentityConfig {
  /** Header carrying the user id (default "x-auth-user"). */
  userHeader: string;
  /** Header carrying the user email (default "x-auth-email"). */
  emailHeader: string;
}

export function createHeaderResolver(config: HeaderIdentityConfig): IdentityResolver {
  return {
    resolve(req) {
      const id = header(req, config.userHeader);
      if (!id) return { id: ANONYMOUS_USER, anonymous: true };
      return { id, email: header(req, config.emailHeader), anonymous: false };
    },
  };
}

// --- ALB OIDC resolver -----------------------------------------------------

/** Decode a JWT's payload WITHOUT verifying the signature. The ALB is the trust
 *  boundary (it sets the header and strips client-supplied copies), so we trust
 *  its token the same way we trust x-auth-* headers. Returns {} on any parse
 *  failure (a malformed token → no email, not a crash). */
export function decodeJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2) return {};
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(payload, "base64").toString("utf8");
    const claims = JSON.parse(json);
    return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface AlbOidcConfig {
  /** Header carrying the OIDC subject (default "x-amzn-oidc-identity"). */
  identityHeader: string;
  /** Header carrying the signed OIDC claims JWT (default "x-amzn-oidc-data"). */
  dataHeader: string;
}

/**
 * AWS ALB with OIDC auth: the `sub` arrives in x-amzn-oidc-identity, but the email
 * is inside the SIGNED x-amzn-oidc-data JWT (not a plain header). Use the sub as
 * the stable id and pull email/name from the JWT claims. The email may be filled
 * in later from the identity store when a claim is absent.
 */
export function createAlbOidcResolver(config: AlbOidcConfig): IdentityResolver {
  return {
    resolve(req) {
      const sub = header(req, config.identityHeader);
      if (!sub) return { id: ANONYMOUS_USER, anonymous: true };
      const data = header(req, config.dataHeader);
      const claims = data ? decodeJwtClaims(data) : {};
      const email = typeof claims.email === "string" ? claims.email : undefined;
      const name = typeof claims.name === "string" ? claims.name : undefined;
      return { id: sub, email, name, anonymous: false };
    },
  };
}

// --- selection from env ----------------------------------------------------

export type AuthMode = "header" | "alb-oidc";

/** Build the configured resolver. AUTH_MODE selects the provider (default
 *  "header"); header names stay overridable so a proxy can use custom names. */
export function resolverFromEnv(): IdentityResolver {
  const mode = (process.env.AUTH_MODE || "header").toLowerCase() as AuthMode;
  if (mode === "alb-oidc") {
    return createAlbOidcResolver({
      identityHeader: process.env.AUTH_ALB_IDENTITY_HEADER || "x-amzn-oidc-identity",
      dataHeader: process.env.AUTH_ALB_DATA_HEADER || "x-amzn-oidc-data",
    });
  }
  return createHeaderResolver({
    userHeader: process.env.AUTH_USER_HEADER || "x-auth-user",
    emailHeader: process.env.AUTH_EMAIL_HEADER || "x-auth-email",
  });
}

// --- back-compat -----------------------------------------------------------
// The original synchronous header parse, kept so existing call sites / tests keep
// working while the router migrates to the resolver + store.
export type IdentityConfig = HeaderIdentityConfig;

export function identityConfigFromEnv(): IdentityConfig {
  return {
    userHeader: (process.env.AUTH_USER_HEADER || "x-auth-user").toLowerCase(),
    emailHeader: (process.env.AUTH_EMAIL_HEADER || "x-auth-email").toLowerCase(),
  };
}

export function userFromRequest(req: IncomingMessage, config: IdentityConfig): UserContext {
  return createHeaderResolver(config).resolve(req);
}
