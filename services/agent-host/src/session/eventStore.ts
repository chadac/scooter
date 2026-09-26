/**
 * The conversation EVENT LOG. One table, no second copy — the rows ARE the log,
 * so there is nothing to reconcile.
 *
 * NOT a notification bus: onAppend fires in-process after a committed insert.
 * No LISTEN/NOTIFY, no triggers.
 */

import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { agent_host } from "@scooter/schema";

import { chainNext, EMPTY_CHECKSUM } from "../agui/integrity.js";
import { formatError, logger } from "../log.js";
import { createPgPool } from "../db/pgPool.js";
import type { AguiEvent } from "../bridge.js";
import type { ChecksummedEvent } from "./manager.js";
import type { SessionId } from "../types.js";

const log = logger("eventStore");
// conversations is read ONLY by the append fence — never written here. The event log owns
// no conversation metadata.
const { conversationEvents, conversations } = agent_host;

export interface PgEventStoreConfig {
  /** Postgres connection string. Ignored when `db` is supplied. */
  dsn?: string;
  /** Override the database handle (tests). Defaults to a hardened pool over `dsn`. */
  db?: NodePgDatabase;
  /** The claim every append presents. Omitted (single-replica, kube-less dev) => appends
   *  are unconditional, exactly as before. See AppendFence. */
  fence?: AppendFence;
}

/**
 * THE APPEND FENCE. Every insert carries this pod's claim and the row decides, so a
 * superseded pod learns it lost FROM THE WRITE IT WAS ALREADY MAKING — no extra query on
 * a path that runs once per streamed token.
 *
 * Strictly stronger than the cached canWrite() check it backs up, in two ways. It has no
 * staleness window: the fence reads the row in the same statement as the insert, where the
 * cache can be a watch-lag behind. And it covers EVERY writer — canWrite() guards one of
 * the seven appendEvent call sites, while a fence on the statement cannot be forgotten by
 * a new one.
 *
 * It fences on CONTRADICTION only: an append is refused when the row names a different
 * host, or this pod at a different epoch. A row that names nobody — or no row at all —
 * does not refuse, because existence is not this fence's job and a brand-new conversation
 * appends before anything has assigned it. Refusing an absent claim outright ("no
 * generation => no writes") requires reading the claim from the ROW; while it comes from
 * the CR watch, an unobserved-but-assigned conversation is indistinguishable from an
 * unassigned one, and failing closed there would drop first turns.
 */
export interface AppendFence {
  /** This pod's name — the identity the row must not contradict. */
  pod: string;
  /** The epoch this pod believes it holds `id` under, or undefined when it has observed no
   *  assignment. Undefined narrows the fence to pod identity rather than widening it to
   *  allow-all: presenting an epoch nobody assigned would refuse every append. */
  generation(id: SessionId): number | undefined;
}

/** The event-log half of ConversationStore, backed by conversation_events. */
export interface PgEventStore {
  /**
   * Append one event. FIRE-AND-FORGET at the call site (`void append(...)`), so
   * ordering cannot depend on the caller awaiting.
   *
   * `seq` comes from an in-process per-conversation counter on the same write
   * chain the file store uses, because one pod owns a conversation at a time —
   * which the statement itself now ENFORCES when a fence is configured, rather
   * than assuming (see AppendFence). The PK (conversation_id, seq) stays as the
   * backstop for the unfenced case and for a fence that was wrong.
   *
   * MUST NOT use ON CONFLICT DO NOTHING — a PK conflict here means two writers.
   *
   * RESOLVES, does not throw, when the fence refuses: losing the claim is an
   * outcome, not a failure, and every caller `void`s this.
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
   * The events from the last `runs` runs — a fast first-paint window.
   *
   * ORDERED BY seq, NOT by ts. `seq` is the single ordering in this store: it is
   * assigned in emission order by the one pod that owns the conversation, so it
   * IS the chronology. The file store had to sort by `ts` first because a log
   * concatenated runs from separate processes across a restart and append order
   * could disagree with time; a monotonic per-conversation counter has no such
   * seam, which is why this store does not inherit that complexity.
   *
   * Windowed on RUN_STARTED boundaries, NOT a raw "last N events": the tail must
   * fold identically to a full replay, and slicing mid-run can cut a
   * TEXT_MESSAGE_START from its END and render a half-message.
   *
   * Two index scans, no window function (measured on a 6k-event conversation):
   *   1. boundary — ORDER BY seq DESC, filter type=RUN_STARTED, OFFSET runs-1
   *      LIMIT 1  → Index Scan Backward, reads ~`runs` rows
   *   2. window   — WHERE seq >= boundary ORDER BY seq  → Index Scan, ~67 rows
   * That is ~75 rows read instead of all 6,046.
   */
  readEventsTail(id: SessionId, runs: number): Promise<AguiEvent[]>;

  /** The last `limit` events by `seq`, trimmed forward to a boundary so the window
   *  never starts mid-message. May return fewer than `limit`. */
  readEventsTailByCount(id: SessionId, limit: number): Promise<AguiEvent[]>;

  /** The `limit` events immediately BEFORE `beforeSeq`, oldest-first, for paging
   *  older history in. `firstSeq` is the lowest seq returned — pass it back as the
   *  next `beforeSeq` — and `done` is true once the window reaches the start of the
   *  log. Unlike the tail readers this does NOT trim to a boundary: the caller is
   *  stitching onto a window it already holds, so a run split across the seam stays
   *  whole. */
  readEventsBefore(
    id: SessionId,
    beforeSeq: number,
    limit: number,
  ): Promise<{ events: AguiEvent[]; firstSeq: number; done: boolean }>;

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
  const ownPool = config.db ? undefined : createPgPool("eventStore", { connectionString: config.dsn!, max: 4 });
  const db: NodePgDatabase = config.db ?? drizzle(ownPool!);

  // Per-conversation write chain. appendEvent is `void`-called for a burst of
  // events, so concurrent awaits would land in non-deterministic order and
  // scramble the log — serialize them so seq order == emission order.
  const chains = new Map<SessionId, Promise<void>>();
  // seq + rolling checksum, folded in the SAME chain order as the inserts.
  // Seeded lazily from the table so a restart CONTINUES the chain rather than
  // reseeding from EMPTY (which would fork every client's verification).
  const heads = new Map<SessionId, { seq: number; checksum: string }>();
  const appendListeners: Array<(id: SessionId, e: ChecksummedEvent) => void> = [];
  const errorListeners: Array<(id: SessionId, error: unknown) => void> = [];

  // Refusals per conversation, for log sampling only. A fenced pod streaming a run refuses
  // once per token, and one line each would bury the reassignment that caused it.
  const refusals = new Map<SessionId, number>();

  /** The fence predicate, or nothing when unfenced. See AppendFence for the semantics;
   *  `not exists (... contradiction ...)` is what makes a missing or unclaimed row allow. */
  const fenceClause = (id: SessionId, gen: number | undefined) => {
    const fence = config.fence;
    if (!fence) return sql.empty();
    const wrongEpoch = gen === undefined ? sql.empty() : sql` or ${conversations.hostGeneration} <> ${gen}`;
    return sql`
              where not exists (
                select 1 from ${conversations}
                 where ${conversations.id} = ${id}
                   and ${conversations.hostPod} is not null
                   and (${conversations.hostPod} <> ${fence.pod}${wrongEpoch})
              )`;
  };

  const onFenced = (id: SessionId, presented: number | undefined) => {
    // The head came from a log this pod no longer drives; the new owner is advancing seq
    // past it. Drop it so a conversation reassigned BACK re-seeds from the table instead of
    // colliding on the PK.
    heads.delete(id);
    const n = (refusals.get(id) ?? 0) + 1;
    refusals.set(id, n);
    if (n === 1 || n % 100 === 0) {
      // presented_generation is the epoch the STATEMENT carried, not a fresh read of the
      // cache: an investigation into a refusal needs what was actually presented.
      log.warn("append fenced by the conversations row (this pod is not the host)", {
        conversation_id: id,
        pod: config.fence?.pod,
        presented_generation: presented,
        refused: n,
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
        .catch(() => {}) // a prior failure must not break the CHAIN (ordering)
        .then(async () => {
          try {
            const at = await head(id);
            const prevChecksum = at.checksum;
            const seq = at.seq + 1;
            const checksum = chainNext(prevChecksum, event);
            // Resolved ONCE, so the statement's predicate and the refusal log cannot
            // disagree about which epoch was presented.
            const presented = config.fence?.generation(id);
            // INSERT ... SELECT, not VALUES, so the fence can ride the statement (see
            // AppendFence). NO onConflictDoNothing: the PK is a correctness backstop, and
            // a duplicate (conversation_id, seq) means a second writer.
            const res = await db.execute(sql`
              insert into ${conversationEvents} (conversation_id, seq, event, checksum, prev_checksum)
              select ${id}::text, ${seq}::bigint, ${JSON.stringify(event)}::jsonb, ${checksum}::text, ${prevChecksum}::text${fenceClause(id, presented)}
            `);
            if ((res.rowCount ?? 0) === 0) {
              // Zero rows is only reachable under a fence, and it is not an error: the row
              // says this pod is no longer the writer. Do NOT advance the head or notify
              // listeners — nothing was committed, and claiming otherwise would hand the
              // integrity stream a checksum no reader can find.
              onFenced(id, presented);
              return;
            }
            heads.set(id, { seq, checksum });
            // Clear the refusal count on a committed append, so a LATER reassignment logs
            // its first refusal immediately instead of landing mid-sample-window. Also what
            // bounds the map.
            refusals.delete(id);
            for (const cb of appendListeners) cb(id, { event, prevChecksum, checksum });
          } catch (error) {
            // appendEvent is `void`-called, so nobody sees this rejection. With
            // no file fallback it is a LOST TURN — surface it, then rethrow for
            // any caller that did await.
            log.errorWith("durable append FAILED (turn lost)", error, { conversation_id: id });
            for (const cb of errorListeners) cb(id, error);
            // Drop the cached head: after a failure this pod's idea of seq may
            // be wrong (another writer), so re-seed from the table next time.
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
      // checksum/prev_checksum are READ, never recomputed: jsonb does not
      // preserve key order, so a re-derived chain could not match the writer's.
      const rows = await db
        .select({
          event: conversationEvents.event,
          checksum: conversationEvents.checksum,
          prevChecksum: conversationEvents.prevChecksum,
        })
        .from(conversationEvents)
        .where(eq(conversationEvents.conversationId, id))
        .orderBy(asc(conversationEvents.seq));
      for (const r of rows) {
        yield { event: r.event as AguiEvent, checksum: r.checksum, prevChecksum: r.prevChecksum };
      }
    },

    async readEventsTail(id, runs) {
      if (runs <= 0) return [];
      // 1. the seq of the RUN_STARTED that begins the last `runs` runs. Index
      //    Scan Backward, so it reads ~runs rows, not the conversation.
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

export async function backfillConversation(
  db: NodePgDatabase,
  id: SessionId,
  lines: Iterable<string>,
): Promise<BackfillResult> {
  let checksum = EMPTY_CHECKSUM;
  let seq = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    // JSON.parse and hand the object straight to chainNext: canonicalize sorts
    // only TOP-LEVEL keys, so nested order comes from the parse. Re-serializing
    // through any other writer would produce a different hash.
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

/**
 * Overlay a PgEventStore's event methods onto a base ConversationStore.
 *
 * The event log is the only thing that moved: assets and goose state still live
 * on the state volume, so the base store stays for those. This is a narrow
 * seam, not a Proxy — the event methods are named explicitly so adding one to
 * ConversationStore is a compile error here rather than a silent fall-through
 * to the file implementation the migration was meant to replace.
 */
/** Drop leading events that cannot open a message — the client's fold discards a
 *  window that starts mid-item. */
export function trimToBoundary(events: AguiEvent[]): AguiEvent[] {
  const OPENS = new Set(["RUN_STARTED", "TEXT_MESSAGE_START", "TOOL_CALL_START", "SYSTEM_MESSAGE"]);
  const i = events.findIndex((e) => OPENS.has(e.type as string));
  return i <= 0 ? (i === 0 ? events : []) : events.slice(i);
}

export function withPgEvents<T extends object>(base: T, events: PgEventStore): T {
  return {
    ...base,
    appendEvent: events.appendEvent.bind(events),
    flush: events.flush.bind(events),
    readEvents: events.readEvents.bind(events),
    readEventsWithChecksum: events.readEventsWithChecksum.bind(events),
    readEventsTail: events.readEventsTail.bind(events),
    readEventsTailByCount: events.readEventsTailByCount.bind(events),
    readEventsBefore: events.readEventsBefore.bind(events),
    onAppend: events.onAppend.bind(events),
    onAppendError: events.onAppendError.bind(events),
    // Deliberately NOT overridden: removeConversation must drop BOTH the rows
    // and the on-volume assets, so the base store's version runs and the caller
    // is responsible for the event rows (see index.ts).
  } as T;
}
