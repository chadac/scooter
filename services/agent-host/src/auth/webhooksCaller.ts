/**
 * Trusted-caller verification for the webhooks service.
 *
 * The conversation `owner` on POST /agui (a webhook-resolved Scooter user) is a
 * PRIVILEGED field — if any caller could set it, a user could claim someone else's
 * conversation. So the agent-host honors `owner` ONLY when the request presents a
 * valid **webhooks ServiceAccount token**, cryptographically verified via k8s
 * TokenReview (NOT a header the ingress is merely trusted to strip — that was
 * spoofable). Mirrors the broker's SA-token auth (services/broker/broker/core/auth.py).
 *
 * A `Bearer <token>` that authenticates as `system:serviceaccount:<ns>:<sa>` (the
 * configured webhooks SA) → trusted. Anything else (no token, invalid token, a
 * valid-but-different SA, TokenReview unreachable) → NOT trusted → `owner` ignored,
 * the conversation stays unowned (never blocks the run).
 */

import { KubeConfig, AuthenticationV1Api } from "@kubernetes/client-node";
import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";

/** Verifies whether a request is the trusted webhooks caller. */
export type WebhooksCallerVerifier = (req: IncomingMessage) => Promise<boolean>;

export interface WebhooksVerifierConfig {
  /** The expected SA username, e.g. `system:serviceaccount:agent-sandbox:agent-webhooks`.
   *  Empty/undefined → verification is DISABLED (always false — owner never honored;
   *  the safe default when the trust chain isn't configured). */
  expectedServiceAccount?: string;
  /** The token audience the webhooks SA token is projected for (must match). */
  audience?: string;
  /** Injectable TokenReview (tests). Default hits the real k8s API. */
  reviewToken?: (token: string, audience?: string) => Promise<{ authenticated: boolean; username?: string }>;
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers["authorization"];
  const v = Array.isArray(h) ? h[0] : h;
  if (!v || !/^bearer /i.test(v)) return undefined;
  return v.slice(7).trim() || undefined;
}

function defaultReviewToken(): (token: string, audience?: string) => Promise<{ authenticated: boolean; username?: string }> {
  let api: AuthenticationV1Api | undefined;
  const client = (): AuthenticationV1Api => {
    if (!api) {
      const kc = new KubeConfig();
      if (existsSync("/var/run/secrets/kubernetes.io/serviceaccount/token")) kc.loadFromCluster();
      else kc.loadFromDefault();
      api = kc.makeApiClient(AuthenticationV1Api);
    }
    return api;
  };
  return async (token, audience) => {
    const res = await client().createTokenReview({
      body: {
        apiVersion: "authentication.k8s.io/v1",
        kind: "TokenReview",
        spec: { token, ...(audience ? { audiences: [audience] } : {}) },
      },
    });
    const status = res.status;
    return { authenticated: status?.authenticated === true, username: status?.user?.username };
  };
}

/**
 * Build a verifier. When `expectedServiceAccount` is empty, returns a verifier that
 * always says "not trusted" (owner is never honored — the safe default until the
 * SA-token trust chain is wired). Otherwise verifies the request's Bearer token via
 * TokenReview and checks the SA username matches.
 */
export function createWebhooksCallerVerifier(config: WebhooksVerifierConfig): WebhooksCallerVerifier {
  const expected = config.expectedServiceAccount?.trim();
  if (!expected) return async () => false;
  const review = config.reviewToken ?? defaultReviewToken();
  return async (req) => {
    const token = bearer(req);
    if (!token) return false;
    try {
      const { authenticated, username } = await review(token, config.audience);
      return authenticated && username === expected;
    } catch {
      // TokenReview unreachable / RBAC missing → treat as untrusted (owner ignored).
      return false;
    }
  };
}
