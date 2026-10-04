/**
 * The broker-MCP proxy — how the agent reaches the broker's contrib-contributed tools.
 *
 * WHY A PROXY AND NOT A DIRECT URL. The broker's /mcp requires TWO credentials: an
 * allowlisted control-plane SA token (which proves a trusted platform component is
 * calling, and whose kubelet rotation is the freshness guarantee) and a signed
 * conversation token (which says WHICH conversation). An MCP server's `headers` are
 * fixed when the agent session is created, but a projected SA token rotates roughly
 * hourly — so embedding one would work for an hour and then 401 every provider tool
 * mid-conversation. That is the same silent-degradation failure the conversation
 * token's long TTL exists to avoid.
 *
 * So the agent connects HERE with the conversation token it already holds, and the
 * agent-host attaches a FRESH SA token server-side on every request. The agent never
 * holds the SA token — which also means a BYOC container, reaching this over the
 * tunnel, cannot be handed one. See issue #700.
 *
 * The conversation token is RE-MINTED for the outbound call rather than forwarded.
 * Decoupling the two means a nearly-expired inbound token does not produce a
 * nearly-expired outbound one, and the broker only ever sees a token this process
 * just signed.
 *
 * STREAMS, never buffers: MCP streamable-HTTP responses arrive incrementally (SSE),
 * and buffering one would hold a tool's output until it completed.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { formatError, logger } from "../log.js";

const log = logger("broker-mcp-proxy");

/** The header the broker reads the conversation token from (broker/core/conv_token.py). */
export const CONV_TOKEN_HEADER = "x-scooter-conversation";

export interface BrokerMcpProxy {
  /** Handle a request the agent made to this proxy. The conversation comes from
   *  `resolveConversation` — never from the URL or the agent's own headers. */
  handle(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void>;
  /** The URL to advertise to the agent as the broker MCP server. */
  url(): string;
}

export interface BrokerMcpProxyDeps {
  /** The agent-host's own base URL, as the agent reaches it (loopback in-pod). */
  baseUrl: string;
  /** Path this proxy is served on. */
  path?: string;
  /** The broker's MCP endpoint, e.g. "http://agent-broker:8080/mcp". */
  brokerMcpUrl: string;
  /** Resolve + verify the caller's conversation token. Returns the conversation id,
   *  or undefined when the caller presented nothing usable. */
  resolveConversation(req: IncomingMessage): string | undefined;
  /** Mint the conversation token for the OUTBOUND call. */
  mintConvToken(conversationId: string): string;
  /** A FRESH control-plane SA token, read per request because it rotates on disk.
   *  Returns undefined when none is configured (local/dev) — the broker then 401s,
   *  which is surfaced rather than hidden. */
  saToken(): Promise<string | undefined>;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** Headers we never forward: hop-by-hop, plus the two we REPLACE. An agent-supplied
 *  Authorization must not reach the broker — the whole point is that the credential is
 *  ours, attached here. Case-insensitive, since the caller chooses the spelling. */
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
  CONV_TOKEN_HEADER,
]);

export function createBrokerMcpProxy(deps: BrokerMcpProxyDeps): BrokerMcpProxy {
  const path = deps.path ?? "/broker-mcp";
  const doFetch = deps.fetchImpl ?? fetch;
  const upstream = deps.brokerMcpUrl.replace(/\/$/, "");

  return {
    url() {
      return `${deps.baseUrl.replace(/\/$/, "")}${path}`;
    },

    async handle(req, res, body) {
      const conversationId = deps.resolveConversation(req);
      if (!conversationId) {
        res.statusCode = 401;
        res.end("missing or invalid conversation token");
        return;
      }

      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (DROP.has(name.toLowerCase())) continue;
        if (typeof value === "string") headers[name] = value;
        else if (Array.isArray(value)) headers[name] = value.join(", ");
      }
      const sa = await deps.saToken();
      if (sa) headers.Authorization = `Bearer ${sa}`;
      headers[CONV_TOKEN_HEADER] = deps.mintConvToken(conversationId);

      let upstreamRes: Response;
      try {
        upstreamRes = await doFetch(upstream, {
          method: req.method ?? "POST",
          headers,
          body: body === undefined || req.method === "GET" ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        // The agent gets a real failure rather than a hang. Logged with the
        // conversation so "my github_comment stopped working" is answerable.
        log.warn("could not reach the broker MCP endpoint", {
          conversation_id: conversationId,
          upstream,
          error: formatError(err),
        });
        res.statusCode = 502;
        res.end(`could not reach the broker MCP endpoint: ${formatError(err)}`);
        return;
      }

      res.statusCode = upstreamRes.status;
      upstreamRes.headers.forEach((value, name) => {
        // Re-chunked by node; copying either would corrupt the response.
        if (name.toLowerCase() === "content-length" || name.toLowerCase() === "transfer-encoding") return;
        res.setHeader(name, value);
      });

      const stream = upstreamRes.body;
      if (!stream) {
        res.end();
        return;
      }
      // STREAM it through. Buffering would hold an SSE tool result until the whole
      // response completed, which for a streaming tool is the difference between
      // incremental output and a stall.
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      } catch (err) {
        log.warn("broker MCP response stream failed mid-flight", {
          conversation_id: conversationId,
          error: formatError(err),
        });
      } finally {
        res.end();
      }
    },
  };
}
