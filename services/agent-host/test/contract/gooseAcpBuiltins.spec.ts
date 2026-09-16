/**
 * `goose acp` must be launched with `--with-builtin developer` — without it the
 * agent has NO shell/read/write/edit tools at all (config.yaml cannot substitute,
 * since we always pass mcpServers). Verified on goose v1.47.0; details in PR #524.
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

describe("real goose is launched with the developer builtin", () => {
  it("passes --with-builtin developer", () => {
    process.env.KUBERNETES_SERVICE_HOST = "10.43.0.1";
    const { agent } = configFromEnv();
    expect(agent.args).toEqual(["acp", "--with-builtin", "developer"]);
  });

  it("keeps the flag when GOOSE_BIN points at a custom binary", () => {
    process.env.KUBERNETES_SERVICE_HOST = "10.43.0.1";
    process.env.GOOSE_BIN = "/nix/store/xxx/bin/goose";
    const { agent } = configFromEnv();
    expect(agent.command).toBe("/nix/store/xxx/bin/goose");
    expect(agent.args).toContain("--with-builtin");
  });

  it("does NOT pass goose flags to the fake agent", () => {
    process.env.GOOSE_BIN = "fake";
    const { agent } = configFromEnv();
    expect(agent.args).not.toContain("--with-builtin");
  });
});
