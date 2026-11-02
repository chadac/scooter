/**
 * The sandbox-MCP proxy, how the agent reaches MCP servers declared in its own pod
 * (`mcpServers.<name>`). The agent connects to a stable agent-host URL per server
 * with its conversation token; each request is resolved to the server's current pod
 * IP and port, so neither a suspend/resume nor a renumbered port changes the URL the
 * session holds. Responses are streamed, never buffered.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { describeError, formatError, logger } from "../log.js";
import type { McpServerDescriptor } from "./mcpServerRegistry.js";

const log = logger("sandbox-mcp-proxy");

export interface SandboxMcpProxy {
  /** Handle a request the agent made for server `name`. */
  handle(req: IncomingMessage, res: ServerResponse, body: unknown, name: string): Promise<void>;
  /** The URL to advertise to the agent for server `name`. */
  urlFor(name: string): string;
}

export interface SandboxMcpProxyDeps {
  /** The agent-host's own base URL as the agent reaches it. */
  baseUrl: string;
  /** Resolve and verify the caller's conversation token to a conversation id, or undefined. */
  resolveConversation(req: IncomingMessage): string | undefined;
  /** The declared server, or null when there is none by that name. */
  serverFor(conversationId: string, name: string): Promise<McpServerDescriptor | null>;
  /** Look up the conversation pod's IP; throws when the pod is not running. */
  podIPFor(conversationId: string): Promise<string>;
  /** Forget cached manifest state after a failed upstream call. */
  invalidate(conversationId: string): void;
}

/** A looked-up pod IP is reused this long; a connect error drops it. */
const POD_IP_TTL_MS = 30_000;

/** Hop-by-hop headers, and the agent's credential meant for this proxy. */
const DROP = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "content-length",
  "authorization",
]);

export function createSandboxMcpProxy(deps: SandboxMcpProxyDeps): SandboxMcpProxy {
  const podIPs = new Map<string, { ip: string; at: number }>();

  const podIPFor = async (conversationId: string): Promise<string> => {
    const hit = podIPs.get(conversationId);
    if (hit && Date.now() - hit.at < POD_IP_TTL_MS) return hit.ip;
    const ip = await deps.podIPFor(conversationId);
    podIPs.set(conversationId, { ip, at: Date.now() });
    return ip;
  };

  const fail = (res: ServerResponse, status: number, message: string) => {
    res.statusCode = status;
    res.end(message);
  };

  return {
    urlFor(name) {
      return `${deps.baseUrl.replace(/\/$/, "")}/sandbox-mcp/${encodeURIComponent(name)}`;
    },

    async handle(req, res, body, name) {
      const conversationId = deps.resolveConversation(req);
      if (!conversationId) return fail(res, 401, "missing or invalid conversation token");

      const server = await deps.serverFor(conversationId, name);
      if (!server) return fail(res, 404, `no MCP server named ${JSON.stringify(name)} is declared in this sandbox`);

      let podIP: string;
      try {
        podIP = await podIPFor(conversationId);
      } catch (err) {
        return fail(res, 503, `the sandbox is not running: ${describeError(err)}`);
      }

      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (DROP.has(k.toLowerCase())) continue;
        if (typeof v === "string") headers[k] = v;
        else if (Array.isArray(v)) headers[k] = v.join(", ");
      }
      const upstream = `http://${podIP}:${server.port}${server.path}`;
      // An agent leaving an SSE stream must not leave it open upstream.
      const gone = new AbortController();
      res.on("close", () => gone.abort());
      let upstreamRes: Response;
      try {
        upstreamRes = await fetch(upstream, {
          method: req.method ?? "POST",
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: gone.signal,
        });
      } catch (err) {
        if (gone.signal.aborted) return;
        // The pod or port may have moved; re-resolve both.
        podIPs.delete(conversationId);
        deps.invalidate(conversationId);
        log.warn("could not reach a sandbox MCP server", {
          conversation_id: conversationId,
          server: name,
          upstream,
          error: formatError(err),
        });
        return fail(res, 502, `could not reach sandbox MCP server ${JSON.stringify(name)}: ${describeError(err)}`);
      }

      res.statusCode = upstreamRes.status;
      upstreamRes.headers.forEach((value, key) => {
        // Node re-chunks the body; copying these would corrupt it.
        const k = key.toLowerCase();
        if (k === "content-length" || k === "transfer-encoding") return;
        res.setHeader(key, value);
      });
      const stream = upstreamRes.body;
      if (!stream) return void res.end();
      // Streamed: buffering would hold SSE results until the end.
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      } catch (err) {
        if (gone.signal.aborted) return;
        log.warn("sandbox MCP response stream failed mid-flight", {
          conversation_id: conversationId,
          server: name,
          error: formatError(err),
        });
      } finally {
        res.end();
      }
    },
  };
}
