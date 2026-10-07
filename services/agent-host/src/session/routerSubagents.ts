/**
 * Creating a SUBAGENT conversation through the conversation-router — the ONE creator of a
 * conversation, so the child's row exists before its first event.
 *
 * Carries no identity: the router derives owner/sandbox/model from the parent row. The SA token
 * (audience `agent-host`) authenticates this service, it does not pass along a user. Why: PR #726.
 */

import { formatError, logger } from "../log.js";

const log = logger("routerSubagents");

/** What the router created: the child's id, plus what it inherited. */
export interface CreatedSubagent {
  id: string;
  title?: string;
  /** The parent's sandbox the child shares. Absent when the parent has none yet. */
  sandboxRef?: string;
}

/** Resolves with the ROUTER-minted id. REJECTS on failure — a caller must not fall back to
 *  minting its own, which is the second creation path this removes. */
export type SubagentCreator = (
  parentId: string,
  args: { title?: string; model?: string },
) => Promise<CreatedSubagent>;

export interface RouterSubagentsConfig {
  /** The router's base URL (the `agent-host` Service front door). */
  url: string;
  /** Projected SA token for the router's TokenReview. Absent => unauthenticated (dev). */
  tokenPath?: string;
  /** Request timeout; a slow control-plane write must not hold the parent's turn open. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Fresh per call: projected tokens ROTATE, so a value cached at boot later 401s. */
async function authHeaders(tokenPath?: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!tokenPath) return headers;
  try {
    const { readFile } = await import("node:fs/promises");
    headers["Authorization"] = `Bearer ${(await readFile(tokenPath, "utf8")).trim()}`;
  } catch (e) {
    // ENOENT is the no-token dev case. Any other error must NOT become an unauthenticated
    // request — the router refuses that as a 404 indistinguishable from a missing parent.
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
      // A 404 is a refused CALLER as often as a missing parent — the router answers both
      // alike — so log the status: an SA off the trust list looks identical otherwise.
      log.warn("subagent create rejected", { parent_id: parentId, status: res.status, detail });
      throw new Error(`conversation-router refused the subagent create (${res.status}): ${detail}`);
    }
    const created = (await res.json()) as { id?: string; title?: string; sandboxRef?: string };
    if (!created?.id) throw new Error("conversation-router returned no subagent id");
    return { id: created.id, title: created.title, sandboxRef: created.sandboxRef };
  };
}
