/**
 * mirroredConversationStore — LOCAL is the hot-path authority; a SECOND store (the
 * NFS/RWX mirror) receives an ASYNC, fire-and-forget COPY of every write, so a
 * different pod can revive the conversation from the mirror after the owner pod moves.
 *
 * Design + validation: todo/docs/CONVERSATION_CRD_AND_HISTORY.md + the
 * rwx-append-mirror-spike. Two invariants the spike proved matter:
 *
 *   1. The mirror NEVER blocks local. Every mirror write is fire-and-forget; the
 *      caller's appendEvent()/flush() see ONLY the local result. NFS latency cannot
 *      back-pressure the streaming hot path.
 *   2. The event-append mirror COALESCES. appendEvent fires once per streamed token-
 *      chunk; a naive per-event NFS write can't keep up at EFS latency (backlog grows
 *      unbounded). Buffering appends and flushing them as ONE NFS write per size/time
 *      window keeps the backlog bounded — and batching a BACKUP is free (the live UI
 *      is served from the LOCAL onAppend, not the mirror).
 *
 * All READS come from LOCAL (the authority on the owning pod). Low-frequency writes
 * (meta/jobs/links/remove) mirror per-call (no coalescing needed).
 * Mirror errors are non-fatal — logged via onMirrorError; local persistence is intact.
 */

import { logger } from "../log.js";
import { chainNext, EMPTY_CHECKSUM } from "../agui/integrity.js";
import type { AguiEvent } from "../bridge.js";
import type { SessionId } from "../types.js";
import type {
  ConversationStore,
  ConversationMeta,
  ConversationLink,
  ChecksummedEvent,
} from "./manager.js";
import type { JobRecord } from "./jobManager.js";

const log = logger("mirror");

export interface MirrorOptions {
  /** Max buffered events before an immediate mirror flush. */
  maxBatch?: number;
  /** Max ms to hold a partial batch before flushing. */
  maxWaitMs?: number;
  /** Notified on a mirror-write failure (non-fatal — local is intact). */
  onMirrorError?: (id: SessionId, error: unknown) => void;
}

/** A per-conversation coalescing buffer that flushes queued events to the mirror as
 *  ONE appendEvent-batch per window. The mirror store's appendEvent is itself
 *  serialized per id, so calling it in order preserves log order on the mirror. */
class CoalescingMirror {
  private readonly buffers = new Map<SessionId, AguiEvent[]>();
  private readonly timers = new Map<SessionId, ReturnType<typeof setTimeout>>();
  /** Per-id tail promise so mirror appends stay ordered + so drain() can await them. */
  private readonly chains = new Map<SessionId, Promise<void>>();

  constructor(
    private readonly mirror: ConversationStore,
    private readonly maxBatch: number,
    private readonly maxWaitMs: number,
    private readonly onError: (id: SessionId, error: unknown) => void,
  ) {}

  enqueue(id: SessionId, event: AguiEvent): void {
    const buf = this.buffers.get(id) ?? [];
    buf.push(event);
    this.buffers.set(id, buf);
    if (buf.length >= this.maxBatch) {
      this.clearTimer(id);
      this.flush(id);
    } else if (!this.timers.has(id)) {
      const t = setTimeout(() => { this.timers.delete(id); this.flush(id); }, this.maxWaitMs);
      (t as { unref?: () => void }).unref?.();
      this.timers.set(id, t);
    }
  }

  /** Flush the buffered events for `id` onto the mirror's ordered per-id chain. */
  private flush(id: SessionId): void {
    const batch = this.buffers.get(id);
    if (!batch || batch.length === 0) return;
    this.buffers.set(id, []);
    const prev = this.chains.get(id) ?? Promise.resolve();
    const next = prev
      .catch(() => {}) // a prior mirror failure must not break ORDER of the next batch
      .then(async () => {
        for (const ev of batch) await this.mirror.appendEvent(id, ev);
      })
      .catch((e) => this.onError(id, e));
    this.chains.set(id, next);
  }

  /** Flush all buffers + await every in-flight mirror chain (clean-shutdown drain). */
  async drain(id?: SessionId): Promise<void> {
    const ids = id ? [id] : [...new Set([...this.buffers.keys(), ...this.chains.keys()])];
    for (const i of ids) { this.clearTimer(i); this.flush(i); }
    await Promise.all(ids.map((i) => this.chains.get(i) ?? Promise.resolve()));
  }

  private clearTimer(id: SessionId): void {
    const t = this.timers.get(id);
    if (t) { clearTimeout(t); this.timers.delete(id); }
  }
}

/**
 * Wrap `local` so every write is also mirrored (async, non-blocking) to `mirror`.
 * Reads + flush + subscriptions pass through to LOCAL. Returns a ConversationStore
 * plus a `drainMirror()` for graceful shutdown (the SIGTERM handler awaits it so a
 * planned rollout ships the mirror's tail — near-RPO-0; see #248).
 */
export function mirroredConversationStore(
  local: ConversationStore,
  mirror: ConversationStore,
  opts: MirrorOptions = {},
): ConversationStore & {
  drainMirror: (id?: SessionId) => Promise<void>;
  /** Pull one conversation's durable state MIRROR→LOCAL (revive-on-assign). Returns false
   *  if the mirror has no such conversation. See the method + ROLLOUT_DRAIN_AND_POD_IP.md. */
  hydrateFromMirror: (id: SessionId) => Promise<boolean>;
  /** Read the DURABLE history for a conversation: the mirror's log when it is longer than local,
   *  else local. Used by revive HISTORY-REINJECTION (loadHistory) so a fresh goose session gets the
   *  real transcript even when this pod's LOCAL emptyDir was wiped (restart/rollout) or is a stale
   *  stub (a different pod owned + mirrored later runs). Reading plain `readEvents` (local-only) there
   *  made the model start from a BLANK slate after any restart. See the revive-reinjection bug. */
  readEventsDurable: (id: SessionId) => AsyncIterable<AguiEvent>;
  /** Checksummed durable replay — what the integrity stream reads. PR #405. */
  readEventsDurableWithChecksum: (id: SessionId) => AsyncIterable<ChecksummedEvent>;
} {
  const onErr = opts.onMirrorError ?? ((id, e) =>
    log.errorWith("write failed (local intact)", e, { conversation_id: id }));
  const coalescer = new CoalescingMirror(
    mirror,
    opts.maxBatch ?? 64,
    opts.maxWaitMs ?? 100,
    onErr,
  );

  // Fire a low-frequency mirror write without ever blocking or rejecting the caller.
  const mirrorWrite = (id: SessionId, fn: () => Promise<void> | undefined): void => {
    Promise.resolve()
      .then(() => fn())
      .catch((e) => onErr(id, e));
  };

  return {
    // --- the HOT path: local authority + coalesced async mirror ---
    async appendEvent(id, event) {
      const p = local.appendEvent(id, event); // caller-visible durability = LOCAL only
      coalescer.enqueue(id, event);           // async, coalesced, never awaited here
      return p;
    },
    // flush = LOCAL only (must NOT wait on the mirror — that would reintroduce blocking).
    flush: local.flush ? (id) => local.flush!(id) : undefined,
    drainMirror: (id) => coalescer.drain(id),

    // --- READS: always LOCAL (the authority on the owning pod) ---
    readEvents: (id) => local.readEvents(id),
    readEventsWithChecksum: local.readEventsWithChecksum
      ? (id) => local.readEventsWithChecksum!(id) : undefined,
    // Rewrite passes through to LOCAL (reconciliation writes the healed log locally). The mirror is
    // the source we're reconciling FROM, so we don't rewrite it here.
    replaceEvents: local.replaceEvents
      ? (id, events) => local.replaceEvents!(id, events) : undefined,
    readEventsTail: local.readEventsTail
      ? (id, runs) => local.readEventsTail!(id, runs) : undefined,
    listJobs: local.listJobs ? (id) => local.listJobs!(id) : undefined,
    listLinks: local.listLinks ? (id) => local.listLinks!(id) : undefined,
    // LIST FROM THE DURABLE STORE, not the local cache. LOCAL_STATE_PATH is an emptyDir: after a
    // rollout it is EMPTY, so delegating here made every replica report zero conversations while
    // the mirror held the full history (measured on odin: 59 durable vs 0 local, all five replicas
    // serving []). The user's sidebar went blank even though nothing was lost. The local store is
    // a cache and must never be what answers "which conversations exist?".
    //
    // UNION rather than mirror-only: the mirror is async + coalesced, so a just-created
    // conversation can be local-only for a moment and would otherwise flicker out of the list.
    // Local wins on conflict — it is the hot path and its meta (title, activity) is the freshest.
    listConversations:
      local.listConversations || mirror.listConversations
        ? async () => {
            const [localMetas, mirrorMetas] = await Promise.all([
              Promise.resolve(local.listConversations?.() ?? []).catch(() => []),
              // A mirror read failure must not blank the list; fall back to whatever local has.
              Promise.resolve(mirror.listConversations?.() ?? []).catch((err) => {
                log.errorWith("listConversations failed (serving local only)", err);
                return [];
              }),
            ]);
            const byId = new Map<string, (typeof mirrorMetas)[number]>();
            for (const m of mirrorMetas) byId.set(m.id as string, m);
            for (const m of localMetas) byId.set(m.id as string, m); // local wins
            return [...byId.values()];
          }
        : undefined,
    gooseStatePath: (id) => local.gooseStatePath(id),

    // --- subscriptions: LOCAL (the live stream the UI verifies is the local append) ---
    onAppend: local.onAppend ? (cb) => local.onAppend!(cb) : undefined,
    onAppendError: local.onAppendError ? (cb) => local.onAppendError!(cb) : undefined,

    // --- low-frequency WRITES: local awaited + mirrored per-call (fire-and-forget) ---
    saveMeta: local.saveMeta
      ? async (meta) => { const p = local.saveMeta!(meta); mirrorWrite(meta.id as SessionId, () => mirror.saveMeta?.(meta)); return p; }
      : undefined,
    saveJob: local.saveJob
      ? async (id, job) => { const p = local.saveJob!(id, job); mirrorWrite(id, () => mirror.saveJob?.(id, job)); return p; }
      : undefined,
    updateJob: local.updateJob
      ? async (id, job) => { const p = local.updateJob!(id, job); mirrorWrite(id, () => mirror.updateJob?.(id, job)); return p; }
      : undefined,
    addLink: local.addLink
      ? async (id, link) => { const p = local.addLink!(id, link); mirrorWrite(id, () => mirror.addLink?.(id, link)); return p; }
      : undefined,
    removeConversation: local.removeConversation
      ? async (id) => { const p = local.removeConversation!(id); mirrorWrite(id, () => mirror.removeConversation?.(id)); return p; }
      : undefined,

    // REVIVE-ON-ASSIGN (seamless rollout): copy ONE conversation's durable state from the
    // MIRROR into LOCAL, so a pod that never owned it can hydrate + revive it after a rollout
    // reassigned it here. Reads pass through to local (the hot authority), so a
    // mirror-only conversation is invisible until this pulls it local. See
    // todo/docs/ROLLOUT_DRAIN_AND_POD_IP.md + manager.reviveFromMirror.
    async hydrateFromMirror(id: SessionId): Promise<boolean> {
      // 1) meta — without it the conversation isn't listable/hydratable locally.
      const metas = (await mirror.listConversations?.()) ?? [];
      const meta = metas.find((m) => (m.id as SessionId) === id);
      if (!meta) return false; // the mirror doesn't have it either — genuinely unknown.
      await local.saveMeta?.(meta);

      // 2) events — reconcile local ↔ mirror by CONTENT (integrity checksum chain), NOT by position.
      // The old count-based splice assumed local was a strict PREFIX of the mirror; when a DIFFERENT
      // pod processed + mirrored a run this pod never had, local FORKS from the mirror and a
      // "keep local[0..localCount], append mirror after localCount" splice grafts two divergent
      // branches (dropping the mirror's unique events). Instead: walk both in lockstep, find the
      // longest COMMON PREFIX (matching rolling checksums), then:
      //   - local is a prefix of the mirror  → append the mirror's tail (fast path, no rewrite);
      //   - the logs DIVERGE at the fork      → the MIRROR wins (multi-writer source of truth):
      //     rewrite local to the mirror's full log via replaceEvents (never splice across a fork).
      const localEvents: AguiEvent[] = [];
      try {
        for await (const ev of local.readEvents(id)) localEvents.push(ev);
      } catch { /* local has none yet */ }
      const mirrorEvents: AguiEvent[] = [];
      for await (const ev of mirror.readEvents(id)) mirrorEvents.push(ev);

      // Longest common prefix by rolling checksum (content identity, restart-stable).
      let common = 0;
      let chk = EMPTY_CHECKSUM;
      const max = Math.min(localEvents.length, mirrorEvents.length);
      while (common < max) {
        const lc = chainNext(chk, localEvents[common]);
        const mc = chainNext(chk, mirrorEvents[common]);
        if (lc !== mc) break; // first divergence
        chk = lc;
        common++;
      }

      if (common === localEvents.length) {
        // Local is a (possibly empty) PREFIX of the mirror — append only the missing tail. Idempotent.
        for (let i = common; i < mirrorEvents.length; i++) await local.appendEvent(id, mirrorEvents[i]);
      } else {
        // Local DIVERGED (it has events after the common prefix that the mirror doesn't match). The
        // mirror is authoritative → rewrite local to it. Prefer replaceEvents; if the store can't
        // rewrite, log loudly (a divergent local we can't heal is a real integrity problem).
        if (local.replaceEvents) {
          await local.replaceEvents(id, mirrorEvents);
        } else {
          onErr(id, new Error(
            `hydrateFromMirror: local diverged from mirror at event ${common} but the store has no ` +
            `replaceEvents — cannot reconcile a fork; local left as-is (transcript may be incomplete)`,
          ));
        }
      }

      return true;
    },

    // Durable read for history-reinjection: yield whichever copy is LONGER (the mirror is the
    // multi-writer superset when local is empty/stale — the after-restart memory-loss root cause).
    // If they tie or the mirror is behind, local wins (the hot authority). Reads EACH store at most
    // ONCE (buffer both, yield the winner) — no re-read of the winning log, which matters for a large
    // log over NFS. loadHistory buffers into an array anyway, so materializing here costs nothing
    // extra. NOTE: coarse LENGTH comparison — a truly DIVERGENT local (a fork, not a prefix) is
    // reconciled by CONTENT in hydrateFromMirror (see PR2); here we only need "don't reinject from an
    // empty/short local".
    // The rolling checksum chained over whichever log readEventsDurable picks. PR #405.
    async *readEventsDurableWithChecksum(id: SessionId): AsyncIterable<ChecksummedEvent> {
      let prev = EMPTY_CHECKSUM;
      for await (const event of this.readEventsDurable(id)) {
        const checksum = chainNext(prev, event);
        yield { event, prevChecksum: prev, checksum };
        prev = checksum;
      }
    },

    async *readEventsDurable(id: SessionId): AsyncIterable<AguiEvent> {
      const localEvents: AguiEvent[] = [];
      try {
        for await (const ev of local.readEvents(id)) localEvents.push(ev);
      } catch { /* local has none */ }
      const mirrorEvents: AguiEvent[] = [];
      try {
        for await (const ev of mirror.readEvents(id)) mirrorEvents.push(ev);
      } catch { /* mirror unreadable — fall back to local */ }
      yield* mirrorEvents.length > localEvents.length ? mirrorEvents : localEvents;
    },
  };
}
