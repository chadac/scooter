/**
 * The AGENT and the SANDBOX are separate choices.
 *
 * Regression guard: `fakeSandbox` used to be `FAKE_SANDBOX === "1" || useFakeAgent`, so
 * setting GOOSE_BIN=fake — which the k3d platform does deliberately, to get a
 * deterministic agent with no model key — ALSO selected createNoopProvisioner(). No
 * Sandbox CR, no sandbox pod, nothing logged, and every turn hung to the 60s timeout.
 * The cluster tier's headline story ("a tool call runs in a real sandbox") could not
 * pass by construction.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { configFromEnv } from "../../src/index.js";

const KEYS = ["GOOSE_BIN", "FAKE_SANDBOX", "KUBERNETES_SERVICE_HOST"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("fakeSandbox is independent of the fake AGENT", () => {
  it("IN-CLUSTER: the fake agent runs against a REAL sandbox", () => {
    // THE BUG. This is the k3d platform's exact configuration.
    process.env.GOOSE_BIN = "fake";
    process.env.KUBERNETES_SERVICE_HOST = "10.43.0.1";
    expect(configFromEnv().fakeSandbox).toBe(false);
  });

  it("OUT of a cluster: the fake agent still implies a fake sandbox", () => {
    // The local Tier-3 stack has no k8s at all — it must keep working untouched.
    process.env.GOOSE_BIN = "fake";
    expect(configFromEnv().fakeSandbox).toBe(true);
  });

  it("FAKE_SANDBOX=1 forces a fake sandbox anywhere, cluster or not", () => {
    process.env.FAKE_SANDBOX = "1";
    process.env.KUBERNETES_SERVICE_HOST = "10.43.0.1";
    expect(configFromEnv().fakeSandbox).toBe(true);
  });

  it("a REAL agent in a cluster gets a real sandbox", () => {
    process.env.KUBERNETES_SERVICE_HOST = "10.43.0.1";
    expect(configFromEnv().fakeSandbox).toBe(false);
  });
});
