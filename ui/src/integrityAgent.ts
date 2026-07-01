/**
 * IntegrityAgent — an @ag-ui/client AbstractAgent whose RENDER source is the
 * agent-host's integrity stream, not /agui.
 *
 * WHY: to see a conversation live regardless of WHO drove the run (this tab, a
 * webhook/Slack, another tab), the open view must render from the single ordered
 * per-conversation event log the server persists — GET /conversations/:id/
 * events.integrity — which carries EVERY run's events. assistant-ui renders
 * whatever an AbstractAgent produces, so we subclass it: `run()` returns a
 * CONTINUOUS Observable of the log's events (mapped from the checksum envelope),
 * and the base-class applier folds them into `messages` with FULL FIDELITY (text,
 * tool calls, reasoning) — the identical rendering path as a locally-driven run,
 * with no second reducer.
 *
 * Sends do NOT go through the render source. A prompt is a fire-and-forget
 * POST /agui (the server drives the run regardless of SSE consumption); the reply
 * re-enters through the same continuous integrity subscription. One writer → no
 * two-writers race. Interrupts ride the log's RUN_FINISHED(outcome=interrupt) and
 * are answered by a POST /agui with resume[] (see submitResume).
 *
 * Design stage: SIGNATURES ONLY. No bodies.
 */

import { AbstractAgent, type RunAgentInput } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/core";
import type { Observable } from "rxjs";

import type { AgentHostConfig } from "./client.js";

export interface IntegrityAgentConfig extends AgentHostConfig {
  /** The conversation/thread this agent renders + sends to. */
  conversationId: string;
  /** Per-conversation model, sent as the X-Agent-Model header on POST /agui. */
  model?: string;
}

/** A resume answer to a pending interrupt (permission/option choice). */
export interface ResumeEntry {
  interruptId: string;
  status: "resolved" | "cancelled";
  payload?: unknown;
}

export declare class IntegrityAgent extends AbstractAgent {
  constructor(config: IntegrityAgentConfig);

  /**
   * The RENDER source: a CONTINUOUS Observable of the conversation's events,
   * sourced from GET /conversations/:id/events.integrity. Strips the checksum
   * envelope and maps each inner event to its @ag-ui/core BaseEvent. Does NOT
   * complete while the stream is open (so the runtime keeps rendering live).
   * Resilient: on a checksum gap, refetch /history and resync (reuse the parser
   * + self-heal in integrityStream.ts). `input` is ignored — the log is the
   * source of truth, not a per-run request.
   */
  run(input: RunAgentInput): Observable<BaseEvent>;

  /**
   * Send a prompt as a FIRE-AND-FORGET POST /agui (threadId = conversationId,
   * X-Agent-Model header from config.model). Does NOT read the response SSE —
   * the reply comes back via `run()`'s integrity subscription. Resolves once the
   * POST is accepted (not when the run finishes).
   */
  send(text: string): Promise<void>;

  /**
   * Answer pending interrupt(s): POST /agui with { resume: [...] } (the existing
   * resume path). The continued run streams back through the integrity source.
   */
  submitResume(entries: readonly ResumeEntry[]): Promise<void>;

  /** Close the integrity subscription and release resources. */
  dispose(): void;

  clone(): IntegrityAgent;
}

/** Construct an IntegrityAgent bound to a conversation on the agent-host. */
export declare function createIntegrityAgent(config: IntegrityAgentConfig): IntegrityAgent;
