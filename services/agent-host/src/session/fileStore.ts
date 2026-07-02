/**
 * File-backed ConversationStore — appends AG-UI events as JSONL on the
 * conversation-state PVC (mounted by the agent-host), one file per conversation.
 *
 * Revival replays the JSONL. Goose's own session state lives alongside under
 * gooseStatePath(id). A richer store (indexing, compaction) can come later.
 */

import { appendFile, mkdir, readFile, writeFile, rename, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { AguiEvent } from "../bridge.js";
import type { ConversationStore, ConversationMeta, ChecksummedEvent, ConversationLink } from "./manager.js";
import type { SessionId } from "../types.js";
import { EMPTY_CHECKSUM, chainNext } from "../agui/integrity.js";

// Atomic whole-file write: write a temp sibling then rename over the target.
// rename(2) is atomic on POSIX, so a concurrent reader (e.g. listConversations()
// during a hydrate in another replica, or a fire-and-forget setTitle/activity
// write) always sees either the complete old file or the complete new one —
// never a truncated/partial one. writeFile alone truncates-then-writes, which a
// concurrent read can catch mid-flight (-> a torn JSON.parse that drops the
// record). A monotonic counter keeps temp names unique under concurrent writes.
let atomicSeq = 0;
async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${atomicSeq++}`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}

/** True for "file/dir does not exist" — the ONE benign read error (a genuinely
 *  new/empty conversation, or the state dir before first write). Findings #11/#12:
 *  every OTHER read error (EACCES/EIO/unmounted PVC) is a real failure that must
 *  NOT be silently flattened to empty — that replays a real conversation as blank
 *  history, or vanishes the entire conversation list after a restart. */
function isENOENT(e: unknown): boolean {
  return (e as { code?: string })?.code === "ENOENT";
}

export function createFileConversationStore(root: string): ConversationStore {
  const logPath = (id: SessionId) => join(root, id, "events.jsonl");
  const metaPath = (id: SessionId) => join(root, id, "meta.json");
  const linksPath = (id: SessionId) => join(root, id, "links.json");
  const ensureDir = (id: SessionId) => mkdir(join(root, id), { recursive: true });

  // Per-conversation write chain: appendEvent is fired-and-forgotten (void) for
  // a burst of events (e.g. a user prompt's START/CONTENT/END), so concurrent
  // awaits on appendFile would land in non-deterministic order and SCRAMBLE the
  // log (END before START) — which breaks history replay on switch/revive.
  // Serialize all appends per conversation so on-disk order == emission order.
  const writeChains = new Map<SessionId, Promise<void>>();

  // Per-conversation rolling integrity checksum, folded in the SAME write-chain
  // order as the on-disk log (so live checksums match history). Seeded from disk
  // on first touch after a restart. `onAppend` subscribers receive the
  // checksummed event after it's durably written — this is the live stream the
  // UI verifies against.
  const checksums = new Map<SessionId, string>();
  const seeded = new Set<SessionId>();
  const appendListeners = new Set<(id: SessionId, c: ChecksummedEvent) => void>();
  // Finding #4: observers notified when a durable append FAILS, so a lost turn
  // leaves a trace (log + metric/health signal) instead of vanishing silently.
  const appendErrorListeners = new Set<(id: SessionId, error: unknown) => void>();

  const seedChecksum = async (id: SessionId): Promise<string> => {
    if (seeded.has(id)) return checksums.get(id) ?? EMPTY_CHECKSUM;
    let acc = EMPTY_CHECKSUM;
    try {
      const data = await readFile(logPath(id), "utf8");
      for (const line of data.split("\n")) {
        if (line.trim()) acc = chainNext(acc, JSON.parse(line) as AguiEvent);
      }
    } catch (e) {
      // Finding #20: ENOENT = no log yet (a new conversation) -> empty seed is
      // correct and silent. But a PARSE or I/O error here mis-seeds the integrity
      // checksum from a corrupt/unreadable log — and the integrity chain exists
      // precisely to detect corruption, so swallowing it silently defeats it. Log
      // loudly for anything other than not-found.
      if (!isENOENT(e)) {
        // eslint-disable-next-line no-console
        console.error(`[fileStore] checksum seed for ${id} failed to read/parse the log (integrity may be off):`, e);
      }
    }
    if (!seeded.has(id)) {
      checksums.set(id, acc);
      seeded.add(id);
    }
    return checksums.get(id)!;
  };

  return {
    appendEvent(id, event) {
      const prev = writeChains.get(id) ?? Promise.resolve();
      const next = prev
        .catch(() => {}) // a prior failure must not break the CHAIN (ordering)
        .then(async () => {
          try {
            await ensureDir(id);
            // Seed the rolling checksum from the log as it exists BEFORE this
            // append (lazy, once after a restart) — so prevChecksum is the chain
            // through the prior events, not including the one we're about to write.
            const prevChecksum = await seedChecksum(id);
            await appendFile(logPath(id), JSON.stringify(event) + "\n", "utf8");
            // Fold this event in (write order) and notify live subscribers.
            const checksum = chainNext(prevChecksum, event);
            checksums.set(id, checksum);
            for (const cb of appendListeners) cb(id, { event, prevChecksum, checksum });
          } catch (error) {
            // Finding #4: this append failed (ENOSPC/EACCES/unmounted PVC). The
            // log+chain catch above keeps ORDERING but would otherwise swallow
            // THIS failure — and the caller is `void store.appendEvent(...)`, so
            // nobody sees the rejection. Surface it loudly + notify observers
            // (the only persistence the conversation has just lost a turn), THEN
            // rethrow so an awaiting caller (tests, sync writers) sees it too.
            // eslint-disable-next-line no-console
            console.error(`[fileStore] durable append FAILED for ${id} (turn lost):`, error);
            for (const cb of appendErrorListeners) {
              try { cb(id, error); } catch { /* an observer must not break the store */ }
            }
            throw error;
          }
        });
      // The chain advances on the SETTLED promise (so a failed write doesn't wedge
      // the next append's ordering), but `next` itself preserves the rejection for
      // the caller.
      writeChains.set(id, next.catch(() => {}));
      return next;
    },

    onAppend(cb) {
      appendListeners.add(cb);
      return () => appendListeners.delete(cb);
    },

    onAppendError(cb) {
      appendErrorListeners.add(cb);
      return () => appendErrorListeners.delete(cb);
    },

    async *readEvents(id): AsyncIterable<AguiEvent> {
      let data: string;
      try {
        data = await readFile(logPath(id), "utf8");
      } catch (e) {
        // Finding #11: ENOENT = no log yet (a new conversation) — yield nothing.
        // Any OTHER error (EACCES/EIO/unmounted PVC) means a REAL conversation's
        // log can't be read; returning empty would replay it as blank history and
        // hide the failure. Propagate instead.
        if (isENOENT(e)) return;
        throw e;
      }
      for (const line of data.split("\n")) {
        if (line.trim()) yield JSON.parse(line) as AguiEvent;
      }
    },

    async readEventsTail(id, runs) {
      // The RECENT tail only: the events from the last `runs` runs, for a fast
      // first paint on a LONG conversation. We read the file (one syscall) but scan
      // lines from the END to find the last `runs` RUN_STARTED boundaries by a cheap
      // string test, and JSON.parse ONLY the windowed tail lines — not the whole
      // log (which is what made the naive route as slow as a full replay).
      let data: string;
      try {
        data = await readFile(logPath(id), "utf8");
      } catch (e) {
        if (isENOENT(e)) return [];
        throw e;
      }
      if (runs <= 0) return [];
      const lines = data.split("\n").filter((l) => l.trim());
      // Walk backward, counting RUN_STARTED markers; stop once we've passed `runs`.
      let start = 0;
      let seen = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].includes('"RUN_STARTED"')) {
          seen += 1;
          start = i;
          if (seen >= runs) break;
        }
      }
      // If there were fewer than `runs` RUN_STARTED markers, start stays at the
      // first RUN_STARTED found (or 0). Parse only the windowed slice.
      return lines.slice(start).map((l) => JSON.parse(l) as AguiEvent);
    },

    async *readEventsWithChecksum(id): AsyncIterable<ChecksummedEvent> {
      let prev = EMPTY_CHECKSUM;
      for await (const event of this.readEvents(id)) {
        const checksum = chainNext(prev, event);
        yield { event, prevChecksum: prev, checksum };
        prev = checksum;
      }
    },

    async recordActivity(id, at) {
      await ensureDir(id);
      // Last-activity marker — small, overwritten; queryable by an external
      // lifecycle manager that mounts the same PVC.
      await writeFileAtomic(join(root, id, "activity.json"), JSON.stringify({ lastActivityAt: at }));
    },

    async saveMeta(meta: ConversationMeta) {
      await ensureDir(meta.id);
      await writeFileAtomic(metaPath(meta.id), JSON.stringify(meta));
    },

    async addLink(id: SessionId, link: ConversationLink) {
      await ensureDir(id);
      const existing = await this.listLinks!(id);
      const key = (l: ConversationLink) => `${l.source}|${l.resourceType}|${l.url ?? l.title ?? ""}`;
      if (existing.some((l) => key(l) === key(link))) return; // dedup
      await writeFileAtomic(linksPath(id), JSON.stringify([...existing, link]));
    },

    async listLinks(id: SessionId): Promise<ConversationLink[]> {
      try {
        return JSON.parse(await readFile(linksPath(id), "utf8")) as ConversationLink[];
      } catch {
        return [];
      }
    },

    /** Permanently remove a conversation's persisted state (meta + event log +
     *  activity + goose state) so an ended/deleted conversation does NOT come
     *  back on the next hydrate(). */
    async removeConversation(id: SessionId) {
      await rm(join(root, id), { recursive: true, force: true });
    },

    /** Scan the state dir and rebuild conversation metadata so the list survives
     *  a restart. Reads meta.json (+ activity.json for a fresher lastActivityAt);
     *  a dir with an event log but no meta still appears (best-effort defaults).
     */
    async listConversations(): Promise<ConversationMeta[]> {
      let ids: string[];
      try {
        const ents = await readdir(root, { withFileTypes: true });
        ids = ents.filter((e) => e.isDirectory()).map((e) => e.name);
      } catch (e) {
        // Finding #12: ENOENT = the state dir doesn't exist yet (nothing persisted
        // -> []). Any OTHER readdir error (EACCES/EIO/unmounted state PVC) must
        // propagate — silently returning [] makes the ENTIRE conversation list
        // vanish after a restart, indistinguishable from "no conversations".
        if (isENOENT(e)) return [];
        throw e;
      }
      const out: ConversationMeta[] = [];
      for (const id of ids) {
        let meta: Partial<ConversationMeta> = {};
        try {
          meta = JSON.parse(await readFile(metaPath(id), "utf8")) as ConversationMeta;
        } catch {
          // No meta.json — skip dirs that aren't real conversations (e.g. no
          // event log either). Only surface ones that have a log.
          try {
            await readFile(logPath(id), "utf8");
          } catch {
            continue;
          }
        }
        let lastActivityAt = meta.lastActivityAt ?? meta.createdAt ?? 0;
        try {
          const act = JSON.parse(await readFile(join(root, id, "activity.json"), "utf8"));
          if (typeof act.lastActivityAt === "number") lastActivityAt = act.lastActivityAt;
        } catch {
          /* no activity marker */
        }
        out.push({
          id,
          threadId: meta.threadId ?? id,
          title: meta.title ?? "New chat",
          createdAt: meta.createdAt ?? lastActivityAt,
          lastActivityAt,
          model: meta.model,
          owner: meta.owner,
        });
      }
      return out;
    },

    gooseStatePath(id) {
      return join(root, id, "goose");
    },
  };
}
