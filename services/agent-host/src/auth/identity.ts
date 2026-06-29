/**
 * User identity from a trusted ingress header.
 *
 * The agent-host does NOT do login/OIDC/sessions — it trusts that the ingress
 * (an OIDC proxy / basic-auth / forward-auth the deployer wires up) authenticates
 * the user and injects an identity header. We read that header. A missing header
 * is the single `anonymous` user (preserves single-user / local-dev behavior).
 *
 * SECURITY: the header is trusted because the ingress is the trust boundary. The
 * agent-host must not be exposed without an ingress that SETS (and strips any
 * client-supplied) identity header — otherwise a caller can spoof identity.
 *
 * Identity is used for conversation OWNERSHIP (a view filter: "my conversations"
 * vs "all"), NOT as an access-control boundary — conversations are public.
 */

import type { IncomingMessage } from "node:http";

export interface UserContext {
  /** Stable user id (the header value), or "anonymous" when no header is present. */
  id: string;
  /** Optional email, if the ingress also injects one. */
  email?: string;
  /** True when no identity header was present. */
  anonymous: boolean;
}

export const ANONYMOUS_USER = "anonymous";

export interface IdentityConfig {
  /** Header carrying the user id (default "x-auth-user"). */
  userHeader: string;
  /** Header carrying the user email (default "x-auth-email"). */
  emailHeader: string;
}

export function identityConfigFromEnv(): IdentityConfig {
  return {
    userHeader: (process.env.AUTH_USER_HEADER || "x-auth-user").toLowerCase(),
    emailHeader: (process.env.AUTH_EMAIL_HEADER || "x-auth-email").toLowerCase(),
  };
}

/** A single header value (node lowercases header NAMES; values may be string[]). */
function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  const s = (Array.isArray(v) ? v[0] : v)?.trim();
  return s ? s : undefined;
}

/** Extract the UserContext from a request's identity headers. */
export function userFromRequest(req: IncomingMessage, config: IdentityConfig): UserContext {
  const id = header(req, config.userHeader);
  if (!id) return { id: ANONYMOUS_USER, anonymous: true };
  return { id, email: header(req, config.emailHeader), anonymous: false };
}
