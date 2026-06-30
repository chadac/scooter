/**
 * Tier 1 contract test — ensureGooseConfig must FAIL LOUDLY on a real deployment.
 *
 * Audit finding #1 (HIGH): writeGooseConfig is the SOLE mechanism enabling goose's
 * developer extension, which is what redirects shell/file tool calls to the
 * sandbox. If the write fails (or $HOME is unset) and we proceed, goose runs the
 * agent's tools LOCALLY in the agent-host pod — a silent isolation breach that
 * still passes /healthz. So on a real deployment the failure must be FATAL, not a
 * console.warn. On a fake/dev sandbox it stays best-effort (no real goose).
 *
 * RED until ensureGooseConfig throws instead of swallowing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureGooseConfig } from "../../src/agent/gooseConfig.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "goose-home-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("ensureGooseConfig", () => {
  it("writes the developer-enabled config under $HOME/.config/goose", () => {
    ensureGooseConfig(home, { fatal: true });
    const yaml = readFileSync(join(home, ".config", "goose", "config.yaml"), "utf8");
    expect(yaml).toContain("developer:");
    expect(yaml).toContain("enabled: true");
  });

  it("THROWS on a real deployment (fatal) when the config dir cannot be written", () => {
    // Make $HOME/.config a FILE so mkdir/write of .config/goose fails (ENOTDIR).
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".config"), "not a dir", "utf8");
    expect(() => ensureGooseConfig(home, { fatal: true })).toThrow();
  });

  it("THROWS on a real deployment when home is missing (would silently mis-isolate)", () => {
    expect(() => ensureGooseConfig(undefined, { fatal: true })).toThrow(/HOME/i);
  });

  it("does NOT throw on a fake/dev sandbox (best-effort) even when the write fails", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".config"), "not a dir", "utf8");
    expect(() => ensureGooseConfig(home, { fatal: false })).not.toThrow();
    // ...and a missing home is a no-op, not a throw, when non-fatal.
    expect(() => ensureGooseConfig(undefined, { fatal: false })).not.toThrow();
  });
});
