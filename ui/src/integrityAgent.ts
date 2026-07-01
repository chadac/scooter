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
import { Observable, type Subscription, defer, repeat, catchError, EMPTY } from "rxjs";

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

/** Result of reading one integrity SSE connection to completion. */
type ConnectionOutcome = "not-found" | "closed" | "error";

export class IntegrityAgent extends AbstractAgent {
  private readonly cfg: IntegrityAgentConfig;
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  /** Abort controllers for the live render subscription(s), aborted on dispose. */
  private readonly controllers = new Set<AbortController>();
  /** The single render-pump subscription (see renderPump), torn down on dispose. */
  private pumpSub?: Subscription;

  constructor(config: IntegrityAgentConfig) {
    super({ threadId: config.conversationId });
    this.cfg = config;
    this.base = config.baseUrl.replace(/\/$/, "");
    // Bind to globalThis: an unbound `fetch` reference invoked as `this.doFetch(...)`
    // throws "Illegal invocation" in the browser (fetch needs its Window/global as
    // receiver). Tests inject fetchImpl, so this only bites at runtime — which is
    // exactly why the render pump + send silently no-op'd in the UI while unit
    // tests stayed green.
    this.doFetch = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
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

    // A CONTINUOUS cold Observable: one SSE connection, reconnecting on drop and
    // re-replaying the full log each time. Kept for the run() contract (a caller
    // reading events off a single connection). The render pump does NOT subscribe
    // to this directly — a reconnect re-replays every event, and the base applier
    // would then DOUBLE-APPLY the replay into the SAME accumulator (doubling
    // tool-call args like '{"cmd":"ls"}{"cmd":"ls"}' and duplicating messages —
    // the page-refresh replay bug). The pump instead folds each connection fresh;
    // see renderPump / connectionEvents.
    return new Observable<BaseEvent>((subscriber) => {
      const controller = new AbortController();
      this.controllers.add(controller);
      let closed = false;
      const loop = async () => {
        let notFoundDelay = 500;
        while (!closed) {
          const outcome = await this.readConnection(url, headers, controller, (e) =>
            subscriber.next(e),
          );
          if (outcome === "not-found") {
            await delay(notFoundDelay);
            notFoundDelay = Math.min(notFoundDelay * 2, 5000);
          } else {
            notFoundDelay = 500;
            if (!closed) await delay(500);
          }
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
   * One SSE CONNECTION as a self-completing Observable: opens the integrity
   * stream, emits each frame's inner BaseEvent, and COMPLETES when that stream
   * ends (or errors). Unlike run(), it does NOT reconnect — reconnection is the
   * pump's job (renderPump), so each connection can be folded from a fresh,
   * empty message accumulator and the full-log replay rebuilds identical state
   * instead of doubling it.
   */
  private connectionEvents(): Observable<BaseEvent> {
    const url = `${this.base}/conversations/${encodeURIComponent(this.cfg.conversationId)}/events.integrity`;
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      ...(this.cfg.token ? { Authorization: `Bearer ${this.cfg.token}` } : {}),
    };
    return new Observable<BaseEvent>((subscriber) => {
      const controller = new AbortController();
      this.controllers.add(controller);
      let closed = false;
      void (async () => {
        await this.readConnection(url, headers, controller, (e) => subscriber.next(e));
        if (!closed) subscriber.complete();
      })();
      return () => {
        closed = true;
        controller.abort();
        this.controllers.delete(controller);
      };
    });
  }

  /**
   * Read a single integrity SSE connection to completion, invoking `onEvent` for
   * each inner BaseEvent. Returns "not-found" (conversation not yet created — the
   * caller should back off), "closed" (stream ended normally), or "error".
   */
  private async readConnection(
    url: string,
    headers: Record<string, string>,
    controller: AbortController,
    onEvent: (e: BaseEvent) => void,
  ): Promise<ConnectionOutcome> {
    try {
      const res = await this.doFetch(url, { headers, signal: controller.signal });
      if (res.status === 404) return "not-found"; // created on first prompt
      if (!res.ok || !res.body) return "error";
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
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
            onEvent(frame.event as unknown as BaseEvent);
          }
        }
      }
      return "closed";
    } catch {
      return "error"; // network drop / abort
    }
  }

  /**
   * The RENDER PUMP. Folds the integrity stream into `messages` with FULL FIDELITY
   * using the base-class applier, but with EXACTLY ONE subscription per SSE
   * connection — so every event is applied ONCE.
   *
   * TWO duplication traps this avoids:
   *
   *   1. AbstractAgent.runAgent subscribes to run() TWICE per run (sequential
   *      connect + apply passes; refCount drops to 0 between them, so share()
   *      cannot collapse them) — two streams, every event folded twice. We do NOT
   *      use runAgent; we drive the protected `apply` + `processApplyEvents` (the
   *      same fold runAgent uses) over ONE connection Observable ourselves.
   *
   *   2. The integrity stream REPLAYS the full log on every (re)connect. A single
   *      long-lived subscription that reconnects would replay every event again
   *      into the SAME applier accumulator — doubling tool-call args
   *      ('{"cmd":"ls"}{"cmd":"ls"}') and duplicating messages (the page-refresh
   *      replay bug). So each connection gets its OWN fold seeded from an EMPTY
   *      message list (setMessages([]) before starting), and repeat({delay})
   *      reconnects ONLY after the current connection completes — one fetch in
   *      flight at a time. A reconnect thus rebuilds identical state from the
   *      replay instead of appending to it.
   *
   * `processApplyEvents` writes `this.messages` and fires each subscriber's
   * onMessagesChanged, so callers keep observing via `subscribe({...})` as before.
   * Returns a teardown; also torn down by dispose().
   */
  renderPump(): () => void {
    const input = this.prepareRunAgentInput();
    // One fold per connection, deferred so each (re)subscription opens a FRESH SSE
    // connection seeded from an EMPTY message list — the full-log replay rebuilds
    // identical state rather than doubling onto the previous fold. repeat({delay})
    // reconnects ONLY after the current connection completes (its stream ended),
    // so exactly one fetch is in flight at a time and a completed stream backs off
    // before re-replaying. catchError keeps a mid-fold error from killing the pump.
    const fold$ = defer(() => {
      this.setMessages([]);
      const conn$ = this.connectionEvents();
      return this.processApplyEvents(
        input,
        this.apply(input, conn$, this.subscribers),
        this.subscribers,
      ).pipe(catchError(() => EMPTY));
    }).pipe(repeat({ delay: 500 }));

    this.pumpSub?.unsubscribe();
    this.pumpSub = fold$.subscribe({ error: () => {} });
    return () => {
      this.pumpSub?.unsubscribe();
      this.pumpSub = undefined;
    };
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
    this.pumpSub?.unsubscribe();
    this.pumpSub = undefined;
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
