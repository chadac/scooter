/**
 * Tier 1 contract — McpServerRegistry over a fake exec client, and the pure
 * resolver that turns its descriptors into `new_session` mcpServers entries.
 *
 * The registry reads the in-pod discovery manifest the `mcpServers` NixOS option
 * renders (see modules/sandbox-os/mcp-servers.nix) and drives the units through
 * `scooter-mcp`, which persists autostart intent for boot restore. Shaped after
 * WebServiceRegistry — the differences it encodes are what this asserts:
 *   - a server that is not RUNNING is not offered (a dead entry poisons newSession);
 *   - the offered set has a FINGERPRINT, so the bridge can tell when to rebuild.
 * See issue #520.
 */

import { describe, it, expect, vi } from "vitest";

import {
  createMcpServerRegistry,
  parseMcpManifest,
  offeredMcpServers,
  fingerprintOffered,
  MCP_MANIFEST_PATH,
  type ExecLike,
  type McpServerDescriptor,
} from "../../src/agent/mcpServerRegistry.js";
import type { SandboxRef } from "../../src/types.js";

const REF: SandboxRef = { name: "conv-1", namespace: "agent-sandbox" };

const entry = (over: Partial<McpServerDescriptor> = {}) => ({
  name: "alpha",
  displayName: "Alpha",
  description: "an alpha server",
  port: 9700,
  path: "/mcp",
  unit: "mcp-alpha",
  autoStart: true,
  listenAddress: "127.0.0.1",
  ...over,
});

const manifestOf = (...servers: Partial<McpServerDescriptor>[]) =>
  JSON.stringify({ servers: servers.map((s) => entry(s)) });

const MANIFEST = manifestOf({});

function fakeExec(over: Partial<ExecLike> = {}): ExecLike {
  return {
    download: vi.fn(async (p: string) => (p === MCP_MANIFEST_PATH ? MANIFEST : "")),
    execute: vi.fn(async () => ({ stdout: "active", stderr: "", exitCode: 0 })),
    ...over,
  };
}

function make(exec: ExecLike, opts?: { ttlMs?: number; now?: () => number }) {
  return createMcpServerRegistry({ sandboxFor: () => REF, connect: async () => exec }, opts);
}

describe("parseMcpManifest", () => {
  it("reads the servers the NixOS option renders", () => {
    const got = parseMcpManifest(MANIFEST);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ name: "alpha", port: 9700, path: "/mcp", unit: "mcp-alpha" });
  });

  it("tolerates a missing or garbage manifest rather than throwing", () => {
    // The pod may be ContainerCreating or asleep; a throw here would take down the
    // run that merely wanted to know what servers exist.
    expect(parseMcpManifest("")).toEqual([]);
    expect(parseMcpManifest("not json")).toEqual([]);
    expect(parseMcpManifest("{}")).toEqual([]);
    expect(parseMcpManifest(JSON.stringify({ servers: "nope" }))).toEqual([]);
  });

  it("drops entries missing the fields the transport needs", () => {
    const bad = JSON.stringify({ servers: [{ name: "x" }, { port: 1 }, entry({ name: "ok" })] });
    expect(parseMcpManifest(bad).map((s) => s.name)).toEqual(["ok"]);
  });

  it("defaults the optional fields so a sparse manifest still works", () => {
    const sparse = JSON.stringify({ servers: [{ name: "x", port: 9700 }] });
    expect(parseMcpManifest(sparse)[0]).toMatchObject({
      name: "x",
      port: 9700,
      path: "/mcp",
      unit: "mcp-x",
    });
  });
});

describe("McpServerRegistry", () => {
  it("lists the declared servers", async () => {
    const reg = make(fakeExec());
    expect((await reg.list("conv-1")).map((s) => s.name)).toEqual(["alpha"]);
  });

  it("does not cache an EMPTY read, so a slow pod is retried", async () => {
    // Same trap WebServiceRegistry hit: the pod is still ContainerCreating, the
    // download throws, and caching that [] makes the conversation believe forever
    // that it has no MCP servers.
    let manifest = "";
    const exec = fakeExec({ download: vi.fn(async () => manifest) });
    const reg = make(exec);
    expect(await reg.list("conv-1")).toEqual([]);
    manifest = MANIFEST;
    expect((await reg.list("conv-1")).map((s) => s.name)).toEqual(["alpha"]);
  });

  it("serves a non-empty list from cache until the TTL expires", async () => {
    let now = 1000;
    const exec = fakeExec();
    const reg = make(exec, { ttlMs: 100, now: () => now });
    await reg.list("conv-1");
    await reg.list("conv-1");
    expect(exec.download).toHaveBeenCalledTimes(1);
    now += 200;
    await reg.list("conv-1");
    expect(exec.download).toHaveBeenCalledTimes(2);
  });

  it("re-reads on force, so a rebuild's new server appears at once", async () => {
    const exec = fakeExec();
    const reg = make(exec);
    await reg.list("conv-1");
    await reg.list("conv-1", { force: true });
    expect(exec.download).toHaveBeenCalledTimes(2);
  });

  it("reports a running server from `systemctl is-active`", async () => {
    const reg = make(fakeExec());
    expect(await reg.isRunning("conv-1", "alpha")).toBe(true);
  });

  it("reports a stopped server as not running", async () => {
    const exec = fakeExec({
      execute: vi.fn(async () => ({ stdout: "inactive", stderr: "", exitCode: 3 })),
    });
    expect(await make(exec).isRunning("conv-1", "alpha")).toBe(false);
  });

  it("starts a stopped server through scooter-mcp, not raw systemctl", async () => {
    // Via the CLI so the autostart intent is persisted to the workspace PVC — that
    // is what brings the server back after a suspend/resume pod recreate.
    const calls: string[][] = [];
    const exec = fakeExec({
      execute: vi.fn(async (req: { command: string; args?: string[] }) => {
        calls.push([req.command, ...(req.args ?? [])]);
        if (req.command === "systemctl") return { stdout: "inactive", stderr: "", exitCode: 3 };
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    });
    const reg = make(exec);
    await reg.ensureStarted("conv-1", "alpha");
    expect(calls.some((c) => c[0] === "scooter-mcp" && c[1] === "start" && c[2] === "alpha")).toBe(true);
  });

  it("does not restart a server that is already running", async () => {
    const calls: string[][] = [];
    const exec = fakeExec({
      execute: vi.fn(async (req: { command: string; args?: string[] }) => {
        calls.push([req.command, ...(req.args ?? [])]);
        return { stdout: "active", stderr: "", exitCode: 0 };
      }),
    });
    await make(exec).ensureStarted("conv-1", "alpha");
    expect(calls.some((c) => c[0] === "scooter-mcp")).toBe(false);
  });

  it("reports an unknown server rather than pretending it started", async () => {
    const reg = make(fakeExec());
    await expect(reg.ensureStarted("conv-1", "nope")).resolves.toBe(false);
  });
});

describe("offeredMcpServers", () => {
  const urlFor = (d: McpServerDescriptor) => `http://127.0.0.1:${d.port}${d.path}`;

  it("namespaces each server so it cannot shadow the platform's own tools", async () => {
    const offered = offeredMcpServers([entry({})], urlFor);
    expect(offered).toEqual([
      { type: "http", name: "sandbox:alpha", url: "http://127.0.0.1:9700/mcp", headers: [] },
    ]);
  });

  it("refuses a server calling itself scooter-env", () => {
    // scooter-env is the agent-host's own in-process endpoint. A sandbox-declared
    // server taking that name would replace the platform tools with its own.
    expect(offeredMcpServers([entry({ name: "scooter-env" })], urlFor)).toEqual([]);
  });

  it("is stable under manifest ordering, so a reorder is not a 'change'", () => {
    const a = offeredMcpServers([entry({ name: "b", port: 9701 }), entry({ name: "a" })], urlFor);
    const b = offeredMcpServers([entry({ name: "a" }), entry({ name: "b", port: 9701 })], urlFor);
    expect(fingerprintOffered(a)).toBe(fingerprintOffered(b));
  });
});

describe("fingerprintOffered", () => {
  const urlFor = (d: McpServerDescriptor) => `http://127.0.0.1:${d.port}${d.path}`;

  it("changes when a server is added", () => {
    const one = fingerprintOffered(offeredMcpServers([entry({})], urlFor));
    const two = fingerprintOffered(
      offeredMcpServers([entry({}), entry({ name: "beta", port: 9701 })], urlFor),
    );
    expect(one).not.toBe(two);
  });

  it("changes when a server's PORT moves, which is what auto-assignment does", () => {
    // Adding a name that sorts earlier renumbers the others. The URL the agent was
    // given is then stale, so this must read as a change or the session keeps
    // talking to a port nothing is listening on.
    const before = fingerprintOffered(offeredMcpServers([entry({})], urlFor));
    const after = fingerprintOffered(offeredMcpServers([entry({ port: 9701 })], urlFor));
    expect(before).not.toBe(after);
  });

  it("is unchanged when nothing relevant moved", () => {
    const a = fingerprintOffered(offeredMcpServers([entry({})], urlFor));
    const b = fingerprintOffered(offeredMcpServers([entry({ displayName: "renamed" })], urlFor));
    expect(a).toBe(b);
  });
});
