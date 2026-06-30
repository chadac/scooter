/**
 * Tier 1 contract test — the Sandbox/SA delete-error policy (findings #7/#8).
 *
 * destroy() must IGNORE a 404 (the object is already gone — the delete's goal)
 * but PROPAGATE every other delete error (403/409/5xx/timeout) — silently
 * swallowing those leaks the Sandbox CR + pod + workspace PVC (#7) or the
 * per-conversation ServiceAccount = the broker identity (#8).
 */

import { describe, it, expect } from "vitest";

import { ignoreDeleteNotFound } from "../../src/session/k8sProvisioner.js";

describe("ignoreDeleteNotFound (destroy delete-error policy)", () => {
  it("swallows a 404 (already gone)", () => {
    expect(() => ignoreDeleteNotFound({ code: 404 })).not.toThrow();
  });

  it("rethrows a 403 (forbidden — delete did NOT happen, would leak)", () => {
    expect(() => ignoreDeleteNotFound({ code: 403 })).toThrow();
  });

  it("rethrows a 500 / transient error", () => {
    expect(() => ignoreDeleteNotFound({ code: 500 })).toThrow();
  });

  it("rethrows an error with no code (network/timeout)", () => {
    expect(() => ignoreDeleteNotFound({} as { code?: number })).toThrow();
  });
});
