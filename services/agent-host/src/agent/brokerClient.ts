/**
 * The agent-host's server-side broker client — the HTTP plumbing behind the
 * agent-tools (agentTools.ts). A `BrokerClient.call` issues one authenticated
 * request to the broker and returns the RAW upstream outcome ({status, data,
 * raw}) so the tools can echo errors verbatim (the "never hide an error" rule).
 *
 * AUTH: same anchor the AWS-approval path uses (index.ts resolveAwsRequest) —
 * `BROKER_URL` + a Bearer token read from `BROKER_TOKEN_PATH` (the agent-host's
 * ServiceAccount token). The token is read per-call (it's rotated on disk), and a
 * MISSING token (ENOENT) is the genuine local/dev case (no auth header, broker
 * may 401 — surfaced verbatim). An unreadable-but-present token is a real error
 * and is thrown, rather than silently downgrading to an unauthenticated call.
 */

import type { BrokerClient, BrokerResponse } from "./agentTools.js";

export interface HttpBrokerClientDeps {
  /** The broker base URL (no trailing slash needed — normalized here). */
  baseUrl: string;
  /** Path to the agent-host's SA token; a Bearer token is read from it per call.
   *  Optional — when unset/absent the client sends no auth (local/dev). */
  tokenPath?: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** An HTTP-backed BrokerClient bound to the agent-host's broker identity. */
export function createBrokerClient(deps: HttpBrokerClientDeps): BrokerClient {
  const base = deps.baseUrl.replace(/\/$/, "");
  const doFetch = deps.fetchImpl ?? fetch;
  const tokenPath = deps.tokenPath;

  async function authHeader(): Promise<Record<string, string>> {
    if (!tokenPath) return {};
    try {
      const { readFileSync } = await import("node:fs");
      return { Authorization: `Bearer ${readFileSync(tokenPath, "utf8").trim()}` };
    } catch (e) {
      // Mirror resolveAwsRequest (index.ts finding #9): only a not-found token is
      // the dev case. An unreadable token that SHOULD be there must not silently
      // downgrade to an unauthenticated call (broker 401 -> silent tool failure).
      if ((e as { code?: string })?.code !== "ENOENT") {
        throw new Error(
          `failed to read broker token at ${tokenPath} (would send an ` +
            `unauthenticated broker request): ${(e as Error)?.message ?? e}`,
          { cause: e },
        );
      }
      return {}; /* ENOENT -> no token (local/dev) */
    }
  }

  return {
    async call(_conversationId, method, path, body): Promise<BrokerResponse> {
      // The agent-host calls the broker server-side under its OWN SA identity; the
      // conversationId is passed through for symmetry/future per-conv scoping but
      // is not currently sent (the broker trusts the SA token). The URL path is
      // built by the tool handlers (agentTools.ts).
      const headers: Record<string, string> = { ...(await authHeader()) };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const raw = await res.text().catch(() => "");
      let data: unknown;
      // Parse JSON when the body looks like JSON; else leave undefined (raw still
      // carries the verbatim body for the error-echo path).
      try {
        data = raw ? JSON.parse(raw) : undefined;
      } catch {
        data = undefined;
      }
      return { status: res.status, data, raw };
    },
  };
}
