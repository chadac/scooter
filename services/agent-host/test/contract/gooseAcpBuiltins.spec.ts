/**
 * `goose acp` must be launched with `--with-builtin developer`.
 *
 * Without the flag the agent has NO shell/read/write/edit tools at all — only the
 * scooter-env MCP tools — because goose's ACP entrypoint takes its builtin set
 * ONLY from the flag:
 *
 *   1. `Command::Acp { builtins }` -> `acp::server::run` builds
 *      `AcpBuiltinSelection { explicit: builtins, ..Default::default() }`, so
 *      `defaults` is EMPTY. (`goose serve` falls back to `defaults: ["developer"]`;
 *      `goose acp` deliberately does not — an upstream asymmetry.)
 *   2. `initial_session_extensions` consults config.yaml only in its
 *      `mcp_servers.is_empty()` branch. agent-host ALWAYS passes scooter-env, so
 *      config.yaml is never read and writeGooseConfig cannot enable developer.
 *   3. `apply_acp_extension_overrides` early-returns unless
 *      `is_extension_enabled("developer")`, so AcpTools never replaces the
 *      developer client and the sandbox-routed tools never appear.
 *
 * Verified against goose v1.47.0. This flag is therefore the SOLE mechanism
 * giving the agent a shell; a bare `["acp"]` is a silent, total tool loss.
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
