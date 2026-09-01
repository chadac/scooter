/**
 * The conversation EVENT LOG on Postgres — the durable replacement for
 * events.jsonl. Stage 2 (design): signatures and contracts only, no bodies.
 *
 * Replaces fileStore's event half AND the whole mirroredStore layer. There is no
 * second copy, so there is no divergence to reconcile: the table IS the log.
 * See todo/draft/EVENT_LOG_IN_POSTGRES.md for the measurements behind this.
 *
 * NOT a notification bus. agent-host stays the source of truth for live events:
 * onAppend fires in-process after a durable insert, exactly as the file store
 * does today. No LISTEN/NOTIFY, no triggers.
 */

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { AguiEvent } from "../bridge.js";
import type { ChecksummedEvent } from "./manager.js";
import type { SessionId } from "../types.js";

export interface PgEventStoreConfig {
  /** Postgres connection string. Ignored when `db` is supplied. */
  dsn?: string;
  /** Override the database handle (tests). Defaults to a hardened pool over `dsn`. */
  db?: NodePgDatabase;
}

/** The event-log half of ConversationStore, backed by conversation_events. */
export interface PgEventStore {
  /**
   * Append one event. FIRE-AND-FORGET at the call site (`void append(...)`), so
   * ordering cannot depend on the caller awaiting.
   *
   * `seq` comes from an in-process per-conversation counter on the same write
   * chain the file store uses, because one pod owns a conversation at a time
   * (controller assignment + drain + router + fencing). The PK
   * (conversation_id, seq) is the backstop: if that assumption is ever violated,
   * the insert must FAIL LOUDLY rather than silently reorder.
   *
   * MUST NOT use ON CONFLICT DO NOTHING — a PK conflict here means two writers.
   */
  appendEvent(id: SessionId, event: AguiEvent): Promise<void>;

  /**
   * Await every append ENQUEUED so far for `id`. Closes the
   * subagent-completion race: a RUN_FINISHED fires onEvent -> read before the
   * fire-and-forget insert lands, so the reader sees a log without it.
   */
  flush(id: SessionId): Promise<void>;

  /** Full replay in append order. A CURSOR, not a buffered array — the largest
   *  real conversation is 6k events and reconnects replay it. */
  readEvents(id: SessionId): AsyncIterable<AguiEvent>;

  /** Full replay carrying the stored chain. The checksum columns are read, never
   *  recomputed: jsonb does not preserve key order, so a chain re-derived from
   *  the column can never match the one the writer computed. */
  readEventsWithChecksum(id: SessionId): AsyncIterable<ChecksummedEvent>;

  /**
   * The last `runs` runs, matching tailByRuns EXACTLY — which orders by each
   * event's `ts` (stable tie-break on append order) BEFORE windowing on
   * RUN_STARTED. Append order != time order across an agent-host restart seam,
   * so this is NOT `ORDER BY seq DESC LIMIT n` and NOT a `seq >= boundary`
   * range; both window across the seam and render scrambled history.
   *
   * Returns the window in TIME order, as tailByRuns does.
   */
  readEventsTail(id: SessionId, runs: number): Promise<AguiEvent[]>;

  /** Live durable appends, in-process. The authority the integrity SSE
   *  broadcasts. Fires only AFTER the row is committed. Returns unsubscribe. */
  onAppend(cb: (id: SessionId, event: ChecksummedEvent) => void): () => void;

  /** Durable-append FAILURES. appendEvent is fire-and-forget, so without this a
   *  failed write to the conversation's ONLY persistence vanishes silently. */
  onAppendError(cb: (id: SessionId, error: unknown) => void): () => void;

  /** Drop a conversation's events (conversation deletion). */
  removeConversation(id: SessionId): Promise<void>;

  close(): Promise<void>;
}

export function createPgEventStore(config: PgEventStoreConfig): PgEventStore {
  void config;
  throw new Error("not implemented — Stage 2 design");
}

/**
 * Backfill one conversation's events from a .jsonl log. Exported so the one-shot
 * migration Job and its tests share the exact chain computation.
 *
 * `lines` must be in FILE order. The chain is folded with the same chainNext the
 * writer used; each line is JSON.parsed and handed to it unmodified — never
 * re-serialized (canonicalize sorts only TOP-LEVEL keys, so nested order comes
 * from the parse, and any other JSON writer would produce a different hash).
 *
 * Returns what it wrote so the Job can VERIFY rather than assume: a backfill
 * that loads 127 of 128 conversations must not report success.
 */
export interface BackfillResult {
  conversationId: SessionId;
  rows: number;
  /** Chain through the last event — compare against the file's own recomputation. */
  finalChecksum: string;
}

export function backfillConversation(
  db: NodePgDatabase,
  id: SessionId,
  lines: Iterable<string>,
): Promise<BackfillResult> {
  void db, id, lines;
  throw new Error("not implemented — Stage 2 design");
}
