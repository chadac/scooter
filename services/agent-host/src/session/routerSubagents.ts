/**
 * Creating a SUBAGENT conversation through the conversation-router.
 *
 * Subagents were the last conversations the agent-host created for itself: spawn() minted a
 * `randomUUID()` and spawnChild() wrote the CR, while the `conversations` row appeared only when
 * saveMeta() first ran. Top-level conversations have not worked that way since PR #654 — the
 * router mints the id and writes CR + row together at create time.
 *
 * Two writers of "a conversation now exists" is what made the row's existence depend on which one
 * ran first, and the agent-host's own append fence then had to tolerate a missing row (see the
 * conversation in PR #679). So the host asks the router instead: ONE creator, one id, and the row
 * exists before the child's first event.
 *
 * The router infers everything else from the PARENT row — owner, sandbox pod, model — so this
 * carries no identity of its own. The agent-host authenticates with its projected SA token
 * (audience `agent-host`, the Service the router fronts), which the router verifies by TokenReview;
 * it is not passing along a user's identity and cannot choose an owner. Why: PR #726.
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

/**
 * Create a subagent conversation for `parentId`. Resolves with the router-minted id.
 * REJECTS on any failure — a caller must not fall back to minting its own id, because that is
 * precisely the second creation path this removes.
 */
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

/** Read the SA token fresh per call: projected tokens ROTATE, so a value cached at boot
 *  expires and every subagent spawn then 401s a few hours into the pod's life. */
async function authHeaders(tokenPath?: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!tokenPath) return headers;
  try {
    const { readFile } = await import("node:fs/promises");
    headers["Authorization"] = `Bearer ${(await readFile(tokenPath, "utf8")).trim()}`;
  } catch (e) {
    // ENOENT is the local/dev case (no projected token); anything else is a real fault and
    // must not be downgraded into an unauthenticated request that silently 404s.
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
      // 404 here is the router refusing the caller as much as a genuinely missing parent — it
      // answers 404 for both on purpose (a 403 would confirm the parent exists). Log the status
      // so a deploy whose SA is not on the router's trust list is diagnosable.
      log.warn("subagent create rejected", { parent_id: parentId, status: res.status, detail });
      throw new Error(`conversation-router refused the subagent create (${res.status}): ${detail}`);
    }
    const created = (await res.json()) as { id?: string; title?: string; sandboxRef?: string };
    if (!created?.id) throw new Error("conversation-router returned no subagent id");
    return { id: created.id, title: created.title, sandboxRef: created.sandboxRef };
  };
}
