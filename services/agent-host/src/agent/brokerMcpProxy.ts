/**
 * The broker-MCP proxy, how the agent reaches the broker's contrib tools. The
 * broker's /mcp needs an allowlisted control-plane SA token (which rotates roughly
 * hourly, so it cannot be fixed into the session's MCP headers) plus a conversation
 * token, so the agent connects here with the conversation token it holds and the
 * agent-host attaches a fresh SA token and a freshly minted conversation token on
 * every request. Responses are streamed, never buffered.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { describeError, formatError, logger } from "../log.js";

const log = logger("broker-mcp-proxy");

/** The header the broker reads the conversation token from (broker/core/conv_token.py). */
export const CONV_TOKEN_HEADER = "x-scooter-conversation";

export interface BrokerMcpProxy {
  /** Handle a request the agent made to this proxy, with the conversation from `resolveConversation`. */
  handle(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void>;
  /** The URL to advertise to the agent as the broker MCP server. */
  url(): string;
}

export interface BrokerMcpProxyDeps {
  /** The agent-host's own base URL as the agent reaches it. */
  baseUrl: string;
  /** Path this proxy is served on. */
  path?: string;
  /** The broker's MCP endpoint, e.g. "http://agent-broker:8080/mcp". */
  brokerMcpUrl: string;
  /** Resolve and verify the caller's conversation token to a conversation id, or undefined. */
  resolveConversation(req: IncomingMessage): string | undefined;
  /** Mint the conversation token for the outbound call. */
  mintConvToken(conversationId: string): string;
  /** A fresh control-plane SA token, read per request because it rotates on disk; undefined when none is configured. */
  saToken(): Promise<string | undefined>;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** Headers never forwarded: hop-by-hop ones plus the two credentials replaced here, matched case-insensitively. */
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
        // The agent gets a real failure rather than a hang.
        log.warn("could not reach the broker MCP endpoint", {
          conversation_id: conversationId,
          upstream,
          error: formatError(err),
        });
        res.statusCode = 502;
        res.end(`could not reach the broker MCP endpoint: ${describeError(err)}`);
        return;
      }

      res.statusCode = upstreamRes.status;
      upstreamRes.headers.forEach((value, name) => {
        // Node re-chunks the body, so copying either would corrupt the response.
        if (name.toLowerCase() === "content-length" || name.toLowerCase() === "transfer-encoding") return;
        res.setHeader(name, value);
      });

      const stream = upstreamRes.body;
      if (!stream) {
        res.end();
        return;
      }
      // Stream it through, since buffering would hold an SSE tool result until the response completed.
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
