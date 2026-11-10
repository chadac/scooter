/**
 * ACP provider selection: a registry of AcpProviders, each declaring whether it can
 * serve a given run (`eligible(ctx)`) and a priority, resolved per run. The choice is
 * per run because `source` is a per-prompt property: a conversation can use a
 * personalized remote brain for a human trigger and the cloud brain for a scheduled one.
 */

import { formatError, logger } from "../log.js";
import type { OfferedMcpServer } from "../agent/mcpServerRegistry.js";

import type { AcpClient } from "./client.js";
import type { SessionId } from "../types.js";

const log = logger("acp-providers");

/** The per-run context a provider's `eligible()` decides on, assembled by the bridge from the conversation and the incoming prompt. */
export interface RunContext {
  /** The conversation (thread) id; never the bridge's own `sess-` id. */
  conversationId: SessionId;
  /** The conversation owner, or undefined for an unowned/anonymous conversation. */
  owner?: string;
  /** The trigger source of this run ("ui", "slack", "github", "gitlab", "scheduler", "webhook", "nudge", ...); undefined means a plain interactive prompt. */
  source?: string;
  /** Inherited human trigger for derived runs; overrides `source` when set. */
  humanInitiated?: boolean;
  /** The resolved model for this run. */
  model?: string;
  /** The provider the user explicitly picked; undefined = priority decides. */
  provider?: string;
}

/** One selectable ACP backend: a pure declaration of capability plus a factory, with selection and lifecycle owned by the resolver and BridgeAcpManager. */
export interface AcpProvider {
  /** The MCP servers to offer this provider's sessions, derived from the bridge's per-run set (a BYO container offers tunnel names it proxies locally). */
  mcpServersFor?: (conversationId: string, resolved: readonly OfferedMcpServer[]) => OfferedMcpServer[];
  /** The model namespace this provider serves, matched against each catalog model's `providers` tags; absent offers any catalog model. */
  modelTag?: string;
  /** True when the agent cannot read this pod's filesystem, so the skills must travel as data in `new_session`; the default suits an in-pod agent, which reads `skillsDir` itself. */
  readonly needsSkillPayloads?: boolean;
  /** True when the agent builds no identity of its own, so the host's prompt must travel in `new_session`; the default suits an in-pod agent, which builds its own. */
  readonly needsSystemPrompt?: boolean;
  /** Stable id for logging/metrics and the BridgeAcpManager cache key, e.g. "bedrock-goose" or "remote-personalized". */
  readonly id: string;
  /** Recording/telemetry label, the bridge's `provider`. */
  readonly kind: "goose" | "claude";
  /** Higher wins among eligible providers; the always-eligible floor is lowest. */
  readonly priority: number;
  /** Whether this provider may serve the run, possibly async since the BYOC provider asks the controller. */
  eligible(ctx: RunContext): boolean | Promise<boolean>;
  /** Build the AcpClient for a run this provider serves; the bridge caches the result per provider, so it need not memoize. */
  createClient(ctx: RunContext): Promise<AcpClient> | AcpClient;
}

/** Pick the highest-priority eligible provider (tie-break by id), or undefined only when none is eligible, so a registry without a floor fails loud. */
export async function pickAcpProvider(
  providers: readonly AcpProvider[],
  ctx: RunContext,
): Promise<AcpProvider | undefined> {
  // An eligible explicit pick outranks priority; an ineligible one falls through.
  const candidates = ctx.provider ? reorderPicked(providers, ctx.provider) : providers;
  let best: AcpProvider | undefined;
  for (const p of candidates) {
    // Awaited because eligibility can require a network call, and a provider that throws reads
    // as "not eligible" so the floor stays reachable.
    let ok = false;
    try {
      ok = await p.eligible(ctx);
    } catch (err) {
      log.warn("provider eligible() threw — treating as not eligible", {
        provider_id: p.id,
        error: formatError(err),
      });
      ok = false;
    }
    if (!ok) continue;
    if (ctx.provider && p.id === ctx.provider) return p;
    if (best === undefined || p.priority > best.priority || (p.priority === best.priority && p.id < best.id)) {
      best = p;
    }
  }
  return best;
}

/** Picked provider first, so an eligible pick short-circuits the scan. */
function reorderPicked(providers: readonly AcpProvider[], picked: string): readonly AcpProvider[] {
  const hit = providers.find((p) => p.id === picked);
  return hit ? [hit, ...providers.filter((p) => p !== hit)] : providers;
}

// The bridge (bridge.ts) owns per-run resolution: at the start of each run it calls
// pickAcpProvider(providers, ctx) and lazily initializes and caches one fully-started client per
// provider, pointing its active acpClient/acpSessionId at the resolved provider's client.
