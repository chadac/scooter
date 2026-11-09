/**
 * The conversation event log: one table whose rows are the log, so there is no second
 * copy to reconcile. Not a notification bus: onAppend fires in-process after a committed
 * insert, with no LISTEN/NOTIFY or triggers.
 */

import { and, asc, desc, eq, gt, gte, lt, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { agent_host } from "@scooter/schema";

import { chainNext, EMPTY_CHECKSUM } from "../agui/integrity.js";
import { formatError, logger } from "../log.js";
import { createPgPool } from "../db/pgPool.js";
import type { AguiEvent } from "../bridge.js";
import type { ChecksummedEvent, EventsAfter } from "./manager.js";
import type { SessionId } from "../types.js";

const log = logger("eventStore");
// conversations is read only by the append fence, never written here.
const { conversationEvents, conversations } = agent_host;

// Rows per keyset page of a full replay.
const READ_PAGE_ROWS = 500;

export interface PgEventStoreConfig {
  /** Postgres connection string, ignored when `db` is supplied. */
  dsn?: string;
  /** Override of the database handle for tests, defaulting to a hardened pool over `dsn`. */
  db?: NodePgDatabase;
  /** The claim every append presents; omitted means appends are unconditional. */
  fence?: AppendFence;
  /** Called on each fence refusal: this pod may have lost it. */
  onFenced?: (id: SessionId) => void;
}

/**
 * The append fence. Every insert carries this pod's claim and the row decides, so a
 * superseded pod learns it lost from the write it was already making, with no extra
 * query on a path that runs once per streamed token.
 * The row must name this pod.
 */
export interface AppendFence {
  /** This pod's name, the identity the row must not contradict. */
  pod: string;
  /** The epoch this pod believes it holds `id` under, or undefined when it has observed no
   *  assignment, which narrows the fence to pod identity. */
  generation(id: SessionId): number | undefined;
}

/** The event-log half of ConversationStore, backed by conversation_events. */
export interface PgEventStore {
  /**
   * Append one event, fire-and-forget at the call site: `seq` comes from an in-process
   * per-conversation counter, the PK (conversation_id, seq) backstops against a second
   * writer (never ON CONFLICT DO NOTHING), and a fence refusal resolves rather than throws.
   */
  appendEvent(id: SessionId, event: AguiEvent): Promise<void>;

  /**
   * Await every append enqueued so far for `id`, closing the gap between a fire-and-forget
   * insert and a reader that follows it.
   */
  flush(id: SessionId): Promise<void>;

  /** Full replay in append order, as a cursor rather than a buffered array. */
  readEvents(id: SessionId): AsyncIterable<AguiEvent>;

  /** Full replay carrying the stored chain; the checksum columns are read, never recomputed,
   *  because jsonb does not preserve key order. */
  readEventsWithChecksum(id: SessionId): AsyncIterable<ChecksummedEvent>;

  /**
   * The events from the last `runs` runs, ordered by seq and windowed on RUN_STARTED
   * boundaries so the tail folds identically to a full replay.
   */
  readEventsTail(id: SessionId, runs: number): Promise<AguiEvent[]>;

  /** The last `limit` events by `seq`, trimmed forward to a boundary so the window never starts
   *  mid-message. */
  readEventsTailByCount(id: SessionId, limit: number): Promise<AguiEvent[]>;

  /** Only RUN_MARKER_TYPES events in seq order, via partial index. */
  readRunMarkers(id: SessionId): Promise<AguiEvent[]>;

  /** The `limit` events immediately before `beforeSeq`, oldest-first, with `firstSeq` to pass back
   *  as the next `beforeSeq` and `done` once the start of the log is reached; not trimmed to a
   *  boundary, since the caller stitches onto a window it already holds. */
  readEventsBefore(
    id: SessionId,
    beforeSeq: number,
    limit: number,
  ): Promise<{ events: AguiEvent[]; firstSeq: number; done: boolean }>;

  /** Up to `limit` events after `afterSeq`, plus its stored checksum. */
  readEventsAfter(id: SessionId, afterSeq: number, limit: number): Promise<EventsAfter>;

  /** Live durable appends, fired in-process only after the row is committed; returns an
   *  unsubscribe. */
  onAppend(cb: (id: SessionId, event: ChecksummedEvent) => void): () => void;

  /** Durable-append failures, which appendEvent's fire-and-forget callers would otherwise never
   *  see. */
  onAppendError(cb: (id: SessionId, error: unknown) => void): () => void;

  /** Drop a conversation's events (conversation deletion). */
  removeConversation(id: SessionId): Promise<void>;

  close(): Promise<void>;
}

export function createPgEventStore(config: PgEventStoreConfig): PgEventStore {
  const ownPool = config.db ? undefined : createPgPool("eventStore", { connectionString: config.dsn!, max: 4 });
  const db: NodePgDatabase = config.db ?? drizzle(ownPool!);

  // Per-conversation write chain, so seq order equals emission order despite void-called appends.
  const chains = new Map<SessionId, Promise<void>>();
  // seq and rolling checksum, folded in chain order and seeded lazily from the table so a restart
  // continues the chain.
  const heads = new Map<SessionId, { seq: number; checksum: string }>();
  const appendListeners: Array<(id: SessionId, e: ChecksummedEvent) => void> = [];
  const errorListeners: Array<(id: SessionId, error: unknown) => void> = [];

  // Refusals per conversation, for log sampling only.
  const refusals = new Map<SessionId, number>();

  /** The fence predicate; see AppendFence for the semantics. */
  const fenceClause = (id: SessionId, gen: number | undefined) => {
    const fence = config.fence;
    if (!fence) return sql.empty();
    const rightEpoch = gen === undefined ? sql.empty() : sql` and ${conversations.hostGeneration} = ${gen}`;
    return sql`
              where exists (
                select 1 from ${conversations}
                 where ${conversations.id} = ${id}
                   and ${conversations.hostPod} = ${fence.pod}${rightEpoch}
              )`;
  };

  /** Which refusal it was, since the statement cannot say. */
  const refusalCause = async (id: SessionId) => {
    try {
      const rows = await db
        .select({ hostPod: conversations.hostPod, hostGeneration: conversations.hostGeneration })
        .from(conversations)
        .where(eq(conversations.id, id))
        .limit(1);
      if (!rows[0]) return { cause: "row-deleted" as const };
      return { cause: "claimed-elsewhere" as const, host_pod: rows[0].hostPod, host_generation: Number(rows[0].hostGeneration) };
    } catch (error) {
      return { cause: "unknown" as const, cause_error: formatError(error) };
    }
  };

  const onFenced = async (id: SessionId, presented: number | undefined) => {
    // The head came from a log this pod no longer drives, so drop it and let a conversation
    // reassigned back re-seed from the table instead of colliding on the PK.
    heads.delete(id);
    try {
      config.onFenced?.(id);
    } catch (err) {
      log.warn("onFenced hook threw", { conversation_id: id, error: formatError(err) });
    }
    const n = (refusals.get(id) ?? 0) + 1;
    refusals.set(id, n);
    if (n === 1 || n % 100 === 0) {
      // presented_generation is the epoch the statement carried rather than a fresh read of
      // the cache, since a refusal is investigated by what was actually presented.
      log.warn("append refused by the conversations row (this pod is not the writer)", {
        conversation_id: id,
        pod: config.fence?.pod,
        presented_generation: presented,
        refused: n,
        ...(await refusalCause(id)),
      });
    }
  };

  const head = async (id: SessionId) => {
    const cached = heads.get(id);
    if (cached) return cached;
    const rows = await db
      .select({ seq: conversationEvents.seq, checksum: conversationEvents.checksum })
      .from(conversationEvents)
      .where(eq(conversationEvents.conversationId, id))
      .orderBy(desc(conversationEvents.seq))
      .limit(1);
    const seeded = rows[0] ? { seq: Number(rows[0].seq), checksum: rows[0].checksum } : { seq: 0, checksum: EMPTY_CHECKSUM };
    heads.set(id, seeded);
    return seeded;
  };

  return {
    appendEvent(id, event) {
      const prev = chains.get(id) ?? Promise.resolve();
      const next = prev
        .catch(() => {}) // a prior failure must not break the chain (ordering)
        .then(async () => {
          try {
            const at = await head(id);
            const prevChecksum = at.checksum;
            const seq = at.seq + 1;
            const checksum = chainNext(prevChecksum, event);
            // Resolved once, so the predicate and the refusal log agree on the epoch presented.
            const presented = config.fence?.generation(id);
            // INSERT ... SELECT so the fence rides the statement. DO NOTHING makes a retry of a write
            // that committed unseen idempotent; the checksum below tells that from a second writer.
            const res = await db.execute(sql`
              insert into ${conversationEvents} (conversation_id, seq, event, checksum, prev_checksum)
              select ${id}::text, ${seq}::bigint, ${JSON.stringify(event)}::jsonb, ${checksum}::text, ${prevChecksum}::text${fenceClause(id, presented)}
              on conflict (conversation_id, seq) do nothing
            `);
            if ((res.rowCount ?? 0) === 0) {
              const existing = await db
                .select({ checksum: conversationEvents.checksum })
                .from(conversationEvents)
                .where(and(eq(conversationEvents.conversationId, id), eq(conversationEvents.seq, seq)))
                .limit(1);
              if (existing[0]?.checksum === checksum) {
                // Our own write, committed on an attempt whose reply was lost.
                heads.set(id, { seq, checksum });
                refusals.delete(id);
                for (const cb of appendListeners) cb(id, { event, prevChecksum, checksum, seq });
                return;
              }
              if (existing[0]) {
                heads.delete(id);
                throw new Error(`seq ${seq} already holds a different event (a second writer)`);
              }
              // Zero rows is only reachable under a fence and is not an error, since the row
              // says this pod is no longer the writer, so neither the head nor the listeners
              // may see an append that was never committed.
              await onFenced(id, presented);
              return;
            }
            heads.set(id, { seq, checksum });
            // Clear the refusal count on a committed append so a later reassignment logs its first
            // refusal immediately.
            refusals.delete(id);
            for (const cb of appendListeners) cb(id, { event, prevChecksum, checksum, seq });
          } catch (error) {
            // Surface the lost turn, then rethrow for any caller that did await.
            log.errorWith("durable append FAILED (turn lost)", error, { conversation_id: id });
            for (const cb of errorListeners) cb(id, error);
            // Drop the cached head, since another writer may have advanced seq.
            heads.delete(id);
            throw error;
          }
        });
      chains.set(id, next);
      return next;
    },

    async flush(id) {
      await (chains.get(id) ?? Promise.resolve()).catch(() => {});
    },

    async *readEvents(id) {
      for await (const c of this.readEventsWithChecksum(id)) yield c.event;
    },

    async *readEventsWithChecksum(id) {
      // Keyset pages on seq, so a long log is never buffered whole.
      let after = 0;
      for (;;) {
        // Read, never recomputed: jsonb does not preserve key order.
        const rows = await db
          .select({
            seq: conversationEvents.seq,
            event: conversationEvents.event,
            checksum: conversationEvents.checksum,
            prevChecksum: conversationEvents.prevChecksum,
          })
          .from(conversationEvents)
          .where(and(eq(conversationEvents.conversationId, id), gt(conversationEvents.seq, after)))
          .orderBy(asc(conversationEvents.seq))
          .limit(READ_PAGE_ROWS);
        for (const r of rows) {
          yield { event: r.event as AguiEvent, checksum: r.checksum, prevChecksum: r.prevChecksum, seq: Number(r.seq) };
        }
        if (rows.length < READ_PAGE_ROWS) return;
        after = Number(rows[rows.length - 1].seq);
      }
    },

    async readEventsTail(id, runs) {
      if (runs <= 0) return [];
      // 1. the seq of the RUN_STARTED that begins the last `runs` runs
      const boundary = await db
        .select({ seq: conversationEvents.seq })
        .from(conversationEvents)
        .where(
          and(
            eq(conversationEvents.conversationId, id),
            sql`${conversationEvents.event}->>'type' = 'RUN_STARTED'`,
          ),
        )
        .orderBy(desc(conversationEvents.seq))
        .offset(runs - 1)
        .limit(1);
      // Fewer runs than asked for (or none): return the whole log.
      const from = boundary[0] ? Number(boundary[0].seq) : 0;
      const rows = await db
        .select({ event: conversationEvents.event })
        .from(conversationEvents)
        .where(and(eq(conversationEvents.conversationId, id), gte(conversationEvents.seq, from)))
        .orderBy(asc(conversationEvents.seq));
      return rows.map((r) => r.event as AguiEvent);
    },

    async readEventsTailByCount(id, limit) {
      if (limit <= 0) return [];
      const rows = await db
        .select({ event: conversationEvents.event })
        .from(conversationEvents)
        .where(eq(conversationEvents.conversationId, id))
        .orderBy(desc(conversationEvents.seq))
        .limit(limit);
      return trimToBoundary(rows.reverse().map((r) => r.event as AguiEvent));
    },

    async readRunMarkers(id) {
      // Must match the conversation_events_run_markers index predicate.
      const rows = await db
        .select({ event: conversationEvents.event })
        .from(conversationEvents)
        .where(
          and(
            eq(conversationEvents.conversationId, id),
            sql`${conversationEvents.event}->>'type' in ('RUN_STARTED', 'RUN_FINISHED', 'RUN_ERROR', 'CANCEL_REQUESTED')`,
          ),
        )
        .orderBy(asc(conversationEvents.seq));
      return rows.map((r) => r.event as AguiEvent);
    },

    async readEventsBefore(id, beforeSeq, limit) {
      if (limit <= 0 || beforeSeq <= 1) return { events: [], firstSeq: beforeSeq, done: true };
      const rows = await db
        .select({ seq: conversationEvents.seq, event: conversationEvents.event })
        .from(conversationEvents)
        .where(and(eq(conversationEvents.conversationId, id), lt(conversationEvents.seq, beforeSeq)))
        .orderBy(desc(conversationEvents.seq))
        .limit(limit);
      rows.reverse();
      const events = rows.map((r) => r.event as AguiEvent);
      const firstSeq = rows[0] ? Number(rows[0].seq) : beforeSeq;
      return { events, firstSeq, done: rows.length < limit || firstSeq <= 1 };
    },

    async readEventsAfter(id, afterSeq, limit) {
      // The anchor row plus limit+1, so overflow is detectable.
      const rows = await db
        .select({
          seq: conversationEvents.seq,
          event: conversationEvents.event,
          checksum: conversationEvents.checksum,
          prevChecksum: conversationEvents.prevChecksum,
        })
        .from(conversationEvents)
        .where(and(eq(conversationEvents.conversationId, id), gte(conversationEvents.seq, afterSeq)))
        .orderBy(asc(conversationEvents.seq))
        .limit(Math.max(0, limit) + 2);
      const anchor = rows[0] && Number(rows[0].seq) === afterSeq ? rows[0].checksum : undefined;
      const after = rows
        .filter((r) => Number(r.seq) > afterSeq)
        .map((r) => ({ event: r.event as AguiEvent, checksum: r.checksum, prevChecksum: r.prevChecksum, seq: Number(r.seq) }));
      return { anchor, events: after.slice(0, limit), more: after.length > limit };
    },

    onAppend(cb) {
      appendListeners.push(cb);
      return () => {
        const i = appendListeners.indexOf(cb);
        if (i >= 0) appendListeners.splice(i, 1);
      };
    },

    onAppendError(cb) {
      errorListeners.push(cb);
      return () => {
        const i = errorListeners.indexOf(cb);
        if (i >= 0) errorListeners.splice(i, 1);
      };
    },

    async removeConversation(id) {
      await db.delete(conversationEvents).where(eq(conversationEvents.conversationId, id));
      heads.delete(id);
      chains.delete(id);
    },

    async close() {
      await ownPool?.end().catch(() => {});
    },
  };
}

/** What backfillConversation wrote, so the Job can verify rather than assume. */
export interface BackfillResult {
  conversationId: SessionId;
  rows: number;
  /** Chain through the last event, to compare against the file's own recomputation. */
  finalChecksum: string;
}

/** Backfill one conversation's events from a .jsonl log, with `lines` in file order; each line is
 *  JSON.parsed and handed to chainNext unmodified so the chain matches the writer's. */
export async function backfillConversation(
  db: NodePgDatabase,
  id: SessionId,
  lines: Iterable<string>,
): Promise<BackfillResult> {
  let checksum = EMPTY_CHECKSUM;
  let seq = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    // Hand the parsed object straight to chainNext: canonicalize sorts only top-level keys, so
    // re-serializing through another writer would change the hash.
    const event = JSON.parse(line) as AguiEvent;
    const prevChecksum = checksum;
    checksum = chainNext(prevChecksum, event);
    seq += 1;
    await db.insert(conversationEvents).values({
      conversationId: id,
      seq,
      event,
      checksum,
      prevChecksum,
    });
  }
  return { conversationId: id, rows: seq, finalChecksum: checksum };
}

/** Drop leading events that cannot open a message, since the client's fold discards a window that starts mid-item. */
export function trimToBoundary(events: AguiEvent[]): AguiEvent[] {
  const OPENS = new Set(["RUN_STARTED", "TEXT_MESSAGE_START", "TOOL_CALL_START", "SYSTEM_MESSAGE"]);
  const i = events.findIndex((e) => OPENS.has(e.type as string));
  return i <= 0 ? (i === 0 ? events : []) : events.slice(i);
}

/** Overlay a PgEventStore's event methods onto a base ConversationStore, which keeps assets and
 *  goose state; the methods are named explicitly so adding one to ConversationStore is a compile
 *  error here. */
export function withPgEvents<T extends object>(base: T, events: PgEventStore): T {
  return {
    ...base,
    appendEvent: events.appendEvent.bind(events),
    flush: events.flush.bind(events),
    readEvents: events.readEvents.bind(events),
    readEventsWithChecksum: events.readEventsWithChecksum.bind(events),
    readEventsTail: events.readEventsTail.bind(events),
    readEventsTailByCount: events.readEventsTailByCount.bind(events),
    readRunMarkers: events.readRunMarkers.bind(events),
    readEventsBefore: events.readEventsBefore.bind(events),
    readEventsAfter: events.readEventsAfter.bind(events),
    onAppend: events.onAppend.bind(events),
    onAppendError: events.onAppendError.bind(events),
    // removeConversation is deliberately not overridden: the base store drops the on-volume assets
    // and the caller drops the event rows.
  } as T;
}
