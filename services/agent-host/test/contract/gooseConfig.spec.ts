/**
 * Tier 1 contract test — ensureGooseConfig must FAIL LOUDLY on a real deployment.
 *
 * This file was written believing writeGooseConfig was the SOLE mechanism enabling
 * goose's developer extension. It is not, and never was for ACP sessions — goose
 * reads config.yaml only when no mcpServers are passed, and we always pass
 * scooter-env. The developer extension is enabled by `--with-builtin developer`
 * (see gooseAcpBuiltins.spec.ts, which is the real guard for that).
 *
 * What these cases still pin is the $HOME contract: goose keeps its session db and
 * state under $HOME, so an unset/unwritable $HOME must be FATAL on a real
 * deployment rather than a console.warn that still passes /healthz. On a fake/dev
 * sandbox it stays best-effort (no real goose).
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

  it("THROWS on a real deployment when home is missing (goose has nowhere for its session db)", () => {
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
