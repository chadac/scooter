/**
 * IntegrityAgent — an @ag-ui/client AbstractAgent whose RENDER source is the
 * agent-host's integrity stream, not /agui.
 *
 * WHY: to see a conversation live regardless of WHO drove the run (this tab, a
 * webhook/Slack, another tab), the open view must render from the single ordered
 * per-conversation event log the server persists — GET /conversations/:id/
 * events.integrity — which carries EVERY run's events. assistant-ui renders
 * whatever an AbstractAgent produces, so we subclass it: `run()` returns a
 * CONTINUOUS Observable of the log's events, and the base-class applier folds
 * them into `messages` with FULL FIDELITY (text, tool calls, reasoning) — the
 * identical rendering path as a locally-driven run, with no second reducer.
 *
 * The integrity stream's inner events ARE @ag-ui/core BaseEvents already (the
 * bridge emits them; agui/server just encodes them). So mapping the envelope to a
 * BaseEvent is: strip the checksum wrapper, take `frame.event`. No field remap.
 *
 * Sends do NOT go through the render source. A prompt is a fire-and-forget
 * POST /agui (the server drives the run regardless of SSE consumption); the reply
 * re-enters through the same continuous integrity subscription. One writer → no
 * two-writers race. Interrupts ride the log's RUN_FINISHED(outcome=interrupt) and
 * are answered by a POST /agui with resume[] (see submitResume).
 */

import { AbstractAgent, type RunAgentInput } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/core";
import { Observable } from "rxjs";

import type { AgentHostConfig } from "./client.js";

export interface IntegrityAgentConfig extends AgentHostConfig {
  /** The conversation/thread this agent renders + sends to. */
  conversationId: string;
  /** Per-conversation model, sent as the X-Agent-Model header on POST /agui. */
  model?: string;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
}

/** A resume answer to a pending interrupt (permission/option choice). */
export interface ResumeEntry {
  interruptId: string;
  status: "resolved" | "cancelled";
  payload?: unknown;
}

interface IntegrityFrame {
  kind: "event" | "synced";
  event?: Record<string, unknown>;
}

export class IntegrityAgent extends AbstractAgent {
  private readonly cfg: IntegrityAgentConfig;
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  /** Abort controllers for the live render subscription(s), aborted on dispose. */
  private readonly controllers = new Set<AbortController>();

  constructor(config: IntegrityAgentConfig) {
    super({ threadId: config.conversationId });
    this.cfg = config;
    this.base = config.baseUrl.replace(/\/$/, "");
    this.doFetch = config.fetchImpl ?? fetch;
  }

  /**
   * The RENDER source: a CONTINUOUS Observable of the conversation's events from
   * GET /conversations/:id/events.integrity. Emits each frame's inner event
   * (already a BaseEvent) and does NOT complete while the stream is open, so the
   * runtime keeps rendering live. `input` is ignored — the log is the source of
   * truth, not a per-run request. Reconnects on drop.
   */
  run(_input: RunAgentInput): Observable<BaseEvent> {
    const url = `${this.base}/conversations/${encodeURIComponent(this.cfg.conversationId)}/events.integrity`;
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      ...(this.cfg.token ? { Authorization: `Bearer ${this.cfg.token}` } : {}),
    };

    return new Observable<BaseEvent>((subscriber) => {
      let closed = false;
      const controller = new AbortController();
      this.controllers.add(controller);

      const loop = async () => {
        let notFoundDelay = 500;
        while (!closed) {
          try {
            const res = await this.doFetch(url, { headers, signal: controller.signal });
            if (res.status === 404) {
              // The conversation is created server-side on the first prompt; a
              // brand-new thread 404s until then. Back off and retry.
              await delay(notFoundDelay);
              notFoundDelay = Math.min(notFoundDelay * 2, 5000);
              continue;
            }
            notFoundDelay = 500;
            if (!res.ok || !res.body) {
              await delay(1000);
              continue;
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = "";
            while (!closed) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              let idx: number;
              while ((idx = buf.indexOf("\n\n")) !== -1) {
                const raw = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                const line = raw.split("\n").find((l) => l.startsWith("data:"));
                if (!line) continue;
                let frame: IntegrityFrame;
                try {
                  frame = JSON.parse(line.slice(5).trim()) as IntegrityFrame;
                } catch {
                  continue; // skip a malformed frame, keep the stream alive
                }
                // `synced` is a replay-complete marker with no event; skip it.
                if (frame.kind === "event" && frame.event) {
                  subscriber.next(frame.event as unknown as BaseEvent);
                }
              }
            }
          } catch {
            /* network drop / abort — reconnect (a fresh stream re-replays) */
          }
          if (!closed) await delay(500);
        }
      };
      void loop();

      return () => {
        closed = true;
        controller.abort();
        this.controllers.delete(controller);
      };
    });
  }

  /**
   * Send a prompt as a FIRE-AND-FORGET POST /agui (threadId = conversationId,
   * X-Agent-Model header from config.model). Does NOT read the response SSE — the
   * reply comes back via `run()`'s integrity subscription. Resolves once the POST
   * is accepted (not when the run finishes).
   */
  async send(text: string): Promise<void> {
    await this.postAgui({
      threadId: this.cfg.conversationId,
      runId: `send-${this.cfg.conversationId}-${text.length}`,
      messages: [{ id: `u-${text.length}`, role: "user", content: text }],
    });
  }

  /**
   * Answer pending interrupt(s): POST /agui with { resume: [...] } (the existing
   * resume path). The continued run streams back through the integrity source.
   */
  async submitResume(entries: readonly ResumeEntry[]): Promise<void> {
    await this.postAgui({ threadId: this.cfg.conversationId, resume: [...entries] });
  }

  /** Fire-and-forget POST /agui; deliberately does NOT consume the response body. */
  private async postAgui(body: Record<string, unknown>): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(this.cfg.token ? { Authorization: `Bearer ${this.cfg.token}` } : {}),
      ...(this.cfg.model ? { "X-Agent-Model": this.cfg.model } : {}),
    };
    // Do not await/read the SSE stream — the run drives server-side and its
    // events return via the integrity subscription. We only ensure the POST is
    // accepted; drop the body.
    await this.doFetch(`${this.base}/agui`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }).catch(() => {
      /* the integrity stream is the source of truth; a failed POST surfaces there
         (no RUN_STARTED) rather than here. Best-effort. */
    });
  }

  /** Close all live integrity subscriptions and release resources. */
  dispose(): void {
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
  }

  clone(): IntegrityAgent {
    return new IntegrityAgent(this.cfg);
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Construct an IntegrityAgent bound to a conversation on the agent-host. */
export function createIntegrityAgent(config: IntegrityAgentConfig): IntegrityAgent {
  return new IntegrityAgent(config);
}
