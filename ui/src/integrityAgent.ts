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
  /** IDLE-WATCHDOG threshold (ms). If a run appears RUNNING but the stream has
   *  gone silent for this long, force a reconnect — the re-fold from the persisted
   *  log re-derives the correct state (healing a DROPPED live RUN_FINISHED /
   *  PERMISSION_RESOLVED that left the UI stuck "busy" — the "agent seems dead"
   *  class). Default 25s; small values in tests. 0 disables. See
   *  todo/docs/SSE_RESILIENCE.md. */
  idleReconnectMs?: number;
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

/** A stable empty-queue reference (so getQueuedMessages returns the SAME array
 *  each idle call — a fresh [] every render would defeat React memoization). */
const EMPTY_QUEUE: ReadonlyArray<{ id: string; text: string; priority: number }> = [];

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
  /** Wall-clock (ms) of the last frame received on the live stream — the
   *  idle-watchdog forces a reconnect if `running` is true but this hasn't moved
   *  for idleReconnectMs (a dropped terminal event left the UI stuck "busy"). */
  private lastActivityAt = Date.now();

  // The tool call currently in flight during the active run (its name, e.g. "bash"),
  // and the ts of the last RUN_STARTED — so the UI can show WHAT it's doing and for
  // how long (a bare pulsing dot doesn't reveal that it's stuck on a long tool call).
  private activeToolName: string | null = null;
  private runStartedAt: number | null = null;
  /** The in-flight tool call's name (e.g. "bash"), or null when the run is between
   *  tool calls / not running. */
  activeTool(): string | null {
    return this.running ? this.activeToolName : null;
  }
  /** Epoch ms of the current run's RUN_STARTED, or null when not running — lets the
   *  UI show elapsed time so a long silent tool call is visibly "still working". */
  runStartedAtMs(): number | null {
    return this.running ? this.runStartedAt : null;
  }

  /** Update `running` (+ the active tool name / run-start ts) from a single log
   *  event, ignoring out-of-band `ext-` runs. Returns true if anything the UI shows
   *  changed (so the caller can nudge subscribers). */
  private trackRunning(e: BaseEvent): boolean {
    const ev = e as unknown as { type?: string; runId?: string; ts?: number; toolCallName?: string };
    const isExt = typeof ev.runId === "string" && ev.runId.startsWith("ext-");
    if (isExt) return false;
    const before = { running: this.running, tool: this.activeToolName };
    if (ev.type === "RUN_STARTED") {
      this.running = true;
      this.runStartedAt = typeof ev.ts === "number" ? ev.ts : Date.now();
      this.activeToolName = null;
    } else if (ev.type === "RUN_FINISHED" || ev.type === "RUN_ERROR") {
      this.running = false;
      this.activeToolName = null;
      this.runStartedAt = null;
    } else if (ev.type === "TOOL_CALL_START") {
      // A tool is now executing — surface its name until it ends.
      this.activeToolName = typeof ev.toolCallName === "string" ? ev.toolCallName : "tool";
    } else if (ev.type === "TOOL_CALL_END") {
      this.activeToolName = null;
    }
    return this.running !== before.running || this.activeToolName !== before.tool;
  }

  // Context-window fill from the latest CONTEXT_USAGE event (used/total tokens), so
  // the UI can show a fill bar. Persisted + replayed, so it survives a refresh.
  private contextUsedTokens: number | null = null;
  private contextWindow: number | null = null;
  /** Context-fill fraction 0..1 (usedTokens / contextWindow), or null if unknown. */
  contextFill(): number | null {
    if (this.contextUsedTokens == null || !this.contextWindow) return null;
    return Math.min(1, this.contextUsedTokens / this.contextWindow);
  }
  /** {used, total} tokens for a tooltip, or null. */
  contextTokens(): { used: number; total: number } | null {
    if (this.contextUsedTokens == null || !this.contextWindow) return null;
    return { used: this.contextUsedTokens, total: this.contextWindow };
  }
  private trackContext(e: BaseEvent): boolean {
    const ev = e as unknown as { type?: string; usedTokens?: number; contextWindow?: number };
    if (ev.type !== "CONTEXT_USAGE") return false;
    const before = this.contextUsedTokens;
    if (typeof ev.usedTokens === "number") this.contextUsedTokens = ev.usedTokens;
    if (typeof ev.contextWindow === "number") this.contextWindow = ev.contextWindow;
    return this.contextUsedTokens !== before;
  }

  // SYSTEM messages (platform-injected: webhook events, scheduler fires, background-
  // job completions, broker errors). The @ag-ui applier ignores SYSTEM_MESSAGE
  // (bespoke), so we track them here — but they render INLINE in the thread at their
  // chronological position (as an auto-collapsed event chip, not a user bubble), so
  // each records `afterIndex`: the number of real messages folded BEFORE it arrived.
  // RuntimeProvider splices the chip into the message list at that index.
  private systemMessages: Array<{ id: string; source: string; text: string; afterMessageId: string | null }> = [];
  /** The id of the most recent REAL (user/assistant) message START seen in the raw
   *  event stream — the chronological anchor for a system message. Read from the raw
   *  stream (not the folded list) because the base applier's fold is async, so
   *  `this.messages` lags the events in a synchronous burst. */
  private lastMessageId: string | null = null;
  /** All system messages in the conversation, each with `afterMessageId` — the id of
   *  the real message it followed in the log (null = before any message) — so the UI
   *  can interleave it inline at the right spot. Deduped by messageId so a re-replay
   *  doesn't double them. */
  getSystemMessages(): ReadonlyArray<{ id: string; source: string; text: string; afterMessageId: string | null }> {
    return this.systemMessages;
  }
  private trackSystemMessage(e: BaseEvent): boolean {
    const ev = e as unknown as { type?: string; messageId?: string; source?: string; text?: string };
    // Every real message START advances the anchor (folded async, so we can't count
    // this.messages here). Only TEXT_MESSAGE_START creates a TOP-LEVEL folded message
    // with this id (tool calls nest INTO the preceding assistant message), so it's the
    // reliable anchor. A SYSTEM_MESSAGE then pins to whatever text message came last.
    if (ev.type === "TEXT_MESSAGE_START" && ev.messageId) {
      this.lastMessageId = ev.messageId;
      return false;
    }
    if (ev.type !== "SYSTEM_MESSAGE" || !ev.messageId) return false;
    if (this.systemMessages.some((m) => m.id === ev.messageId)) return false; // replay dedupe
    this.systemMessages.push({
      id: ev.messageId, source: ev.source ?? "system", text: ev.text ?? "",
      afterMessageId: this.lastMessageId,
    });
    return true;
  }

  /** The last RUN_ERROR's message (null if the current/last run didn't error).
   *  The base @ag-ui/client applier delegates RUN_ERROR to an `onRunErrorEvent`
   *  callback and appends NO message — so a failed run would otherwise just go
   *  silent (the spinner clears with no explanation). We track the message here so
   *  RuntimeProvider can surface it as a visible banner. This is the UI half of the
   *  hydrate-silent-drop fix (the server now EMITS + PERSISTS RUN_ERROR; this is
   *  what renders it). Cleared when a new (non-ext) RUN_STARTED begins. */
  private lastRunError: string | null = null;
  getRunError(): string | null {
    return this.lastRunError;
  }

  /** Update `lastRunError` from a single log event, ignoring out-of-band `ext-`
   *  runs (a broker interrupt isn't a run failure). Returns true if it changed. */
  private trackRunError(e: BaseEvent): boolean {
    const ev = e as unknown as { type?: string; runId?: string; message?: string };
    const isExt = typeof ev.runId === "string" && ev.runId.startsWith("ext-");
    if (isExt) return false;
    let next = this.lastRunError;
    if (ev.type === "RUN_STARTED") next = null; // a fresh run — clear the stale error
    else if (ev.type === "RUN_ERROR") next = ev.message ?? "The run failed.";
    if (next === this.lastRunError) return false;
    this.lastRunError = next;
    return true;
  }

  /** The messages currently QUEUED behind the active run (empty if none). The
   *  bridge run-queue lives server-side; it emits a QUEUE_UPDATED snapshot on the
   *  integrity stream whenever the queue changes, so a refreshing/reattaching UI
   *  re-derives the queue from the log instead of losing it (it used to be
   *  client-only and vanished on refresh). Latest-snapshot-wins. */
  private queued: ReadonlyArray<{ id: string; text: string; priority: number }> = [];
  getQueuedMessages(): ReadonlyArray<{ id: string; text: string; priority: number }> {
    // INVARIANT: the queue only holds items WHILE a run is draining them. If the
    // run is idle, there is nothing queued — regardless of the last QUEUE_UPDATED
    // we folded. This self-heals a MISSED clearing snapshot (QUEUE_UPDATED([]) that
    // never reached the live client after a run finished), which otherwise left a
    // phantom "message stuck in the queue" in the sidebar until a refresh.
    return this.running ? this.queued : EMPTY_QUEUE;
  }

  /** messageId -> its attached image refs (from MESSAGE_IMAGES). The base applier
   *  ignores that bespoke event, so we track it here and let the render pump enrich
   *  the folded user messages, so an image renders live + after a refresh. */
  private messageImages = new Map<string, Array<{ assetId: string; mimeType: string; url: string }>>();
  getMessageImages(messageId: string): Array<{ assetId: string; mimeType: string; url: string }> | undefined {
    return this.messageImages.get(messageId);
  }

  /** Record a MESSAGE_IMAGES event's refs keyed by its messageId. Returns true if
   *  it added anything (nudge subscribers to re-render with the image). */
  private trackImages(e: BaseEvent): boolean {
    const ev = e as unknown as { type?: string; messageId?: string; images?: Array<{ assetId: string; mimeType: string; url: string }> };
    if (ev.type !== "MESSAGE_IMAGES" || !ev.messageId || !ev.images?.length) return false;
    this.messageImages.set(ev.messageId, ev.images);
    return true;
  }

  /** Update `queued` from a QUEUE_UPDATED snapshot. Returns true if it changed
   *  (shallow: length or any id/text differs) so the caller can nudge subscribers. */
  private trackQueue(e: BaseEvent): boolean {
    const ev = e as unknown as { type?: string; items?: Array<{ id: string; text: string; priority: number }> };
    if (ev.type !== "QUEUE_UPDATED") return false;
    const next = ev.items ?? [];
    const same =
      next.length === this.queued.length &&
      next.every((it, i) => it.id === this.queued[i]?.id && it.text === this.queued[i]?.text);
    if (same) return false;
    this.queued = next;
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
      // Race each read against the abort signal: a STALLED body (a stream that
      // never emits and never closes — the "agent seems dead" wedge) must still be
      // abortable so the idle-watchdog can force a reconnect. A polyfilled/mock
      // ReadableStream may not honor the fetch signal itself, so we honor it here.
      const aborted = new Promise<{ aborted: true }>((resolve) => {
        if (controller.signal.aborted) return resolve({ aborted: true });
        controller.signal.addEventListener("abort", () => resolve({ aborted: true }), { once: true });
      });
      for (;;) {
        const r = await Promise.race([reader.read(), aborted]);
        if ("aborted" in r) {
          reader.cancel().catch(() => {});
          return "error";
        }
        const { value, done } = r;
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
    // Set by the idle-watchdog when IT forced the disconnect, so the loop reconnects
    // IMMEDIATELY (skipping the normal drop-backoff) — we WANT to re-fold the log now.
    let watchdogForced = false;
    // True once seedTail() has painted the recent tail. Used to SKIP the first
    // connection's blank-to-[] so the seeded tail stays on screen while the full log
    // replays (renders are suppressed until `synced` anyway), instead of flashing
    // empty then repainting — which made the fast first paint invisible.
    let seeded = false;

    const loop = async () => {
      let notFoundDelay = 500;
      let firstConn = true;
      while (!closed) {
        // Fresh fold per PHYSICAL connection: reset to empty so the full-log
        // replay rebuilds identical state rather than doubling onto the previous
        // connection's fold (the page-refresh double-apply bug). A `Subject`
        // carries this connection's events into ONE apply/processApplyEvents
        // subscription; it completes only when the connection actually ends.
        // EXCEPTION: on the FIRST connection right after seedTail() painted, keep the
        // seeded tail visible — the fold rebuilds `messages` from empty internally and
        // renders are suppressed until `synced`, so blanking here would only flash the
        // fast first paint away. Later reconnects always reset (no seed to preserve).
        if (firstConn && seeded) {
          // The applier still folds from empty; we just don't wipe the VISIBLE tail.
          this.messages = [];
        } else {
          this.setMessages([]);
        }
        firstConn = false;
        // A fresh connection re-replays the whole log; recompute pending interrupts
        // from scratch too. Run-scoped ones derive from the trailing RUN_FINISHED;
        // external (broker) ones are rebuilt as their ext- RUN_FINISHED and any
        // settling PERMISSION_RESOLVED replay in order — so a still-open request
        // survives the reload, and a resolved one stays gone.
        this.logInterrupts = [];
        this.externalInterrupts.clear();
        // Re-derived from the replayed log (a trailing RUN_ERROR re-sets it, an
        // intervening RUN_STARTED clears it) — reset so a reconnect doesn't keep a
        // stale error the newer history has moved past.
        this.lastRunError = null;
        // Likewise re-derive the queue from the log's last QUEUE_UPDATED snapshot.
        this.queued = [];
        // System messages are re-derived from the replayed log too (reset so a
        // reconnect rebuilds the list instead of doubling it). The anchor resets with
        // them so positions re-derive from an empty fold.
        this.systemMessages = [];
        this.lastMessageId = null;
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
            // The stream is alive — reset the idle-watchdog clock.
            this.lastActivityAt = Date.now();
            // Track the pending interrupt as it rides the log: a RUN_STARTED means the
            // (resumed) run is live again — clear any pending; a RUN_FINISHED with an
            // interrupt outcome pauses the run awaiting a user answer. The base
            // applier ignores this, so we surface it via getPendingInterrupts().
            this.trackInterrupt(e);
            // Track run-in-flight for the Stop button / thinking indicator. The
            // base applier doesn't signal this, so nudge subscribers on a change
            // (suppressed during replay — the final `synced` render carries it).
            let changed = this.trackRunning(e);
            // Track a RUN_ERROR message so a failed run surfaces a visible banner
            // instead of silently clearing (the base applier renders no message for
            // RUN_ERROR). Same nudge discipline as trackRunning.
            changed = this.trackRunError(e) || changed;
            // Track the QUEUE_UPDATED snapshot so queued-behind-a-run messages render
            // durably (they used to be client-only and vanished on refresh).
            changed = this.trackQueue(e) || changed;
            // Track image refs (MESSAGE_IMAGES) so a user message's images render
            // live + survive a refresh (the base applier ignores this bespoke event).
            changed = this.trackImages(e) || changed;
            // Track context-window fill (CONTEXT_USAGE) for the fill bar.
            changed = this.trackContext(e) || changed;
            // Track SYSTEM messages (hidden behind a toggle in the thread).
            changed = this.trackSystemMessage(e) || changed;
            if (changed && !this.replaying) this.notifyMessages();
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
        } else if (watchdogForced) {
          // The idle-watchdog forced this reconnect (a wedged/stalled stream) —
          // reconnect NOW to re-fold the persisted log and heal stuck state.
          watchdogForced = false;
          notFoundDelay = 500;
        } else {
          // A real drop/error: brief pause, then reconnect + re-replay.
          notFoundDelay = 500;
          if (!closed) await delay(500);
        }
      }
    };

    // IDLE WATCHDOG: if the UI is in a NON-idle state (a run "running", or an
    // interrupt pending) but the stream has gone silent, force a reconnect by
    // aborting the current connection. The reconnect re-folds from the PERSISTED
    // log (which HAS the dropped terminal frame — RUN_FINISHED / PERMISSION_RESOLVED
    // — that the LIVE stream missed), re-deriving the correct state. This is the
    // general cure for the "agent seems dead" class. 0 disables.
    //
    // A `running` run re-arms every idle window (a hung run should keep retrying).
    // A pending INTERRUPT only fires ONCE per distinct pending set: a single
    // re-fold heals a dropped PERMISSION_RESOLVED; if it's still pending after
    // that, the approval is genuinely open (a real user prompt) and we must NOT
    // churn a reconnect every T seconds while the user decides.
    const idleMs = this.cfg.idleReconnectMs ?? 25_000;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    if (idleMs > 0) {
      this.lastActivityAt = Date.now();
      let healedInterruptKey: string | null = null; // pending-set we've already re-folded for
      watchdog = setInterval(() => {
        if (closed) return;
        if (Date.now() - this.lastActivityAt < idleMs) return;
        const pending = this.getPendingInterrupts();
        // Key the pending set so a NEW interrupt re-arms the one-shot heal.
        const interruptKey = pending.length ? pending.map((i) => i.id).sort().join(",") : null;
        const runStuck = this.running;
        const interruptStuck = interruptKey !== null && interruptKey !== healedInterruptKey;
        if (!runStuck && !interruptStuck) return;
        if (interruptStuck) healedInterruptKey = interruptKey;
        // Stuck: nudge the loop to reconnect + re-fold from the log.
        this.lastActivityAt = Date.now(); // avoid re-firing while the reconnect runs
        watchdogForced = true; // reconnect promptly (no drop-backoff delay)
        controller?.abort();
      }, Math.max(50, Math.floor(idleMs / 2)));
      (watchdog as { unref?: () => void }).unref?.();
    }

    const stop = () => {
      closed = true;
      if (watchdog) clearInterval(watchdog);
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
  async send(
    text: string,
    opts?: { priority?: number; images?: Array<{ data: string; mimeType: string }> },
  ): Promise<void> {
    // With images, send a multimodal content-parts array (text + image parts) the
    // agent-host normalizer splits; without, a plain string (the unchanged path).
    const content =
      opts?.images && opts.images.length
        ? [
            ...(text ? [{ type: "text", text }] : []),
            ...opts.images.map((img) => ({ type: "image", data: img.data, mimeType: img.mimeType })),
          ]
        : text;
    await this.postAgui({
      threadId: this.cfg.conversationId,
      runId: `send-${this.cfg.conversationId}-${text.length}`,
      messages: [{ id: `u-${text.length}`, role: "user", content }],
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

  /** Stop the running turn — the Stop button. POSTs the agent-host cancel
   *  endpoint, which ends the in-flight run (kills the active tool call, ACP
   *  session/cancel, emits RUN_FINISHED{cancelled}); the terminal event then
   *  arrives via the integrity stream and flips `running` false. This method is
   *  ONLY responsible for the POST landing — it does NOT wait for the run to
   *  actually stop (that reconciliation lives in RuntimeProvider off the stream).
   *
   *  Crucially it does NOT swallow errors: if the POST itself fails (network
   *  down, non-2xx), it THROWS so the caller can tell the user "couldn't send
   *  stop" instead of the button looking dead while nothing happened. A stop the
   *  user can't tell landed is a broken control (the Stop-no-feedback bug). */
  async cancel(): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.cfg.token ? { Authorization: `Bearer ${this.cfg.token}` } : {}),
    };
    const res = await this.doFetch(
      `${this.base}/conversations/${encodeURIComponent(this.cfg.conversationId)}/cancel`,
      { method: "POST", headers },
    );
    if (!res.ok) {
      throw new Error(`cancel request failed: ${res.status} ${res.statusText}`);
    }
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
