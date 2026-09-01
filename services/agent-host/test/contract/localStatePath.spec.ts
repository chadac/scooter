/**
 * Tier 1 — the LOCAL_STATE_PATH rename and its back-compat window.
 *
 * WHY THIS EXISTS. `STATE_PATH` was a lie with consequences. It reads as *the* state, its config
 * doc claimed "Durable conversation state ... On a PVC so it survives agent-host restarts", and
 * index.ts called it the "hot-path authority" — while the deployed volume is an **emptyDir**. The
 * code followed the name: hydrate() reads this store to answer "which conversations exist?", which
 * it cannot answer after a restart. Every pod therefore booted with zero conversations, so
 * sweepIdle() iterated an empty map and reclaimed nothing, forever — 21 sandboxes holding 42
 * requested cores on a 24-core node, deadlocking every rollout. See
 * docs/CONVERSATION_STATE_MODEL.md.
 *
 * The rename is the cheap half of the fix: with `STATE_PATH`, hydrate() reading local state looks
 * correct; as `LOCAL_STATE_PATH` the same line reads as obviously wrong. These tests pin the new
 * name AND the transitional fallback, because dropping the old one outright would break any pod
 * whose manifest predates the rollout.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { configFromEnv } from "../../src/index.js";

const KEYS = ["LOCAL_STATE_PATH", "STATE_PATH", "MIRROR_STATE_PATH"] as const;

describe("LOCAL_STATE_PATH", () => {
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

  it("reads LOCAL_STATE_PATH", () => {
    process.env.LOCAL_STATE_PATH = "/tmp/local-cache";
    expect(configFromEnv().localStatePath).toBe("/tmp/local-cache");
  });

  it("still honors the old STATE_PATH so a pre-rename manifest keeps working", () => {
    // A rollout replaces pods one at a time: an old manifest can still be setting STATE_PATH when
    // the new image starts. Ignoring it would silently relocate the store mid-rollout.
    process.env.STATE_PATH = "/tmp/legacy";
    expect(configFromEnv().localStatePath).toBe("/tmp/legacy");
  });

  it("prefers LOCAL_STATE_PATH when BOTH are set (the new name wins)", () => {
    process.env.LOCAL_STATE_PATH = "/tmp/new";
    process.env.STATE_PATH = "/tmp/old";
    expect(configFromEnv().localStatePath).toBe("/tmp/new");
  });


  it("falls back to a default when neither is set (dev/local)", () => {
    expect(configFromEnv().localStatePath).toMatch(/\S/);
  });
});
