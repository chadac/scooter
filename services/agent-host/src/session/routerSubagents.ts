/**
 * Subagent creation through the router, the one creator (PR #726).
 */

import { formatError, logger } from "../log.js";

const log = logger("routerSubagents");

/** What the router created, plus what the child inherited. */
export interface CreatedSubagent {
  id: string;
  title?: string;
  /** The parent's sandbox the child shares, if it has one. */
  sandboxRef?: string;
}

/** REJECTS rather than let a caller mint its own id. */
export type SubagentCreator = (
  parentId: string,
  args: { title?: string; model?: string },
) => Promise<CreatedSubagent>;

export interface RouterSubagentsConfig {
  /** The router's base URL, which is the `agent-host` Service. */
  url: string;
  /** Projected SA token; absent means unauthenticated, for dev. */
  tokenPath?: string;
  /** A slow write must not hold the parent's turn open. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Fresh per call, because projected tokens rotate. */
async function authHeaders(tokenPath?: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!tokenPath) return headers;
  try {
    const { readFile } = await import("node:fs/promises");
    headers["Authorization"] = `Bearer ${(await readFile(tokenPath, "utf8")).trim()}`;
  } catch (e) {
    // Only ENOENT may become an unauthenticated request.
    if ((e as { code?: string })?.code !== "ENOENT") {
      throw new Error(`failed to read the router token at ${tokenPath}: ${(e as Error)?.message ?? e}`, { cause: e });
    }
  }
  return headers;
}

export function createRouterSubagentCreator(config: RouterSubagentsConfig): SubagentCreator {
  const base = config.url.replace(/\/+$/, "");
  const doFetch = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;

  return async (parentId, args) => {
    const url = `${base}/conversations/${encodeURIComponent(parentId)}/subagents`;
    const body = JSON.stringify({
      ...(args.title ? { title: args.title } : {}),
      ...(args.model ? { model: args.model } : {}),
    });
    const signal = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await doFetch(url, { method: "POST", headers: await authHeaders(config.tokenPath), body, signal });
    } catch (e) {
      log.warn("subagent create request failed", { parent_id: parentId, error: formatError(e) });
      throw new Error(`conversation-router unreachable for subagent create: ${(e as Error)?.message ?? e}`, { cause: e });
    }
    if (res.status !== 201) {
      const detail = (await res.text().catch(() => "")).slice(0, 500);
      // Log the status: a refused caller also answers 404.
      log.warn("subagent create rejected", { parent_id: parentId, status: res.status, detail });
      throw new Error(`conversation-router refused the subagent create (${res.status}): ${detail}`);
    }
    const created = (await res.json()) as { id?: string; title?: string; sandboxRef?: string };
    if (!created?.id) throw new Error("conversation-router returned no subagent id");
    return { id: created.id, title: created.title, sandboxRef: created.sandboxRef };
  };
}
