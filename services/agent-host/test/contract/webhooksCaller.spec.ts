/**
 * Tier 1 contract — the trusted-caller verifier (webhooksCaller). Honors a request
 * only when its Bearer SA token authenticates (via TokenReview) as the configured
 * webhooks ServiceAccount. See auth/webhooksCaller.ts.
 */

import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage } from "node:http";

import { createWebhooksCallerVerifier } from "../../src/auth/webhooksCaller.js";

const SA = "system:serviceaccount:agent-sandbox:agent-webhooks";

function req(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("createWebhooksCallerVerifier", () => {
  it("trusts a Bearer token that authenticates as the expected webhooks SA", async () => {
    const reviewToken = vi.fn(async () => ({ authenticated: true, username: SA }));
    const verify = createWebhooksCallerVerifier({ expectedServiceAccount: SA, audience: "agent-host", reviewToken });
    expect(await verify(req({ authorization: "Bearer good-token" }))).toBe(true);
    expect(reviewToken).toHaveBeenCalledWith("good-token", "agent-host");
  });

  it("REJECTS a token that authenticates as a DIFFERENT SA", async () => {
    const reviewToken = vi.fn(async () => ({ authenticated: true, username: "system:serviceaccount:agent-sandbox:someone-else" }));
    const verify = createWebhooksCallerVerifier({ expectedServiceAccount: SA, reviewToken });
    expect(await verify(req({ authorization: "Bearer other" }))).toBe(false);
  });

  it("trusts ANY of a comma-separated SA list (webhooks + scheduler)", async () => {
    const SCHED = "system:serviceaccount:agent-sandbox:agent-scheduler";
    const verifyWebhooks = createWebhooksCallerVerifier({
      expectedServiceAccount: `${SA},${SCHED}`,
      reviewToken: vi.fn(async () => ({ authenticated: true, username: SA })),
    });
    const verifyScheduler = createWebhooksCallerVerifier({
      expectedServiceAccount: `${SA},${SCHED}`,
      reviewToken: vi.fn(async () => ({ authenticated: true, username: SCHED })),
    });
    const verifyStranger = createWebhooksCallerVerifier({
      expectedServiceAccount: `${SA},${SCHED}`,
      reviewToken: vi.fn(async () => ({ authenticated: true, username: "system:serviceaccount:agent-sandbox:nope" })),
    });
    expect(await verifyWebhooks(req({ authorization: "Bearer a" }))).toBe(true);
    expect(await verifyScheduler(req({ authorization: "Bearer b" }))).toBe(true);
    expect(await verifyStranger(req({ authorization: "Bearer c" }))).toBe(false);
  });

  it("REJECTS an unauthenticated token", async () => {
    const reviewToken = vi.fn(async () => ({ authenticated: false }));
    const verify = createWebhooksCallerVerifier({ expectedServiceAccount: SA, reviewToken });
    expect(await verify(req({ authorization: "Bearer bad" }))).toBe(false);
  });

  it("REJECTS a request with no Bearer token (never calls TokenReview)", async () => {
    const reviewToken = vi.fn(async () => ({ authenticated: true, username: SA }));
    const verify = createWebhooksCallerVerifier({ expectedServiceAccount: SA, reviewToken });
    expect(await verify(req())).toBe(false);
    expect(await verify(req({ authorization: "Basic x" }))).toBe(false);
    expect(reviewToken).not.toHaveBeenCalled();
  });

  it("treats a TokenReview error as untrusted (owner ignored, never throws)", async () => {
    const reviewToken = vi.fn(async () => { throw new Error("apiserver down"); });
    const verify = createWebhooksCallerVerifier({ expectedServiceAccount: SA, reviewToken });
    expect(await verify(req({ authorization: "Bearer x" }))).toBe(false);
  });

  it("is DISABLED (always false) when no expected SA is configured", async () => {
    const reviewToken = vi.fn(async () => ({ authenticated: true, username: SA }));
    const verify = createWebhooksCallerVerifier({ expectedServiceAccount: "", reviewToken });
    expect(await verify(req({ authorization: "Bearer good-token" }))).toBe(false);
    expect(reviewToken).not.toHaveBeenCalled();
  });
});
