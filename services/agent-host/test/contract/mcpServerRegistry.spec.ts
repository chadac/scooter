/**
 * McpServerRegistry over a fake exec client, and the resolver that turns its descriptors
 * into `new_session` mcpServers entries. The registry reads the in-pod manifest the
 * `mcpServers` NixOS option renders and drives the units through `scooter-mcp`; the
 * offered set carries a fingerprint so the bridge can tell when to rebuild a session.
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
  ...over,
});

const manifestOf = (...servers: Partial<McpServerDescriptor>[]) =>
  JSON.stringify({ servers: servers.map((s) => entry(s)) });

const MANIFEST = manifestOf({});
/** What mcp-servers.nix renders when nothing is declared. */
const EMPTY = JSON.stringify({ servers: [] });

type Req = { command: string; args?: string[] };
type Res = { stdout: string; stderr: string; exitCode: number };

/** A pod: `download` reads the manifest (null = missing), `systemctl is-active` reports `states`, anything else succeeds. */
function fakePod(opts: { manifest?: string | null; states?: Record<string, string>; on?: (req: Req) => Res | undefined } = {}) {
  const calls: Req[] = [];
  const exec: ExecLike = {
    execute: vi.fn(async (req: Req): Promise<Res> => {
      calls.push(req);
      const custom = opts.on?.(req);
      if (custom) return custom;
      if (req.command === "systemctl") {
        const units = (req.args ?? []).slice(1);
        const lines = units.map((u) => opts.states?.[u] ?? "active");
        return { stdout: lines.join("\n") + "\n", stderr: "", exitCode: lines.every((l) => l === "active") ? 0 : 3 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }),
    download: vi.fn(async (path: string): Promise<string> => {
      const req = { command: "download", args: [path] };
      calls.push(req);
      expect(path).toBe(MCP_MANIFEST_PATH);
      const custom = opts.on?.(req);
      if (custom && custom.exitCode !== 0) throw new Error(`download ${path}: ${custom.stderr}`);
      if (custom) return custom.stdout;
      if (opts.manifest === null) throw new Error(`download ${path}: No such file or directory`);
      return opts.manifest ?? MANIFEST;
    }),
  };
  return { exec, calls, reads: () => calls.filter((c) => c.command === "download").length };
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
    expect(parseMcpManifest("")).toEqual([]);
    expect(parseMcpManifest("not json")).toEqual([]);
    expect(parseMcpManifest("{}")).toEqual([]);
    expect(parseMcpManifest(JSON.stringify({ servers: "nope" }))).toEqual([]);
  });

  it("drops entries missing the fields the transport needs", () => {
    const bad = JSON.stringify({ servers: [{ name: "x" }, { port: 1 }, entry({ name: "ok" })] });
    expect(parseMcpManifest(bad).map((s) => s.name)).toEqual(["ok"]);
  });

  it("drops a name that cannot appear in a tool name", () => {
    // Model APIs accept only [A-Za-z0-9_-] in mcp__<server>__<tool>.
    const bad = JSON.stringify({ servers: [entry({ name: "a.b" }), entry({ name: "a:b" }), entry({ name: "ok_1-x" })] });
    expect(parseMcpManifest(bad).map((s) => s.name)).toEqual(["ok_1-x"]);
  });

  it("defaults the optional fields so a sparse manifest still works", () => {
    const sparse = JSON.stringify({ servers: [{ name: "x", port: 9700 }] });
    expect(parseMcpManifest(sparse)[0]).toMatchObject({ name: "x", port: 9700, path: "/mcp", unit: "mcp-x" });
  });
});

describe("McpServerRegistry", () => {
  it("lists the declared servers", async () => {
    const reg = make(fakePod().exec);
    expect((await reg.list("conv-1")).map((s) => s.name)).toEqual(["alpha"]);
  });

  it("treats an empty manifest as none declared", async () => {
    const reg = make(fakePod({ manifest: EMPTY }).exec);
    expect(await reg.list("conv-1")).toEqual([]);
    await expect(reg.running("conv-1")).resolves.toEqual([]);
  });

  it("treats a missing manifest as unreadable, since the image always renders one", async () => {
    const reg = make(fakePod({ manifest: null }).exec);
    expect(await reg.list("conv-1")).toEqual([]);
    await expect(reg.running("conv-1")).rejects.toThrow(/No such file/);
  });

  it("caches an empty manifest too, so a sandbox without servers costs one read per TTL", async () => {
    // Most sandboxes declare none; the resolver runs every message.
    const pod = fakePod({ manifest: EMPTY });
    const reg = make(pod.exec);
    await reg.running("conv-1");
    await reg.running("conv-1");
    expect(pod.reads()).toBe(1);
  });

  it("serves the list from cache until the TTL expires", async () => {
    let now = 1000;
    const pod = fakePod();
    const reg = make(pod.exec, { ttlMs: 100, now: () => now });
    await reg.list("conv-1");
    await reg.list("conv-1");
    expect(pod.reads()).toBe(1);
    now += 200;
    await reg.list("conv-1");
    expect(pod.reads()).toBe(2);
  });

  it("re-reads on force and after invalidate", async () => {
    const pod = fakePod();
    const reg = make(pod.exec);
    await reg.list("conv-1");
    await reg.list("conv-1", { force: true });
    reg.invalidate("conv-1");
    await reg.list("conv-1");
    expect(pod.reads()).toBe(3);
  });

  it("does not cache a FAILED read", async () => {
    let broken = true;
    const pod = fakePod({ on: (req) => (req.command === "download" && broken ? { stdout: "", stderr: "Permission denied", exitCode: 1 } : undefined) });
    const reg = make(pod.exec);
    expect(await reg.list("conv-1")).toEqual([]);
    broken = false;
    expect((await reg.list("conv-1")).map((s) => s.name)).toEqual(["alpha"]);
  });

  it("running() THROWS when the pod cannot be read, so a blip is not 'servers removed'", async () => {
    const pod = fakePod({ on: (req) => (req.command === "download" ? { stdout: "", stderr: "Permission denied", exitCode: 1 } : undefined) });
    await expect(make(pod.exec).running("conv-1")).rejects.toThrow(/Permission denied/);
  });

  it("running() offers only the active units, checked in one exec", async () => {
    const pod = fakePod({
      manifest: manifestOf({ name: "alpha" }, { name: "beta", port: 9701, unit: "mcp-beta" }, { name: "gamma", port: 9702, unit: "mcp-gamma" }),
      states: { "mcp-beta": "failed" },
    });
    const got = await make(pod.exec).running("conv-1");
    expect(got.map((s) => s.name)).toEqual(["alpha", "gamma"]);
    const checks = pod.calls.filter((c) => c.command === "systemctl");
    expect(checks).toHaveLength(1);
    expect(checks[0].args).toEqual(["is-active", "mcp-alpha", "mcp-beta", "mcp-gamma"]);
  });

  it("reports a running server from `systemctl is-active`", async () => {
    expect(await make(fakePod().exec).isRunning("conv-1", "alpha")).toBe(true);
  });

  it("reports a stopped server as not running", async () => {
    const pod = fakePod({ states: { "mcp-alpha": "inactive" } });
    expect(await make(pod.exec).isRunning("conv-1", "alpha")).toBe(false);
  });

  it("starts a stopped server through scooter-mcp, not raw systemctl", async () => {
    // The CLI persists the autostart intent to the workspace PVC for boot restore.
    const pod = fakePod({ states: { "mcp-alpha": "inactive" } });
    await make(pod.exec).ensureStarted("conv-1", "alpha");
    expect(pod.calls.some((c) => c.command === "scooter-mcp" && c.args?.[0] === "start" && c.args?.[1] === "alpha")).toBe(true);
  });

  it("does not restart a server that is already running", async () => {
    const pod = fakePod();
    await make(pod.exec).ensureStarted("conv-1", "alpha");
    expect(pod.calls.some((c) => c.command === "scooter-mcp")).toBe(false);
  });

  it("reports an unknown server rather than pretending it started", async () => {
    await expect(make(fakePod().exec).ensureStarted("conv-1", "nope")).resolves.toBe(false);
  });
});

describe("offeredMcpServers", () => {
  const urlFor = (d: McpServerDescriptor) => `http://127.0.0.1:${d.port}${d.path}`;

  it("namespaces each server so it cannot shadow the platform's own tools", async () => {
    const offered = offeredMcpServers([entry({})], urlFor);
    expect(offered).toEqual([
      { type: "http", name: "sandbox-alpha", url: "http://127.0.0.1:9700/mcp", headers: [] },
    ]);
  });

  it("prefixes even a platform name, so it cannot shadow scooter-env", () => {
    expect(offeredMcpServers([entry({ name: "scooter-env" })], urlFor)[0].name).toBe("sandbox-scooter-env");
  });

  it("attaches the given headers, which carry the conversation token", () => {
    const auth = [{ name: "Authorization", value: "Bearer t" }];
    expect(offeredMcpServers([entry({})], urlFor, auth)[0].headers).toEqual(auth);
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
    // Adding a name that sorts earlier renumbers the others, so the URL the agent was given goes stale.
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

// --- the credential-in-headers case -------------------------------------------------
//
// A conversation token is minted per session with a fresh `iat`, so a fingerprint over
// header values would rebuild the session on every mint, forever.
describe("fingerprintOffered with credential headers", () => {
  const withHeader = (value: string) => [
    { type: "http" as const, name: "scooter-env", url: "http://h/mcp", headers: [{ name: "Authorization", value }] },
  ];

  it("is STABLE when a header's value changes, which a re-mint always does", () => {
    expect(fingerprintOffered(withHeader("Bearer token-at-t1"))).toBe(
      fingerprintOffered(withHeader("Bearer token-at-t2")),
    );
  });

  it("still CHANGES when a header is added, which is a structural change", () => {
    const none = [{ type: "http" as const, name: "scooter-env", url: "http://h/mcp", headers: [] }];
    expect(fingerprintOffered(none)).not.toBe(fingerprintOffered(withHeader("Bearer t")));
  });

  it("still CHANGES when a header is RENAMED", () => {
    const renamed = [
      {
        type: "http" as const,
        name: "scooter-env",
        url: "http://h/mcp",
        headers: [{ name: "X-Scooter-Conversation", value: "Bearer t" }],
      },
    ];
    expect(fingerprintOffered(withHeader("Bearer t"))).not.toBe(fingerprintOffered(renamed));
  });
});
