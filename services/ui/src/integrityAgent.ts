/**
 * IntegrityAgent is an @ag-ui/client AbstractAgent whose render source is the
 * agent-host's per-conversation integrity stream (GET /conversations/:id/events.integrity)
 * rather than the /agui response, so the open view shows every run regardless of who drove it.
 * The stream's frames carry @ag-ui/core BaseEvents already, and the base-class applier folds
 * them into `messages`. Sends are fire-and-forget POST /agui calls whose replies re-enter
 * through the same subscription, and interrupts are answered through submitResume.
 */

import { AbstractAgent, type RunAgentInput } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/core";
import { Observable, Subject, type Subscription, catchError, EMPTY } from "rxjs";

import type { AgentHostConfig } from "./client.js";
import { AWAITING_ID, hasId, type MaybeConversationId } from "./conversation.js";
import { stateFeed } from "./stateFeed.js";
import { ATTR, record } from "./telemetry.js";

/** A POST /agui the server refused (`status` set) or that never reached it (`status` null), so the message was not delivered. */
export class SendError extends Error {
  constructor(readonly status: number | null, cause?: unknown) {
    super(status == null ? "send failed: network error" : `send failed: HTTP ${status}`, { cause });
    this.name = "SendError";
  }
}

/** The user-facing text for a failed send; a 413 means the body (usually its images) was too large for the server. */
export function describeSendError(e: unknown): string {
  if (!(e instanceof SendError)) {
    return `Your message wasn't sent: ${e instanceof Error ? e.message : String(e)}`;
  }
  const status = e.status;
  if (status === 413) {
    return "Your message was too large to send, so it and its attachments weren't delivered. Try a smaller image or fewer attachments.";
  }
  if (status != null) return `Your message wasn't sent (HTTP ${status}). Try again.`;
  return "Your message wasn't sent because the server couldn't be reached. Check your connection and try again.";
}

export interface IntegrityAgentConfig extends AgentHostConfig {
  /** The server's conversation id, or AWAITING_ID until the server has created it; narrow with hasId(). */
  conversationId: MaybeConversationId;
  /** Per-conversation model, sent as the X-Agent-Model header on POST /agui. */
  model?: string;
  /** Called once a POST carrying `model` was accepted. */
  onModelSent?: (model: string) => void;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Idle-watchdog threshold in ms: a run that looks running while the stream stays silent this long forces a reconnect (default 25s, 0 disables). */
  idleReconnectMs?: number;
  /** Delay in ms between cancel() 404 retries. */
  cancelRetryDelayMs?: number;
}

/** A resume answer to a pending interrupt (permission/option choice). */
export interface ResumeEntry {
  interruptId: string;
  status: "resolved" | "cancelled";
  payload?: unknown;
}

interface IntegrityFrame {
  kind: "event" | "synced" | "topic" | "resume" | "reset";
  event?: Record<string, unknown>;
  topic?: string;
  data?: unknown;
  seq?: number;
  checksum?: string;
  prevChecksum?: string;
}

/** The last log position the fold has applied, sent to resume a reconnect. */
export interface StreamCursor {
  seq: number;
  checksum: string;
}

/** A settled fold plus its derived state, as cached. */
export interface FoldSnapshot {
  cursor: StreamCursor;
  messages: unknown[];
  historyCursor: number;
  pendingApprovals: PendingInterrupt[];
  running: boolean;
  activeToolName: string | null;
  runStartedAt: number | null;
  contextUsedTokens: number | null;
  contextWindow: number | null;
  systemMessages: Array<{ id: string; source: string; text: string; afterMessageId: string | null }>;
  lastMessageId: string | null;
  lastRunError: string | null;
  retrying: { attempt: number; max: number } | null;
  queued: ReadonlyArray<QueuedItem>;
  messageImages: Array<[string, Array<{ assetId: string; mimeType: string; url: string }>]>;
  messageTimes: Array<[string, number]>;
}

/** Where a frame sits in the log, when the server says. */
type FramePosition = Pick<IntegrityFrame, "seq" | "checksum" | "prevChecksum">;

/** A pending interrupt parsed from the log's RUN_FINISHED(outcome=interrupt), mirroring the bridge's AguiInterrupt shape. */
export interface PendingInterrupt {
  id: string;
  reason: string;
  message?: string;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
}

/** Result of reading one integrity SSE connection to completion. */
type ConnectionOutcome = "not-found" | "closed" | "error" | "auth-error";

/** One queued message from QUEUE_UPDATED; `interrupt` is set only on a priority item. */
export interface QueuedItem {
  id: string;
  text: string;
  priority: number;
  interrupt?: "timeout" | "thinking" | "tool-call";
  source?: string;
}

/** A stable empty-queue reference so getQueuedMessages keeps the same identity across idle calls. */
const EMPTY_QUEUE: ReadonlyArray<QueuedItem> = [];
const EMPTY_INTERRUPTS: readonly PendingInterrupt[] = [];

export class IntegrityAgent extends AbstractAgent {
  private readonly cfg: IntegrityAgentConfig;
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  /** Abort controllers for the live render subscription(s), aborted on dispose. */
  private readonly controllers = new Set<AbortController>();
  /** Stops the render-pump reconnect loop (see renderPump), called on dispose. */
  private stopPump?: () => void;
  /** Every unanswered interrupt the conversation is paused on, keyed by id; added on RUN_FINISHED(outcome=interrupt) and removed only by a matching PERMISSION_RESOLVED, never by run boundaries. */
  private pendingApprovals = new Map<string, PendingInterrupt>();

  /** True while a connection is replaying the persisted log, so the render pump paints the history once at `synced` instead of per event. */
  private replaying = false;
  isReplaying(): boolean {
    return this.replaying;
  }

  /** Which fold the current `messages` belong to; each connection re-folds from empty, so a consumer that suppresses shrinking lists must reset its high-water mark when this changes. */
  private foldEpoch = 0;
  foldGeneration(): number {
    return this.foldEpoch;
  }

  /** The log position `messages` reflects, or undefined when unknown. */
  private cursor: StreamCursor | undefined;
  streamCursor(): StreamCursor | undefined {
    return this.cursor;
  }

  /** True while a goose run is in flight, derived from RUN_STARTED/RUN_FINISHED/RUN_ERROR and ignoring out-of-band `ext-` runs. */
  private running = false;
  runIsActive(): boolean {
    return this.running;
  }
  /** Wall-clock ms of the last frame received on the live stream, read by the idle watchdog. */
  private lastActivityAt = Date.now();
  private livenessHealed = false; // one-shot guard for the liveness reconnect

  // The in-flight tool call's name and the last RUN_STARTED's ts, so the UI can show what the run is doing and for how long.
  private activeToolName: string | null = null;
  private runStartedAt: number | null = null;
  /** The in-flight tool call's name, or null between tool calls or when not running. */
  activeTool(): string | null {
    return this.running ? this.activeToolName : null;
  }
  /** Epoch ms of the current run's RUN_STARTED, or null when not running. */
  runStartedAtMs(): number | null {
    return this.running ? this.runStartedAt : null;
  }

  /** Update `running`, the active tool name and the run-start ts from one log event, returning true if anything the UI shows changed. */
  private trackRunning(e: BaseEvent): boolean {
    // Only these events move `running`, which gates the Stop button, so record each one.
    const t = (e as unknown as { type?: string }).type;
    if (t === "RUN_STARTED" || t === "RUN_FINISHED" || t === "RUN_ERROR") {
      record("run.state_event", {
        "event.type": String(t),
        "run.id": String((e as unknown as { runId?: string }).runId ?? ""),
        running_before: this.running,
      });
    }
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
      this.activeToolName = typeof ev.toolCallName === "string" ? ev.toolCallName : "tool";
    } else if (ev.type === "TOOL_CALL_END") {
      this.activeToolName = null;
    }
    return this.running !== before.running || this.activeToolName !== before.tool;
  }

  // Context-window fill from the latest CONTEXT_USAGE event, persisted and replayed so it survives a refresh.
  private contextUsedTokens: number | null = null;
  private contextWindow: number | null = null;
  /** Context-fill fraction 0..1 (usedTokens / contextWindow), or null if unknown. */
  contextFill(): number | null {
    if (this.contextUsedTokens == null || !this.contextWindow) return null;
    return Math.min(1, this.contextUsedTokens / this.contextWindow);
  }
  /** {used, total} tokens for a tooltip, cached so an unchanged reading keeps its identity for useState. */
  contextTokens(): { used: number; total: number } | null {
    if (this.contextUsedTokens == null || !this.contextWindow) return null;
    const c = this.lastContextTokens;
    if (c && c.used === this.contextUsedTokens && c.total === this.contextWindow) return c;
    return (this.lastContextTokens = { used: this.contextUsedTokens, total: this.contextWindow });
  }
  private lastContextTokens: { used: number; total: number } | null = null;
  private trackContext(e: BaseEvent): boolean {
    const ev = e as unknown as { type?: string; usedTokens?: number; contextWindow?: number };
    if (ev.type !== "CONTEXT_USAGE") return false;
    const before = this.contextUsedTokens;
    if (typeof ev.usedTokens === "number") this.contextUsedTokens = ev.usedTokens;
    if (typeof ev.contextWindow === "number") this.contextWindow = ev.contextWindow;
    return this.contextUsedTokens !== before;
  }

  // Platform-injected SYSTEM_MESSAGE events, which the @ag-ui applier ignores; each records the real message it followed so RuntimeProvider can splice its chip inline at that position.
  private systemMessages: Array<{ id: string; source: string; text: string; afterMessageId: string | null }> = [];
  /** The id of the most recent real message start seen in the raw event stream, the chronological anchor for a system message. */
  private lastMessageId: string | null = null;
  /** All system messages in the conversation, each with the id of the real message it followed (null = before any message), deduped by id. */
  getSystemMessages(): ReadonlyArray<{ id: string; source: string; text: string; afterMessageId: string | null }> {
    return this.systemMessages;
  }
  private trackSystemMessage(e: BaseEvent): boolean {
    const ev = e as unknown as {
      type?: string; messageId?: string; toolCallId?: string; source?: string; text?: string;
      messages?: Array<{ id?: unknown }>; afterMessageId?: string | null;
    };
    // History arrives folded into the stream's MESSAGES_SNAPSHOT (older pages come over a separate fetch), so no
    // TEXT_MESSAGE_START flows for it; its last message is the anchor for whatever arrives live next.
    if (ev.type === "MESSAGES_SNAPSHOT") {
      const last = ev.messages?.[ev.messages.length - 1]?.id;
      if (typeof last === "string") this.lastMessageId = last;
      return false;
    }
    // The base applier folds each text message and each tool call as a separate top-level message, so the anchor is whichever of those started last.
    if (ev.type === "TEXT_MESSAGE_START" && ev.messageId) {
      this.lastMessageId = ev.messageId;
      return false;
    }
    if (ev.type === "TOOL_CALL_START" && ev.toolCallId) {
      this.lastMessageId = ev.toolCallId;
      return false;
    }
    if (ev.type !== "SYSTEM_MESSAGE" || !ev.messageId) return false;
    if (this.systemMessages.some((m) => m.id === ev.messageId)) return false; // replay dedupe
    this.systemMessages.push({
      id: ev.messageId, source: ev.source ?? "system", text: ev.text ?? "",
      // A replayed system message carries the server's anchor in the snapshot's id space, since its position
      // inside the folded history can't be recovered here; live ones anchor to the last message seen.
      afterMessageId: ev.afterMessageId !== undefined ? ev.afterMessageId : this.lastMessageId,
    });
    return true;
  }

  /** The last RUN_ERROR's message, or null; the base applier appends no message for RUN_ERROR, so RuntimeProvider renders this as a banner until the next non-ext RUN_STARTED clears it. */
  private lastRunError: string | null = null;
  getRunError(): string | null {
    return this.lastRunError;
  }

  /** The server's auto-retry progress from RUN_RETRYING events, cleared by the retry's RUN_STARTED or a terminal RUN_ERROR; null when not retrying. */
  private retrying: { attempt: number; max: number } | null = null;
  getRunRetrying(): { attempt: number; max: number } | null {
    return this.retrying;
  }

  /** True when the live stream was rejected with 401/403, which the UI surfaces durably until a reconnection succeeds. */
  private streamAuthError = false;
  getStreamAuthError(): boolean {
    return this.streamAuthError;
  }

  /** Update `lastRunError` and the retry state from one log event, ignoring `ext-` runs; returns true if either changed. */
  private trackRunError(e: BaseEvent): boolean {
    const ev = e as unknown as { type?: string; runId?: string; message?: string; attempt?: number; max?: number };
    const isExt = typeof ev.runId === "string" && ev.runId.startsWith("ext-");
    if (isExt) return false;
    let next = this.lastRunError;
    const beforeRetry = this.retrying;
    if (ev.type === "RUN_STARTED") {
      next = null; // a fresh run clears the stale error
      this.retrying = null; // a run started, so stop showing "retrying"
    } else if (ev.type === "RUN_RETRYING") {
      // Show "retrying (n/N)" without clearing lastRunError, so the final RUN_ERROR stands if every retry fails.
      this.retrying = { attempt: ev.attempt ?? 1, max: ev.max ?? 1 };
    } else if (ev.type === "RUN_ERROR") {
      next = ev.message ?? "The run failed.";
      this.retrying = null; // a terminal error ends the retrying state
    }
    const retryChanged =
      (beforeRetry?.attempt !== this.retrying?.attempt) || (beforeRetry?.max !== this.retrying?.max);
    if (next === this.lastRunError && !retryChanged) return false;
    this.lastRunError = next;
    return true;
  }

  /** The messages queued behind the active run, from the server's latest QUEUE_UPDATED snapshot. */
  private queued: ReadonlyArray<QueuedItem> = [];
  /** Where the painted window starts in the log (1 = the whole log is loaded). */
  private historyCursor = 1;
  private olderInFlight: Promise<number> | undefined;
  getQueuedMessages(): ReadonlyArray<QueuedItem> {
    // The queue only holds items while a run is draining them, so an idle run reports empty even if the clearing QUEUE_UPDATED never arrived.
    return this.running ? this.queued : EMPTY_QUEUE;
  }

  /** messageId -> its attached image refs from MESSAGE_IMAGES, which the base applier ignores. */
  private messageImages = new Map<string, Array<{ assetId: string; mimeType: string; url: string }>>();
  getMessageImages(messageId: string): Array<{ assetId: string; mimeType: string; url: string }> | undefined {
    return this.messageImages.get(messageId);
  }

  /** Record a MESSAGE_IMAGES event's refs keyed by messageId; returns true if it added anything.
   *  An assistant message can carry several events (one per image the agent sent), so refs
   *  accumulate, deduped by assetId, which also keeps a replayed event idempotent. */
  private trackImages(e: BaseEvent): boolean {
    const ev = e as unknown as { type?: string; messageId?: string; images?: Array<{ assetId: string; mimeType: string; url: string }> };
    if (ev.type !== "MESSAGE_IMAGES" || !ev.messageId || !ev.images?.length) return false;
    const cur = this.messageImages.get(ev.messageId) ?? [];
    const seen = new Set(cur.map((i) => i.assetId));
    const added = ev.images.filter((i) => !seen.has(i.assetId));
    if (!added.length) return false;
    this.messageImages.set(ev.messageId, [...cur, ...added]);
    return true;
  }

  /** messageId -> epoch ms it was sent, from the opening event's `ts` or a snapshot/page message's `createdAt`. */
  private messageTimes = new Map<string, number>();
  getMessageTime(messageId: string): number | undefined {
    return this.messageTimes.get(messageId);
  }

  /** Record send times from server-folded messages (MESSAGES_SNAPSHOT, older pages); first write wins. */
  private recordMessageTimes(messages: readonly unknown[] | undefined): boolean {
    let changed = false;
    for (const m of messages ?? []) {
      const { id, createdAt } = (m ?? {}) as { id?: unknown; createdAt?: unknown };
      if (typeof id === "string" && typeof createdAt === "number" && !this.messageTimes.has(id)) {
        this.messageTimes.set(id, createdAt);
        changed = true;
      }
    }
    return changed;
  }

  /** Record a message's send time from the event that opens it; the base applier drops `ts`. */
  private trackTimes(e: BaseEvent): boolean {
    const ev = e as unknown as { type?: string; ts?: unknown; messageId?: string; toolCallId?: string; parentMessageId?: string; messages?: unknown[] };
    if (ev.type === "MESSAGES_SNAPSHOT") return this.recordMessageTimes(ev.messages);
    if (typeof ev.ts !== "number") return false;
    let id: string | undefined;
    if (ev.type === "TEXT_MESSAGE_START" || ev.type === "REASONING_START" || ev.type === "REASONING_MESSAGE_START") id = ev.messageId;
    else if (ev.type === "TOOL_CALL_START") id = ev.parentMessageId ?? ev.toolCallId;
    if (!id || this.messageTimes.has(id)) return false;
    this.messageTimes.set(id, ev.ts);
    return true;
  }

  /** Update `queued` from a QUEUE_UPDATED snapshot; returns true if it changed. */
  private trackQueue(e: BaseEvent): boolean {
    const ev = e as unknown as { type?: string; items?: Array<QueuedItem> };
    if (ev.type !== "QUEUE_UPDATED") return false;
    const next = ev.items ?? [];
    const same =
      next.length === this.queued.length &&
      next.every((it, i) => it.id === this.queued[i]?.id && it.text === this.queued[i]?.text);
    if (same) return false;
    this.queued = next;
    return true;
  }

  /** Capture the snapshot's paging cursor: `fromSeq` is where the server's trailing window starts, and its absence means the snapshot is the whole log. */
  private trackHistoryCursor(e: BaseEvent): boolean {
    const ev = e as unknown as { type?: string; fromSeq?: number };
    if (ev.type !== "MESSAGES_SNAPSHOT") return false;
    const next = typeof ev.fromSeq === "number" ? ev.fromSeq : 1;
    if (next === this.historyCursor) return false;
    this.historyCursor = next;
    return true;
  }

  /** Whether older history remains to page in (the snapshot was windowed). */
  hasOlderHistory(): boolean {
    return this.historyCursor > 1;
  }

  /** Fetch the next older page and prepend it, returning the number of messages added; concurrent calls collapse onto the in-flight request. */
  async loadOlderHistory(): Promise<number> {
    const id = this.cfg.conversationId;
    if (!this.hasOlderHistory() || !hasId(id)) return 0;
    if (this.olderInFlight) return this.olderInFlight;
    const run = (async () => {
      try {
        const url =
          `${this.base}/conversations/${encodeURIComponent(id)}` +
          `/messages?before=${this.historyCursor}`;
        const res = await this.doFetch(url, {
          headers: this.cfg.token ? { Authorization: `Bearer ${this.cfg.token}` } : undefined,
        });
        if (!res.ok) return 0;
        const body = (await res.json()) as { messages?: unknown[]; fromSeq?: number; done?: boolean };
        const older = body.messages ?? [];
        this.historyCursor = body.done ? 1 : (body.fromSeq ?? 1);
        if (older.length === 0) return 0;
        this.recordMessageTimes(older);
        this.setMessages([...older, ...this.messages] as never);
        this.notifyMessages();
        return older.length;
      } catch {
        return 0; // best-effort; the user can scroll again
      } finally {
        this.olderInFlight = undefined;
      }
    })();
    this.olderInFlight = run;
    return run;
  }

  /** True from restoreFold() until the stream first reaches `synced`. */
  private fromCache = false;
  isSyncingFromCache(): boolean {
    return this.fromCache;
  }

  /** The settled fold, or undefined mid-replay or without cursor. */
  snapshotFold(): FoldSnapshot | undefined {
    if (!this.cursor || this.replaying) return undefined;
    return {
      cursor: this.cursor,
      messages: this.messages as unknown[],
      historyCursor: this.historyCursor,
      pendingApprovals: [...this.pendingApprovals.values()],
      running: this.running,
      activeToolName: this.activeToolName,
      runStartedAt: this.runStartedAt,
      contextUsedTokens: this.contextUsedTokens,
      contextWindow: this.contextWindow,
      systemMessages: this.systemMessages,
      lastMessageId: this.lastMessageId,
      lastRunError: this.lastRunError,
      retrying: this.retrying,
      queued: this.queued,
      messageImages: [...this.messageImages],
      messageTimes: [...this.messageTimes],
    };
  }

  /** Paint a cached fold; renderPump() then resumes its cursor. */
  restoreFold(s: FoldSnapshot): void {
    this.cursor = s.cursor;
    this.historyCursor = s.historyCursor;
    this.pendingApprovals = new Map(s.pendingApprovals.map((p) => [p.id, p]));
    this.running = s.running;
    this.activeToolName = s.activeToolName;
    this.runStartedAt = s.runStartedAt;
    this.contextUsedTokens = s.contextUsedTokens;
    this.contextWindow = s.contextWindow;
    this.systemMessages = s.systemMessages;
    this.lastMessageId = s.lastMessageId;
    this.lastRunError = s.lastRunError;
    this.retrying = s.retrying;
    this.queued = s.queued;
    this.messageImages = new Map(s.messageImages);
    this.messageTimes = new Map(s.messageTimes);
    this.fromCache = true;
    this.setMessages(s.messages as never);
  }

  /** The interrupts the conversation is currently paused on, empty if none. */
  getPendingInterrupts(): readonly PendingInterrupt[] {
    // A stable identity when empty, because the caller feeds this to useState which bails out only on Object.is.
    if (this.pendingApprovals.size === 0) return EMPTY_INTERRUPTS;
    const next = [...this.pendingApprovals.values()];
    if (
      this.lastInterrupts.length === next.length &&
      next.every((v, i) => v === this.lastInterrupts[i])
    ) {
      return this.lastInterrupts;
    }
    this.lastInterrupts = next;
    return next;
  }
  private lastInterrupts: readonly PendingInterrupt[] = EMPTY_INTERRUPTS;

  /** Update the pending-interrupt map from one log event: RUN_FINISHED(outcome=interrupt) adds each interrupt by id, PERMISSION_RESOLVED removes one, and run boundaries change nothing. */
  private trackInterrupt(e: BaseEvent): void {
    const ev = e as unknown as {
      type?: string;
      runId?: string;
      toolCallId?: string;
      optionId?: string | null;
      outcome?: { type?: string; interrupts?: PendingInterrupt[] };
    };
    const before = this.pendingSignature();
    if (ev.type === "PERMISSION_RESOLVED") {
      if (!ev.toolCallId) return;
      this.pendingApprovals.delete(ev.toolCallId);
    } else if (ev.type === "RUN_FINISHED" && ev.outcome?.type === "interrupt" && Array.isArray(ev.outcome.interrupts)) {
      // Add without clearing, since approvals are settled only by PERMISSION_RESOLVED.
      for (const it of ev.outcome.interrupts) this.pendingApprovals.set(it.id, it);
    } else {
      return; // nothing else changes the interrupt set
    }
    // The base applier produces no message change for a RUN_FINISHED(interrupt), so nudge subscribers whenever the pending set's content changes.
    if (before !== this.pendingSignature()) this.notifyMessages();
  }

  /** A stable signature of the pending-interrupt set (sorted ids), so a change-nudge fires on any content change. */
  private pendingSignature(): string {
    return [...this.pendingApprovals.keys()].sort().join(",");
  }

  /** Fire onMessagesChanged on every subscriber with the current snapshot, for changes the base applier does not itself signal. */
  private notifyMessages(): void {
    for (const s of this.subscribers) {
      s.onMessagesChanged?.({ messages: this.messages, state: this.state, agent: this } as never);
    }
  }

  constructor(config: IntegrityAgentConfig) {
    // The base class wants a string thread id, so pass the empty string until the server has created the conversation.
    super({ threadId: hasId(config.conversationId) ? config.conversationId : "" });
    this.cfg = config;
    this.base = config.baseUrl.replace(/\/$/, "");
    // Bound to globalThis because an unbound `fetch` invoked as `this.doFetch(...)` throws "Illegal invocation" in the browser.
    this.doFetch = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** Update the per-conversation model in place; the render source is unaffected, so the caller keeps the same agent instance. */
  setModel(model?: string): void {
    this.cfg.model = model;
  }

  /** The server id for an action whose caller has already ensured the conversation exists, or throw. */
  #requireId(op: string): string {
    const id = this.cfg.conversationId;
    if (!hasId(id)) {
      throw new Error(`cannot ${op}: the conversation has not been created yet`);
    }
    return id;
  }

  /** The conversation this agent is folding, or AWAITING_ID before the server has issued one. */
  currentConversationId(): MaybeConversationId {
    return this.cfg.conversationId;
  }

  /** Re-point this agent at the id the server assigned and drop the open stream so the pump reconnects on it. */
  setConversationId(conversationId: string): void {
    if (conversationId === this.cfg.conversationId) return;
    // Both ids are recorded because this is where a trace would otherwise break in two.
    record("conversation.id_assigned", {
      [ATTR.conversationKey]: hasId(this.cfg.conversationId) ? this.cfg.conversationId : "(awaiting-id)",
      [ATTR.conversationId]: conversationId,
    });
    this.cfg.conversationId = conversationId;
    // Each reconnect recomputes the URL, so aborting brings the pump back on the new conversation.
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
  }

  /**
   * The render source: a continuous Observable of the conversation's events from
   * GET /conversations/:id/events.integrity that ignores `input` and reconnects on drop.
   */
  run(_input: RunAgentInput): Observable<BaseEvent> {
    // There are no events until the server has created the conversation.
    if (!hasId(this.cfg.conversationId)) return EMPTY;
    const url = `${this.base}/conversations/${encodeURIComponent(this.cfg.conversationId)}/events.integrity`;
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      ...(this.cfg.token ? { Authorization: `Bearer ${this.cfg.token}` } : {}),
    };

    // One SSE connection that re-replays the full log on each reconnect; the render pump does not subscribe here because the base applier would double-apply each replay into the same accumulator (see renderPump).
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

  /** Read one integrity SSE connection to completion, invoking `onEvent` per inner BaseEvent and reporting how it ended. */
  private async readConnection(
    url: string,
    headers: Record<string, string>,
    controller: AbortController,
    onEvent: (e: BaseEvent, pos: FramePosition) => void,
    onSynced?: (pos: FramePosition) => void,
    onMode?: (mode: "resume" | "reset") => void,
  ): Promise<ConnectionOutcome> {
    // Topics name the conversation this connection was opened for.
    const id = this.cfg.conversationId;
    const stateId = hasId(id) ? id : undefined;
    let fedState = false;
    try {
      // Firefox makes identical stored GETs wait on a never-ending stream.
      const res = await this.doFetch(url, { headers, cache: "no-store", signal: controller.signal });
      if (res.status === 404) return "not-found"; // created on first prompt
      // 401/403 means an expired auth session that retrying cannot fix.
      if (res.status === 401 || res.status === 403) return "auth-error";
      if (!res.ok || !res.body) return "error";
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      // Race each read against the abort signal so a stalled body stays abortable even when the ReadableStream ignores the fetch signal.
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
          // Any frame, including a heartbeat, proves the connection is alive.
          this.lastActivityAt = Date.now();
          // Only live frames re-arm the liveness one-shot, since replayed frames are historical.
          if (!this.replaying) this.livenessHealed = false;
          const line = raw.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let frame: IntegrityFrame;
          try {
            frame = JSON.parse(line.slice(5).trim()) as IntegrityFrame;
          } catch {
            continue; // skip a malformed frame, keep the stream alive
          }
          // `synced` marks the end of replay, after which live events follow.
          if (frame.kind === "synced") {
            if (stateId && !fedState) {
              stateFeed.open(stateId);
              fedState = true;
            }
            onSynced?.(frame);
          } else if (frame.kind === "resume" || frame.kind === "reset") {
            onMode?.(frame.kind);
          } else if (frame.kind === "topic" && frame.topic && stateId) {
            stateFeed.frame(stateId, { kind: "topic", topic: frame.topic, data: frame.data });
          } else if (frame.kind === "event" && frame.event) {
            onEvent(frame.event as unknown as BaseEvent, frame);
          }
        }
      }
      return "closed";
    } catch {
      return "error"; // network drop / abort
    } finally {
      if (stateId && fedState) stateFeed.down(stateId);
    }
  }

  /**
   * The render pump folds the integrity stream into `messages` through the base-class
   * applier with exactly one subscription per SSE connection, so every event is applied once.
   * Each physical connection gets its own fold seeded from an empty message list, because the
   * server replays the full log on every (re)connect. A healthy connection never completes, and
   * the loop reconnects only when readConnection returns. Returns a teardown, also run by dispose().
   */
  renderPump(): () => void {
    const input = this.prepareRunAgentInput();
    // Recomputed per connection because setConversationId() can re-point the agent mid-stream.
    const streamUrl = (): string | undefined =>
      hasId(this.cfg.conversationId)
        ? `${this.base}/conversations/${encodeURIComponent(this.cfg.conversationId)}/events.integrity`
        : undefined;
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      ...(this.cfg.token ? { Authorization: `Bearer ${this.cfg.token}` } : {}),
    };

    let closed = false;
    let connSub: Subscription | undefined;
    let controller: AbortController | undefined;
    // Set by the idle watchdog when it forced the disconnect, so the loop reconnects without the drop backoff.
    let watchdogForced = false;
    // Set by the idle watchdog so its reconnect ignores the cursor.
    let refoldNext = false;
    // True once seedTail() painted the recent tail, so the first connection keeps it on screen through the replay.
    let seeded = false;

    const loop = async () => {
      let notFoundDelay = 500;
      let firstConn = true;
        /** Consecutive ticks spent waiting for a server id, sampled into a span. */
        let waitTicks = 0;
      while (!closed) {
        // Wait for a server id before any per-connection work, because the reset below wipes the folded messages.
        if (!hasId(this.cfg.conversationId)) {
          // Sampled: record the first wait and then every 20th tick (~1s).
          if (waitTicks === 0 || waitTicks % 20 === 0) {
            record("stream.awaiting_id", { wait_ticks: waitTicks });
          }
          waitTicks++;
          await delay(50);
          continue;
        }
        if (waitTicks > 0) {
          record("stream.id_arrived", { wait_ticks: waitTicks });
            // Seed here on the id's arrival, since seedTail() returned early at start-up when there was no id yet.
            if (!seeded) seeded = await this.seedTail().catch(() => false);
          waitTicks = 0;
        }
        const isFirstConnection = firstConn;
        firstConn = false;
        // A watchdog heal re-folds everything, in case the fold itself went wrong.
        const resumeFrom = refoldNext ? undefined : this.cursor;
        refoldNext = false;
        const events$ = new Subject<BaseEvent>();
        let folded: Promise<void> | undefined;
        // Starts this connection's fold; the applier clones `messages` when subscribed, so reset first.
        const beginFold = (fresh: boolean) => {
          if (folded) return;
          if (fresh) {
            // Reset to empty so the replay rebuilds identical state instead of doubling onto the previous fold, except that the first connection after seedTail() keeps the seeded tail visible.
            if (isFirstConnection && (seeded || restored)) {
              // The applier still folds from empty without wiping the visible tail.
              this.messages = [];
            } else {
              this.setMessages([]);
            }
            // A fresh connection replays the whole log, so pending interrupts are recomputed from scratch in log order.
            this.pendingApprovals.clear();
            // Re-derived from the replayed log.
            this.lastRunError = null;
            // Re-derived from the log's last QUEUE_UPDATED snapshot.
            this.queued = [];
            // The new replay's snapshot carries its own window start.
            this.historyCursor = 1;
            // System messages and their anchor are re-derived from the replayed log too.
            this.systemMessages = [];
            this.lastMessageId = null;
            // Unknown until this replay's `synced` reports it.
            this.cursor = undefined;
            // A new fold starts here, so consumers must not compare its length against the previous fold's.
            this.foldEpoch++;
          }
          // Suppress per-event renders until `synced`.
          this.replaying = true;
          // The applier's fold is async and drains buffered events after the source completes, so track its completion rather than tearing it down mid-flight.
          folded = new Promise<void>((resolve) => {
            connSub = this.processApplyEvents(
              input,
              this.apply(input, events$, this.subscribers),
              this.subscribers,
            )
              .pipe(catchError(() => EMPTY))
              .subscribe({ error: () => resolve(), complete: () => resolve() });
          });
        };
        // With a cursor, the server's first frame says whether the fold survives.
        if (!resumeFrom) beginFold(true);
        // False once a frame fails to chain onto the cursor; later frames are dropped.
        let chained = true;
        /** Advance the cursor; false means the frame must not be folded. */
        const advance = (pos: FramePosition): boolean => {
          if (!chained) return false;
          if (pos.seq === undefined || !pos.checksum) return true;
          // A redelivered frame is already folded; skip it without reconnecting.
          if (this.cursor && pos.seq <= this.cursor.seq) return false;
          if (this.cursor && pos.prevChecksum !== undefined && pos.prevChecksum !== this.cursor.checksum) {
            chained = false;
            // A gap: keep the last good cursor, so the reconnect fetches it.
            controller?.abort();
            return false;
          }
          this.cursor = { seq: pos.seq, checksum: pos.checksum };
          return true;
        };
        controller = new AbortController();
        this.controllers.add(controller);

        const connectionOpenedAt = Date.now();
        let framesThisConnection = 0;
        record("stream.connect", {
          [ATTR.conversationId]: hasId(this.cfg.conversationId) ? this.cfg.conversationId : "(awaiting-id)",
          // A reconnect (false) is what "it restarted" looks like to a user.
          "stream.first_connection": isFirstConnection,
          "stream.resume_offered": resumeFrom !== undefined,
        });
        const base = streamUrl() as string; // non-undefined: guarded at the loop head
        const url = resumeFrom ? `${base}?afterSeq=${resumeFrom.seq}&checksum=${resumeFrom.checksum}` : base;
        const outcome = await this.readConnection(
          url,
          headers,
          controller,
          (e, pos) => {
            // A server that ignored the cursor replays without saying so.
            beginFold(true);
            if (!advance(pos)) return;
            // Reset the idle-watchdog clock.
            this.lastActivityAt = Date.now();
            // The first frame separates "connected but silent" from "delivering".
            if (framesThisConnection === 0) {
              record("stream.first_frame", {
                [ATTR.conversationId]: hasId(this.cfg.conversationId) ? this.cfg.conversationId : "(awaiting-id)",
                "stream.ttfb_ms": Date.now() - connectionOpenedAt,
              });
            }
            framesThisConnection++;
            // The base applier ignores interrupts, so they are tracked here and surfaced via getPendingInterrupts().
            this.trackInterrupt(e);
            // The base applier does not signal these states either, so nudge subscribers on a change (suppressed during replay).
            let changed = this.trackRunning(e);
            changed = this.trackRunError(e) || changed;
            changed = this.trackQueue(e) || changed;
            changed = this.trackImages(e) || changed;
            changed = this.trackTimes(e) || changed;
            changed = this.trackContext(e) || changed;
            changed = this.trackSystemMessage(e) || changed;
            changed = this.trackHistoryCursor(e) || changed;
            if (changed && !this.replaying) this.notifyMessages();
            events$.next(e);
          },
          (pos) => {
            beginFold(true);
            // `synced` at the cursor is the head itself, not a redelivery.
            const atHead = !!this.cursor && this.cursor.seq === pos.seq && this.cursor.checksum === pos.checksum;
            if (!atHead && !advance({ seq: pos.seq, checksum: pos.checksum })) return;
            // Reaching `synced` means the session is valid again.
            if (this.streamAuthError) {
              this.streamAuthError = false;
              this.notifyMessages();
            }
            // Wait a macrotask for the async fold's buffered per-event notifications to drain before flipping out of replay and rendering the history in one shot.
            setTimeout(() => {
              this.replaying = false;
              this.fromCache = false;
              this.notifyMessages();
            }, 0);
          },
          (mode) => beginFold(mode === "reset"),
        );
        // Signal end-of-events and wait for the fold to finish before deciding whether to reconnect.
        events$.complete();
        await folded;
        connSub?.unsubscribe();
        connSub = undefined;
        this.controllers.delete(controller);
        controller = undefined;
        if (closed) break;

        record("stream.closed", {
          [ATTR.conversationId]: hasId(this.cfg.conversationId) ? this.cfg.conversationId : "(awaiting-id)",
          [ATTR.reason]: watchdogForced ? "watchdog" : String(outcome ?? "drop"),
          "stream.frames": framesThisConnection,
          "stream.duration_ms": Date.now() - connectionOpenedAt,
          "stream.silent_ms": Date.now() - this.lastActivityAt,
        });

        if (outcome === "auth-error") {
          // An expired auth session: surface it and back off long, but keep polling so it self-clears once auth is renewed.
          if (!this.streamAuthError) {
            this.streamAuthError = true;
            this.notifyMessages();
          }
          if (!closed) await delay(5000);
        } else if (outcome === "not-found") {
          // Not created yet, so back off exponentially.
          await delay(notFoundDelay);
          notFoundDelay = Math.min(notFoundDelay * 2, 5000);
        } else if (watchdogForced) {
          // The watchdog forced this reconnect, so re-fold now.
          watchdogForced = false;
          notFoundDelay = 500;
        } else {
          // A real drop: brief pause, then reconnect.
          notFoundDelay = 500;
          if (!closed) await delay(500);
        }
      }
    };

    // Idle watchdog: when a run is running or an interrupt is pending but the stream has gone silent, abort the connection so the reconnect re-folds the persisted log (0 disables).
    const idleMs = this.cfg.idleReconnectMs ?? 25_000;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    if (idleMs > 0) {
      this.lastActivityAt = Date.now();
      let healedInterruptKey: string | null = null; // pending-set we've already re-folded for
      watchdog = setInterval(() => {
        if (closed) return;
        const silentMs = Date.now() - this.lastActivityAt;
        if (silentMs < idleMs) return; // stream is alive
        const pending = this.getPendingInterrupts();
        // A new interrupt re-arms the one-shot heal.
        const interruptKey = pending.length ? pending.map((i) => i.id).sort().join(",") : null;
        const runStuck = this.running;
        // A pending interrupt heals once per distinct pending set, so a genuinely open approval does not churn reconnects.
        const interruptStuck = interruptKey !== null && interruptKey !== healedInterruptKey;
        // Liveness: with no frame or heartbeat for more than two expected intervals the connection is dead, so reconnect once.
        const livenessWindowMs = idleMs * 2.4; // 2.4× interval = >2 missed pings
        const connectionDead = silentMs >= livenessWindowMs && !this.livenessHealed;
        if (!runStuck && !interruptStuck && !connectionDead) return;
        if (interruptStuck) healedInterruptKey = interruptKey;
        // Any reconnect resets the liveness one-shot until activity resumes and silence recurs.
        this.livenessHealed = true;
        // Abort so the loop reconnects and re-folds from the log.
        this.lastActivityAt = Date.now(); // avoid re-firing while the reconnect runs
        watchdogForced = true; // reconnect promptly (no drop-backoff delay)
        refoldNext = true;
        controller?.abort();
      }, Math.max(50, Math.floor(idleMs / 2)));
      (watchdog as { unref?: () => void }).unref?.();
    }

    // Browsers throttle background-tab timers, so a tab returning to the foreground forces a resync instead of trusting the watchdog.
    const handleVisibilityChange = () => {
      if (typeof document === "undefined") return; // SSR guard
      if (document.visibilityState === "visible" && !closed && controller) {
        this.lastActivityAt = Date.now(); // avoid double-fire from watchdog
        watchdogForced = true;
        controller.abort();
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    const stop = () => {
      closed = true;
      if (watchdog) clearInterval(watchdog);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
      controller?.abort();
      connSub?.unsubscribe();
      if (this.stopPump === stop) this.stopPump = undefined;
    };
    this.stopPump?.();
    this.stopPump = stop;
    // Fast first paint: seed the recent tail, then let the loop re-fold the full log from empty.
    // A restored fold is painted already; no tail needed.
    const restored = this.fromCache;
    void (restored ? Promise.resolve(false) : this.seedTail())
      .then((ok) => {
        seeded = ok;
      })
      .finally(() => {
        if (!closed) void loop();
      });
    return stop;
  }

  /** Fetch the last N runs of the log and fold them into `messages` through the same base applier for a fast first paint; any failure skips the seed. */
  private async seedTail(limit = 300): Promise<boolean> {
    try {
      if (!hasId(this.cfg.conversationId)) return false; // nothing to seed from yet
      const url = `${this.base}/conversations/${encodeURIComponent(this.cfg.conversationId)}/tail?limit=${limit}`;
      const res = await this.doFetch(url, {
        headers: this.cfg.token ? { Authorization: `Bearer ${this.cfg.token}` } : undefined,
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { events?: BaseEvent[] };
      const events = body.events ?? [];
      if (events.length === 0) return false;
      // Fold in a throwaway clone first so a tail that yields nothing renderable cannot blank the real thread.
      const folded = await this.foldTail(events);
      if (folded.length === 0) return false; // nothing renderable → let the full replay paint
      this.setMessages(folded as never);
      this.notifyMessages();
      return true;
    } catch {
      /* the full replay will paint */
      return false;
    }
  }

  /** Fold tail events in a throwaway clone and return the folded messages, possibly empty. */
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

  /** Send a prompt as a fire-and-forget POST /agui; the reply arrives through the integrity subscription, so this resolves once the POST is accepted. */
  async send(
    text: string,
    opts?: {
      priority?: number;
      images?: Array<{ data: string; mimeType: string }>;
      files?: Array<{ name: string; data: string; mimeType: string }>;
    },
  ): Promise<void> {
    // Images or files make the content a multimodal parts array the agent-host normalizer splits; otherwise it is a plain string.
    const hasImages = !!opts?.images?.length;
    const hasFiles = !!opts?.files?.length;
    const content =
      hasImages || hasFiles
        ? [
            ...(text ? [{ type: "text", text }] : []),
            ...(opts?.images ?? []).map((img) => ({ type: "image", data: img.data, mimeType: img.mimeType })),
            ...(opts?.files ?? []).map((f) => ({ type: "file", name: f.name, data: f.data, mimeType: f.mimeType })),
          ]
        : text;
    await this.postAgui({
      threadId: this.#requireId("send"),
      runId: `send-${this.#requireId("send")}-${text.length}`,
      messages: [{ id: `u-${text.length}`, role: "user", content }],
      // A priority tells the agent-host to interrupt the running turn at its next tool boundary instead of queueing behind it.
      ...(opts?.priority ? { priority: opts.priority } : {}),
    });
  }

  /** Answer pending interrupts with POST /agui { resume }, whose continued run streams back through the integrity source. */
  async submitResume(entries: readonly ResumeEntry[]): Promise<void> {
    await this.postAgui({ threadId: this.#requireId("submit a resume"), resume: [...entries] });
  }

  /** Stop the running turn by POSTing the cancel endpoint; the terminal event arrives via the integrity stream, and a failed POST throws so the caller can tell the user. */
  async cancel(): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.cfg.token ? { Authorization: `Bearer ${this.cfg.token}` } : {}),
    };
    const url = `${this.base}/conversations/${encodeURIComponent(this.#requireId("cancel"))}/cancel`;
    // A 404 in the first seconds of a conversation is the controller's assignment window rather than absence, so retry it while other failures throw immediately.
    let last = 0;
    for (let attempt = 0; attempt < 9; attempt++) {
      if (attempt > 0) await delay(this.cfg.cancelRetryDelayMs ?? 700);
      const res = await this.doFetch(url, { method: "POST", headers });
      if (res.ok) return;
      last = res.status;
      if (res.status !== 404) break;
      record("cancel.retry_404", { attempt });
    }
    throw new Error(`cancel request failed: ${last}`);
  }

  /** Fire-and-forget POST /agui that cancels the response body instead of reading it; throws SendError when the POST is refused or never lands, since no run will follow to report it. */
  private async postAgui(body: Record<string, unknown>): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(this.cfg.token ? { Authorization: `Bearer ${this.cfg.token}` } : {}),
      ...(this.cfg.model ? { "X-Agent-Model": this.cfg.model } : {}),
    };
    const sentModel = this.cfg.model;
    const res = await this.doFetch(`${this.base}/agui`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }).catch((e: unknown) => {
      record("send.network_error", {});
      throw new SendError(null, e);
    });
    // POST /agui streams the whole run as SSE, and an unread body would fill the HTTP/2 flow-control window and stall every other stream on the connection.
    res.body?.cancel().catch(() => {});
    if (!res.ok) {
      record("send.refused", { status: res.status });
      throw new SendError(res.status);
    }
    if (sentModel) this.cfg.onModelSent?.(sentModel);
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
