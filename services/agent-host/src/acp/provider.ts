/**
 * ACP provider selection — a capability-tagged registry of AcpProviders resolved PER RUN.
 *
 * Today the bridge picks its ACP client ONCE (a static `usingClaude ? sdk : goose` branch in
 * makeBridge, memoized for the conversation's life). This generalizes that into a registry of
 * providers, each declaring whether it can serve a given run (`eligible(ctx)`) + a priority; a
 * resolver picks the highest-priority eligible provider PER PROMPT. `source` is a per-prompt
 * property, so the choice must be per-run: a conversation can use a personalized (remote) brain
 * for a human trigger and the cloud brain for a scheduled one.
 *
 * Increment 1 ports the existing sdk + goose branches onto two providers with disjoint
 * eligibility (only one is eligible under today's config), so the resolver picks the SAME client
 * the old branch did — behavior-identical. Increment 2 adds a `remote-personalized` provider whose
 * eligibility encodes the human-trigger guardrail. See todo/docs/BYO_CLAUDE_REMOTE_AGENT.md.
 */

import type { AcpClient } from "./client.js";
import type { SessionId } from "../types.js";

/** The per-run context a provider's `eligible()` decides on. Assembled by the bridge at the start
 *  of each run from the conversation + the incoming prompt. */
export interface RunContext {
  /** The conversation id (== bridge sessionId). */
  conversationId: SessionId;
  /** The conversation OWNER (the Scooter user), or undefined for an unowned/anonymous conv.
   *  Used by an owner-bound provider (e.g. the remote personalized agent). */
  owner?: string;
  /** The TRIGGER source of this run: "ui" (interactive), "slack"|"github"|"gitlab" (@mention),
   *  "scheduler" (cron), "webhook", "nudge", … — the same tag threaded through the prompt path
   *  (agui/server.ts → manager.prompt → bridge). Undefined = a plain interactive prompt (human).
   *  The human-trigger guardrail (Increment 2) keys on this. */
  source?: string;
  /** The resolved model for this run (a provider may only serve certain models). */
  model?: string;
}

/** One selectable ACP backend (goose/bedrock, in-process claude SDK, a remote personalized agent).
 *  Providers are pure declarations of capability + a factory; the resolver + BridgeAcpManager own
 *  selection + lifecycle. */
export interface AcpProvider {
  /** Stable id for logging/metrics + as the BridgeAcpManager cache key (one client per provider
   *  per conversation). e.g. "bedrock-goose" | "sdk-claude" | "remote-personalized". */
  readonly id: string;
  /** Recording/telemetry label — maps to the bridge's `provider` ("goose" | "claude"). */
  readonly kind: "goose" | "claude";
  /** Higher wins among eligible providers. The always-eligible floor (bedrock/goose) is lowest. */
  readonly priority: number;
  /** May this provider serve THIS run? Pure + synchronous (no I/O) — it's called on every run.
   *  The floor provider returns true unconditionally so the resolver always terminates. */
  eligible(ctx: RunContext): boolean;
  /** Build the AcpClient for a run this provider serves. The bridge calls this at most once per
   *  conversation (it caches + lifecycle-manages the result per provider), so it need not memoize. */
  createClient(ctx: RunContext): Promise<AcpClient> | AcpClient;
}

/** Pick the ACP provider for a run: the highest-priority ELIGIBLE provider. Deterministic
 *  tie-break by id (stable across runs). Returns undefined ONLY if NO provider is eligible —
 *  callers must include an always-eligible floor (bedrock/goose) so this never happens in prod;
 *  it's `undefined`-typed so a misconfigured registry fails loud rather than silently mis-routing. */
export function pickAcpProvider(providers: readonly AcpProvider[], ctx: RunContext): AcpProvider | undefined {
  let best: AcpProvider | undefined;
  for (const p of providers) {
    if (!p.eligible(ctx)) continue;
    if (best === undefined || p.priority > best.priority || (p.priority === best.priority && p.id < best.id)) {
      best = p;
    }
  }
  return best;
}

// The bridge (bridge.ts) owns per-run resolution: at the start of each run it calls
// pickAcpProvider(providers, ctx) and lazily initializes + caches ONE fully-started client per
// provider (initialize → newSession → wire hooks, once), pointing its active acpClient/acpSessionId
// at the resolved provider's client. Under Increment-1 config a single provider is eligible, so the
// choice is stable — behavior-identical to the old single-client bridge. Increment 2 adds a remote
// provider whose eligible() encodes the human-trigger guardrail.
