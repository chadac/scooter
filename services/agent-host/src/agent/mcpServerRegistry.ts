/**
 * McpServerRegistry: reads a conversation's declared MCP servers from the in-pod
 * discovery manifest (/run/scooter/mcp-servers.json, rendered by the `mcpServers`
 * NixOS option) and the runtime one beside it via the exec API and drives their systemd units through
 * `scooter-mcp`, plus the pure resolver that turns descriptors into `new_session`
 * entries. Only running servers are offered, since a dead MCP endpoint degrades the
 * whole session, and the offered set carries a fingerprint so the bridge can tell
 * whether a rebuild changed anything.
 */

import { formatError, logger } from "../log.js";

import type { SandboxRef } from "../types.js";

const log = logger("mcp-registry");

/** The manifest file the `mcpServers` option renders inside the pod. */
export const MCP_MANIFEST_PATH = "/run/scooter/mcp-servers.json";

/** Servers registered at runtime, e.g. by contrib/mcpservers. */
export const MCP_RUNTIME_MANIFEST_PATH = "/run/scooter/mcp-servers.runtime.json";

/** Prefix for sandbox-declared servers, so none can shadow the platform's own. */
export const SANDBOX_PREFIX = "sandbox-";

/** Server names model APIs accept inside a tool name (`mcp__<server>__<tool>`). */
export const MCP_NAME_RE = /^[A-Za-z0-9_-]+$/;

export interface McpServerDescriptor {
  name: string;
  displayName: string;
  description: string;
  port: number;
  path: string;
  unit: string;
  autoStart: boolean;
}

/** An HTTP header on an offered MCP server, per the ACP schema's `HttpHeader`. */
export interface McpHeader {
  name: string;
  value: string;
}

/** An entry as `new_session`'s mcpServers takes it. */
export interface OfferedMcpServer {
  type: "http";
  name: string;
  url: string;
  headers: McpHeader[];
}

/** The exec surface needed here, a subset of SandboxApiClient. */
export interface ExecLike {
  execute(req: { command: string; args?: string[] }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  download(path: string): Promise<string>;
}

export interface McpServerRegistryDeps {
  sandboxFor(conversationId: string): SandboxRef | undefined;
  connect(ref: SandboxRef): Promise<ExecLike>;
}

export interface McpServerRegistry {
  /** The declared servers, or [] when the pod cannot be read. */
  list(conversationId: string, opts?: { force?: boolean }): Promise<McpServerDescriptor[]>;
  get(conversationId: string, name: string): Promise<McpServerDescriptor | null>;
  /** The declared servers whose units are active; throws when the pod cannot be read. */
  running(conversationId: string): Promise<McpServerDescriptor[]>;
  isRunning(conversationId: string, name: string): Promise<boolean>;
  /** Start it if it is not already up; false means no such server or the start failed. */
  ensureStarted(conversationId: string, name: string): Promise<boolean>;
  invalidate(conversationId: string): void;
}

/** Parse the manifest, tolerating a missing or garbage file; `name` and `port` are required and everything else defaults. */
export function parseMcpManifest(json: string): McpServerDescriptor[] {
  try {
    const data = JSON.parse(json) as { servers?: unknown };
    if (!data || !Array.isArray(data.servers)) return [];
    return data.servers.flatMap((s): McpServerDescriptor[] => {
      if (typeof s !== "object" || s === null) return [];
      const o = s as Record<string, unknown>;
      if (typeof o.name !== "string" || !MCP_NAME_RE.test(o.name) || typeof o.port !== "number") return [];
      return [{
        name: o.name,
        displayName: typeof o.displayName === "string" ? o.displayName : o.name,
        description: typeof o.description === "string" ? o.description : "",
        port: o.port,
        path: typeof o.path === "string" ? o.path : "/mcp",
        unit: typeof o.unit === "string" ? o.unit : `mcp-${o.name}`,
        autoStart: o.autoStart !== false,
      }];
    });
  } catch {
    return [];
  }
}

/** Declared servers plus runtime ones with a free name and port. */
export function mergeMcpManifests(declared: McpServerDescriptor[], runtime: McpServerDescriptor[]): McpServerDescriptor[] {
  const names = new Set(declared.map((d) => d.name));
  const ports = new Set(declared.map((d) => d.port));
  const out = declared.slice();
  for (const r of runtime) {
    if (names.has(r.name) || ports.has(r.port)) continue;
    names.add(r.name);
    ports.add(r.port);
    out.push(r);
  }
  return out;
}

/** How long a successful manifest read stays authoritative, since nothing in the pod signals a `scooter-rebuild`. */
export const MCP_MANIFEST_TTL_MS = 10_000;

/** The servers to offer a session, sorted by name so a reorder is not a fingerprint change. */
export function offeredMcpServers(
  descriptors: McpServerDescriptor[],
  urlFor: (d: McpServerDescriptor) => string,
  headers: McpHeader[] = [],
): OfferedMcpServer[] {
  return descriptors
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((d) => ({
      type: "http" as const,
      name: `${SANDBOX_PREFIX}${d.name}`,
      url: urlFor(d),
      headers,
    }));
}

/** A stable identity for the offered set, which the bridge compares across runs to decide whether to rebuild the agent session; it covers names, URLs and header names only, never header values, since a freshly minted token differs on every mint. */
export function fingerprintOffered(offered: OfferedMcpServer[]): string {
  return JSON.stringify(offered.map((o) => [o.name, o.url, o.headers.map((h) => h.name)]));
}

/** How many entries the manifest lists, or -1 if it is not a manifest. */
function listedCount(raw: string): number {
  try {
    const data = JSON.parse(raw) as { servers?: unknown };
    return data && Array.isArray(data.servers) ? data.servers.length : -1;
  } catch {
    return -1;
  }
}

export function createMcpServerRegistry(
  deps: McpServerRegistryDeps,
  opts: { ttlMs?: number; now?: () => number } = {},
): McpServerRegistry {
  const ttlMs = opts.ttlMs ?? MCP_MANIFEST_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  const cache = new Map<string, { descriptors: McpServerDescriptor[]; at: number }>();

  async function execFor(conversationId: string): Promise<ExecLike> {
    const ref = deps.sandboxFor(conversationId);
    if (!ref) throw new Error(`no sandbox for conversation ${conversationId}`);
    return deps.connect(ref);
  }

  /** The declared servers; throws if unreadable, so a blip is not "none". */
  async function read(conversationId: string, force = false): Promise<McpServerDescriptor[]> {
    const entry = cache.get(conversationId);
    if (!force && entry && now() - entry.at < ttlMs) return entry.descriptors;
    const exec = await execFor(conversationId);
    // The image always renders the manifest, so a failed read is a blip, not none declared.
    const raw = await exec.download(MCP_MANIFEST_PATH);
    const declared = parseMcpManifest(raw);
    if (listedCount(raw) !== declared.length) {
      log.warn("the MCP manifest has entries the agent-host cannot use; check the rendered file", {
        conversation_id: conversationId,
        path: MCP_MANIFEST_PATH,
        bytes: raw.length,
        usable: declared.length,
      });
    }
    const descriptors = mergeMcpManifests(declared, parseMcpManifest(await readRuntime(exec, conversationId)));
    cache.set(conversationId, { descriptors, at: now() });
    return descriptors;
  }

  /** The runtime manifest, or "" when unreadable (older images). */
  async function readRuntime(exec: ExecLike, conversationId: string): Promise<string> {
    try {
      return await exec.download(MCP_RUNTIME_MANIFEST_PATH);
    } catch (err) {
      log.debug("could not read the runtime MCP manifest", { conversation_id: conversationId, error: formatError(err) });
      return "";
    }
  }

  async function list(conversationId: string, force = false): Promise<McpServerDescriptor[]> {
    try {
      return await read(conversationId, force);
    } catch (err) {
      log.warn("could not read the MCP manifest", { conversation_id: conversationId, error: formatError(err) });
      return [];
    }
  }

  /** `systemctl is-active` prints one state per unit, in argument order. */
  async function activeUnits(conversationId: string, units: string[]): Promise<Set<string>> {
    const exec = await execFor(conversationId);
    const r = await exec.execute({ command: "systemctl", args: ["is-active", ...units] });
    const states = r.stdout.split("\n").map((l) => l.trim());
    return new Set(units.filter((_, i) => states[i] === "active"));
  }

  const registry: McpServerRegistry = {
    async list(conversationId, listOpts) {
      return list(conversationId, listOpts?.force ?? false);
    },
    async get(conversationId, name) {
      return (await list(conversationId)).find((d) => d.name === name) ?? null;
    },
    async running(conversationId) {
      const declared = await read(conversationId);
      if (declared.length === 0) return [];
      const active = await activeUnits(conversationId, declared.map((d) => d.unit));
      const down = declared.filter((d) => !active.has(d.unit)).map((d) => d.name);
      // A declared server the agent never sees needs a trace.
      if (down.length) log.info("not offering MCP servers that are not running", { conversation_id: conversationId, servers: down });
      return declared.filter((d) => active.has(d.unit));
    },
    async isRunning(conversationId, name) {
      const desc = await registry.get(conversationId, name);
      if (!desc) return false;
      try {
        return (await activeUnits(conversationId, [desc.unit])).has(desc.unit);
      } catch {
        return false;
      }
    },
    async ensureStarted(conversationId, name) {
      const desc = await registry.get(conversationId, name);
      if (!desc) return false;
      if (await registry.isRunning(conversationId, name)) return true;
      // Through `scooter-mcp` so the autostart intent survives a suspend/resume.
      try {
        const exec = await execFor(conversationId);
        const r = await exec.execute({ command: "scooter-mcp", args: ["start", name] });
        if (r.exitCode !== 0) {
          log.warn("scooter-mcp start failed; this server will not be offered", {
            conversation_id: conversationId,
            server: name,
            exit_code: r.exitCode,
            stderr: r.stderr.trim().slice(0, 500),
          });
        }
        return r.exitCode === 0;
      } catch (err) {
        log.warn("scooter-mcp start could not be executed; this server will not be offered", {
          conversation_id: conversationId,
          server: name,
          error: formatError(err),
        });
        return false;
      }
    },
    invalidate(conversationId) {
      cache.delete(conversationId);
    },
  };
  return registry;
}
