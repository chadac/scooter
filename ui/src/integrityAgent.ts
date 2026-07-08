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
import { Observable, Subject, type Subscription, catchError, EMPTY } from "rxjs";

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

/** A pending interrupt parsed from the log's RUN_FINISHED(outcome=interrupt).
 *  Shape mirrors the bridge's AguiInterrupt (id/reason/message + metadata.options),
 *  which assistant-ui's runtime stores under an assistant message's
 *  metadata.custom.agui.interrupts. */
export interface PendingInterrupt {
  id: string;
  reason: string;
  message?: string;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
}

/** Result of reading one integrity SSE connection to completion. */
type ConnectionOutcome = "not-found" | "closed" | "error";

export class IntegrityAgent extends AbstractAgent {
  private readonly cfg: IntegrityAgentConfig;
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  /** Abort controllers for the live render subscription(s), aborted on dispose. */
  private readonly controllers = new Set<AbortController>();
  /** Stops the render-pump reconnect loop (see renderPump), called on dispose. */
  private stopPump?: () => void;
  /** The interrupt(s) the current run is paused on, parsed from the log's
   *  RUN_FINISHED(outcome=interrupt). Cleared when a new RUN_STARTED arrives (the
   *  run resumed) or when the log is re-seeded. The base AbstractAgent applier does
   *  NOT track interrupts (only the react-ag-ui runtime's own aggregator does, and
   *  we bypass it), so the pump surfaces them here for RuntimeProvider to fold into
   *  the trailing assistant message's status/metadata. */
  private logInterrupts: PendingInterrupt[] = [];

  /** EXTERNAL interrupts (e.g. a broker AWS approval) raised OUT OF BAND via
   *  raiseInterrupt — they ride a RUN_FINISHED with runId "ext-<id>" that is NOT
   *  tied to the goose run. A concurrent goose run's RUN_STARTED/RUN_FINISHED must
   *  NOT clear these (that was the "AWS request vanishes on reload" bug); they are
   *  settled only by a matching PERMISSION_RESOLVED. Keyed by interrupt id. */
  private externalInterrupts = new Map<string, PendingInterrupt>();

  /** True while a connection is REPLAYING the persisted log (before its `synced`
   *  marker). The render pump suppresses per-event thread updates during replay so
   *  a long history paints in ONE shot (landing at the latest message) instead of
   *  visibly building top-down. Flips false at `synced`, then live events render
   *  per-event as usual. */
  private replaying = false;
  isReplaying(): boolean {
    return this.replaying;
  }

  /** True while a goose RUN is in flight (a real turn — NOT an out-of-band `ext-`
   *  interrupt run). Derived from the log: RUN_STARTED -> true, RUN_FINISHED /
   *  RUN_ERROR -> false. Drives the composer's Stop button + the thinking
   *  indicator. `ext-*` runs (broker interrupts) are ignored — they don't mean the
   *  agent is thinking. */
  private running = false;
  runIsActive(): boolean {
    return this.running;
  }

  /** Update `running` from a single log event, ignoring out-of-band `ext-` runs.
   *  Returns true if the value changed (so the caller can nudge subscribers). */
  private trackRunning(e: BaseEvent): boolean {
    const ev = e as unknown as { type?: string; runId?: string };
    const isExt = typeof ev.runId === "string" && ev.runId.startsWith("ext-");
    let next = this.running;
    if (ev.type === "RUN_STARTED" && !isExt) next = true;
    else if ((ev.type === "RUN_FINISHED" || ev.type === "RUN_ERROR") && !isExt) next = false;
    if (next === this.running) return false;
    this.running = next;
    return true;
  }

  /** The interrupt(s) the conversation is currently paused on (empty if none) —
   *  the run-scoped set PLUS any still-open external (broker) interrupts. */
  getPendingInterrupts(): readonly PendingInterrupt[] {
    if (this.externalInterrupts.size === 0) return this.logInterrupts;
    return [...this.logInterrupts, ...this.externalInterrupts.values()];
  }

  /** Update pendingInterrupts from a single log event:
   *   - RUN_STARTED clears the RUN-SCOPED set (a new turn began);
   *   - RUN_FINISHED(interrupt) with runId "ext-*" ADDS an external interrupt
   *     (survives concurrent runs); a normal RUN_FINISHED(interrupt) sets the
   *     run-scoped set; a normal RUN_FINISHED without interrupt clears it;
   *   - PERMISSION_RESOLVED settles an external interrupt by id.
   *  External interrupts are cleared ONLY by PERMISSION_RESOLVED — never by run
   *  boundaries — so a still-pending broker request replays after a reload. */
  private trackInterrupt(e: BaseEvent): void {
    const ev = e as unknown as {
      type?: string;
      runId?: string;
      toolCallId?: string;
      optionId?: string | null;
      outcome?: { type?: string; interrupts?: PendingInterrupt[] };
    };
    const before = this.getPendingInterrupts().length;
    if (ev.type === "PERMISSION_RESOLVED") {
      if (ev.toolCallId && this.externalInterrupts.delete(ev.toolCallId)) {
        // fall through to the change-nudge below
      } else {
        return;
      }
    } else if (ev.type === "RUN_STARTED") {
      this.logInterrupts = [];
    } else if (ev.type === "RUN_FINISHED") {
      const interrupts =
        ev.outcome?.type === "interrupt" && Array.isArray(ev.outcome.interrupts)
          ? ev.outcome.interrupts
          : [];
      if (typeof ev.runId === "string" && ev.runId.startsWith("ext-")) {
        // Out-of-band external interrupt: add (don't replace the run-scoped set).
        for (const it of interrupts) this.externalInterrupts.set(it.id, it);
      } else {
        this.logInterrupts = interrupts;
      }
    } else {
      return;
    }
    // A RUN_FINISHED(interrupt) usually produces NO message change through the base
    // applier (empty state => no AgentStateMessage), so the render subscribers
    // wouldn't otherwise refresh to show the interrupt. Nudge them when the pending
    // set actually changes so RuntimeProvider re-folds + surfaces (or clears) it.
    if (before !== this.getPendingInterrupts().length) this.notifyMessages();
  }

  /** Fire onMessagesChanged on every subscriber with the current snapshot. Used to
   *  nudge the render pump for changes the base applier doesn't itself signal
   *  (interrupt set changes, and the once-per-replay `synced` render). */
  private notifyMessages(): void {
    for (const s of this.subscribers) {
      s.onMessagesChanged?.({ messages: this.messages, state: this.state, agent: this } as never);
    }
  }

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
   * Update the per-conversation model IN PLACE (the X-Agent-Model header on the
   * next send). The model does NOT affect the render source (the integrity stream
   * carries the same events regardless), so switching it must NOT tear down the
   * agent / render pump — the caller keeps the SAME agent instance and just calls
   * this. (Recreating the agent on a model switch races the next send's events in
   * a slow environment and drops the reply — the model-switch-mid-conversation
   * bug.)
   */
  setModel(model?: string): void {
    this.cfg.model = model;
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
    // the page-refresh replay bug). The pump instead runs its OWN reconnect loop
    // that re-seeds the accumulator per physical connection; see renderPump.
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
   * Read a single integrity SSE connection to completion, invoking `onEvent` for
   * each inner BaseEvent. Returns "not-found" (conversation not yet created — the
   * caller should back off), "closed" (stream ended normally), or "error".
   */
  private async readConnection(
    url: string,
    headers: Record<string, string>,
    controller: AbortController,
    onEvent: (e: BaseEvent) => void,
    onSynced?: () => void,
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
          // `synced` marks replay-complete (no event) → the pump can render once
          // now and go live per-event; before it, we're still replaying history.
          if (frame.kind === "synced") {
            onSynced?.();
          } else if (frame.kind === "event" && frame.event) {
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
   *   2. The integrity stream REPLAYS the full log on every (re)connect. Folding
   *      every reconnect's replay into the SAME applier accumulator would double
   *      tool-call args ('{"cmd":"ls"}{"cmd":"ls"}') and duplicate messages (the
   *      page-refresh replay bug). So each PHYSICAL connection gets its OWN fold,
   *      seeded from an EMPTY message list (setMessages([]) before starting), and
   *      the replay rebuilds identical state instead of appending to it.
   *
   * `processApplyEvents` writes `this.messages` and fires each subscriber's
   * onMessagesChanged, so callers keep observing via `subscribe({...})` as before.
   * Returns a teardown; also torn down by dispose().
   *
   * ONE LONG-LIVED CONNECTION, reconnect only on a real DROP. The server holds the
   * integrity stream open indefinitely (it forwards live appends), so a healthy
   * connection NEVER completes — the fold subscription over it stays live for the
   * whole conversation and applies each event exactly once as it arrives.
   *
   * The earlier design deferred a fresh fold per connection and drove reconnection
   * with rxjs `repeat({delay})`. But `processApplyEvents(apply(conn$))` completes
   * when its SOURCE conn$ completes, and rxjs `repeat` — on that completion —
   * unsubscribes the (still-open) connection and re-subscribes after the delay. The
   * result was a ~500ms teardown/re-replay churn on an OPEN stream: every reconnect
   * did setMessages([]) then re-folded the log from empty, and a reconnect that
   * raced a mid-run append (e.g. the SECOND turn's reply) rebuilt state from a log
   * snapshot that did not yet contain those in-flight events — dropping the reply
   * (observed: users=2, assistants=1). So we do NOT use repeat. We run our own
   * reconnect loop that seeds setMessages([]) ONCE per PHYSICAL connection and only
   * loops when readConnection actually returns (drop / 404 backoff) — the fresh
   * fold that guards the double-apply replay bug still happens on every real
   * (re)connect, just never on a healthy open stream.
   */
  renderPump(): () => void {
    const input = this.prepareRunAgentInput();
    const url = `${this.base}/conversations/${encodeURIComponent(this.cfg.conversationId)}/events.integrity`;
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      ...(this.cfg.token ? { Authorization: `Bearer ${this.cfg.token}` } : {}),
    };

    let closed = false;
    let connSub: Subscription | undefined;
    let controller: AbortController | undefined;

    const loop = async () => {
      let notFoundDelay = 500;
      while (!closed) {
        // Fresh fold per PHYSICAL connection: reset to empty so the full-log
        // replay rebuilds identical state rather than doubling onto the previous
        // connection's fold (the page-refresh double-apply bug). A `Subject`
        // carries this connection's events into ONE apply/processApplyEvents
        // subscription; it completes only when the connection actually ends.
        this.setMessages([]);
        // A fresh connection re-replays the whole log; recompute pending interrupts
        // from scratch too. Run-scoped ones derive from the trailing RUN_FINISHED;
        // external (broker) ones are rebuilt as their ext- RUN_FINISHED and any
        // settling PERMISSION_RESOLVED replay in order — so a still-open request
        // survives the reload, and a resolved one stays gone.
        this.logInterrupts = [];
        this.externalInterrupts.clear();
        // Entering (re)replay: suppress per-event renders until `synced`.
        this.replaying = true;
        controller = new AbortController();
        this.controllers.add(controller);
        const events$ = new Subject<BaseEvent>();
        // The applier's fold is async (concatMap over the event stream); it drains
        // buffered events even after the source completes. Track that completion so
        // we DON'T tear the fold down mid-flight (which would drop the tail of the
        // replay and leave `messages` empty/partial — the failure this guards).
        const folded = new Promise<void>((resolve) => {
          connSub = this.processApplyEvents(
            input,
            this.apply(input, events$, this.subscribers),
            this.subscribers,
          )
            .pipe(catchError(() => EMPTY))
            .subscribe({ error: () => resolve(), complete: () => resolve() });
        });

        const outcome = await this.readConnection(
          url,
          headers,
          controller,
          (e) => {
            // Track the pending interrupt as it rides the log: a RUN_STARTED means the
            // (resumed) run is live again — clear any pending; a RUN_FINISHED with an
            // interrupt outcome pauses the run awaiting a user answer. The base
            // applier ignores this, so we surface it via getPendingInterrupts().
            this.trackInterrupt(e);
            // Track run-in-flight for the Stop button / thinking indicator. The
            // base applier doesn't signal this, so nudge subscribers on a change
            // (suppressed during replay — the final `synced` render carries it).
            if (this.trackRunning(e) && !this.replaying) this.notifyMessages();
            events$.next(e);
          },
          () => {
            // Replay complete: the whole history is folded. Flip out of replay and
            // render once — but the base applier's fold is async, so wait a macrotask
            // for its buffered per-event notifications to drain FIRST (they observe
            // isReplaying()===true and are suppressed), then flip + render the final
            // history in one shot. A macrotask (not microtask) clears the concatMap
            // fold queue reliably.
            setTimeout(() => {
              this.replaying = false;
              this.notifyMessages();
            }, 0);
          },
        );
        // The connection ended — signal end-of-events and WAIT for the fold to
        // finish applying everything buffered before deciding whether to reconnect.
        events$.complete();
        await folded;
        connSub?.unsubscribe();
        connSub = undefined;
        this.controllers.delete(controller);
        controller = undefined;
        if (closed) break;

        if (outcome === "not-found") {
          // Conversation not created yet — back off with exponential delay.
          await delay(notFoundDelay);
          notFoundDelay = Math.min(notFoundDelay * 2, 5000);
        } else {
          // A real drop/error: brief pause, then reconnect + re-replay.
          notFoundDelay = 500;
          if (!closed) await delay(500);
        }
      }
    };

    const stop = () => {
      closed = true;
      controller?.abort();
      connSub?.unsubscribe();
      if (this.stopPump === stop) this.stopPump = undefined;
    };
    this.stopPump?.();
    this.stopPump = stop;
    // FAST FIRST PAINT: fetch the recent tail and fold it now, so a long
    // conversation shows its latest context immediately instead of waiting for the
    // whole integrity log to stream. The loop below then re-folds the full log from
    // empty and reconciles (identical fidelity — the tail used the same applier).
    void this.seedTail().finally(() => { if (!closed) void loop(); });
    return stop;
  }

  /** Fetch the last N runs of the log (GET …/tail) and fold them into
   *  `agent.messages` via the SAME base applier, then notify — a fast, faithful
   *  first paint before the full replay. Best-effort: any failure just skips the
   *  seed and the full replay paints as before. */
  private async seedTail(runs = 8): Promise<void> {
    try {
      const url = `${this.base}/conversations/${encodeURIComponent(this.cfg.conversationId)}/tail?runs=${runs}`;
      const res = await this.doFetch(url, {
        headers: this.cfg.token ? { Authorization: `Bearer ${this.cfg.token}` } : undefined,
      });
      if (!res.ok) return;
      const body = (await res.json()) as { events?: BaseEvent[] };
      const events = body.events ?? [];
      if (events.length === 0) return;
      // Fold the tail in a THROWAWAY clone first, so a fold that yields nothing
      // renderable (e.g. the tail's final run is still in-flight — no RUN_FINISHED —
      // so the base applier produces no message state) can't blank the real thread.
      // Adopt + paint only if the fold actually produced messages.
      const folded = await this.foldTail(events);
      if (folded.length === 0) return; // nothing renderable → let the full replay paint
      this.setMessages(folded as never);
      this.notifyMessages();
    } catch {
      /* best-effort — the full replay will paint */
    }
  }

  /** Fold tail events into messages in a THROWAWAY clone (no effect on this
   *  agent's messages/subscribers). Returns the folded messages — possibly empty
   *  when the window has no complete, renderable run. */
  private async foldTail(events: BaseEvent[]): Promise<unknown[]> {
    const scratch = this.clone();
    scratch.setMessages([]);
    const tail$ = new Subject<BaseEvent>();
    const done = new Promise<void>((resolve) => {
      scratch
        .processApplyEvents(scratch.prepareRunAgentInput(), scratch.apply(scratch.prepareRunAgentInput(), tail$, []), [])
        .pipe(catchError(() => EMPTY))
        .subscribe({ error: () => resolve(), complete: () => resolve() });
    });
    for (const e of events) tail$.next(e);
    tail$.complete();
    await done;
    return scratch.messages as unknown[];
  }

  /**
   * Send a prompt as a FIRE-AND-FORGET POST /agui (threadId = conversationId,
   * X-Agent-Model header from config.model). Does NOT read the response SSE — the
   * reply comes back via `run()`'s integrity subscription. Resolves once the POST
   * is accepted (not when the run finishes).
   */
  async send(text: string, opts?: { priority?: number }): Promise<void> {
    await this.postAgui({
      threadId: this.cfg.conversationId,
      runId: `send-${this.cfg.conversationId}-${text.length}`,
      messages: [{ id: `u-${text.length}`, role: "user", content: text }],
      // When the user sends WHILE a run is active (a loop they want to interrupt),
      // the caller passes priority so the agent-host FORCE-INTERRUPTS the running
      // turn (bridge "thinking" policy — cancels at the next tool boundary). Without
      // it the message queues behind the never-ending turn and is never delivered
      // (the uninterruptible-polling-loop bug).
      ...(opts?.priority ? { priority: opts.priority } : {}),
    });
  }

  /**
   * Answer pending interrupt(s): POST /agui with { resume: [...] } (the existing
   * resume path). The continued run streams back through the integrity source.
   */
  async submitResume(entries: readonly ResumeEntry[]): Promise<void> {
    await this.postAgui({ threadId: this.cfg.conversationId, resume: [...entries] });
  }

  /** Stop the running turn — the composer's Stop button. POSTs the agent-host
   *  cancel endpoint, which ends the in-flight run (kills the active tool call,
   *  ACP session/cancel, emits RUN_FINISHED{cancelled}). The terminal event
   *  arrives via the integrity stream, so `running` flips false there — we don't
   *  optimistically clear it here. Best-effort: a failed cancel leaves the run as
   *  it was (the stream stays the source of truth). */
  async cancel(): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.cfg.token ? { Authorization: `Bearer ${this.cfg.token}` } : {}),
    };
    await this.doFetch(`${this.base}/conversations/${encodeURIComponent(this.cfg.conversationId)}/cancel`, {
      method: "POST",
      headers,
    }).catch(() => {
      /* best-effort; the integrity stream reflects the real run state */
    });
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
    this.stopPump?.();
    this.stopPump = undefined;
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
