/**
 * File-backed ConversationStore: appends AG-UI events as JSONL on the conversation-state
 * PVC, one file per conversation, with meta/links/jobs as sibling JSON files and Goose's
 * own session state under gooseStatePath(id).
 */

import { appendFile, mkdir, readFile, writeFile, rename, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { AguiEvent } from "../bridge.js";
import { trimToBoundary } from "./eventStore.js";
import type { ConversationStore, ConversationMeta, ChecksummedEvent, ConversationLink } from "./manager.js";
import { PLACEHOLDER_TITLE } from "./manager.js";
import type { JobRecord } from "./jobManager.js";
import type { SessionId } from "../types.js";
import { logger } from "../log.js";
import { EMPTY_CHECKSUM, chainNext } from "../agui/integrity.js";
import { tailByRuns } from "./eventWindow.js";

const log = logger("fileStore");

// Atomic whole-file write via a temp sibling and rename(2), so a concurrent reader sees either the
// complete old file or the complete new one.
let atomicSeq = 0;
async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${atomicSeq++}`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}

/** True for "file/dir does not exist", the one benign read error; every other read error is a real
 *  failure that must not be flattened to empty. */
function isENOENT(e: unknown): boolean {
  return (e as { code?: string })?.code === "ENOENT";
}

export function createFileConversationStore(root: string): ConversationStore {
  const logPath = (id: SessionId) => join(root, id, "events.jsonl");
  const metaPath = (id: SessionId) => join(root, id, "meta.json");
  const linksPath = (id: SessionId) => join(root, id, "links.json");
  // The conversation's background-job registry, a small JSON index; the job's output lives in-pod.
  const jobsPath = (id: SessionId) => join(root, id, "jobs.json");
  const ensureDir = (id: SessionId) => mkdir(join(root, id), { recursive: true });

  // Per-conversation write chain, so on-disk order equals emission order despite void-called
  // appends.
  const writeChains = new Map<SessionId, Promise<void>>();

  // Per-conversation rolling integrity checksum, folded in write-chain order and seeded from disk
  // on first touch; onAppend subscribers receive each checksummed event once it is durably written.
  const checksums = new Map<SessionId, string>();
  const seeded = new Set<SessionId>();
  // Lines per log; a line's position is its seq.
  const counts = new Map<SessionId, number>();
  const appendListeners = new Set<(id: SessionId, c: ChecksummedEvent) => void>();
  // Observers notified when a durable append fails, so a lost turn leaves a trace.
  const appendErrorListeners = new Set<(id: SessionId, error: unknown) => void>();

  const seedChecksum = async (id: SessionId): Promise<string> => {
    if (seeded.has(id)) return checksums.get(id) ?? EMPTY_CHECKSUM;
    let acc = EMPTY_CHECKSUM;
    let n = 0;
    try {
      const data = await readFile(logPath(id), "utf8");
      for (const line of data.split("\n")) {
        if (!line.trim()) continue;
        acc = chainNext(acc, JSON.parse(line) as AguiEvent);
        n++;
      }
    } catch (e) {
      // ENOENT means no log yet; any parse or I/O error mis-seeds the integrity chain, so log it
      // loudly.
      if (!isENOENT(e)) {
        log.errorWith("checksum seed failed to read/parse the log (integrity may be off)", e, {
          conversation_id: id,
        });
      }
    }
    if (!seeded.has(id)) {
      checksums.set(id, acc);
      counts.set(id, n);
      seeded.add(id);
    }
    return checksums.get(id)!;
  };

  return {
    appendEvent(id, event) {
      const prev = writeChains.get(id) ?? Promise.resolve();
      const next = prev
        .catch(() => {}) // a prior failure must not break the chain (ordering)
        .then(async () => {
          try {
            await ensureDir(id);
            // prevChecksum is the chain through the prior events, seeded lazily once after a
            // restart.
            const prevChecksum = await seedChecksum(id);
            await appendFile(logPath(id), JSON.stringify(event) + "\n", "utf8");
            // Fold this event in (write order) and notify live subscribers.
            const checksum = chainNext(prevChecksum, event);
            checksums.set(id, checksum);
            const seq = (counts.get(id) ?? 0) + 1;
            counts.set(id, seq);
            for (const cb of appendListeners) cb(id, { event, prevChecksum, checksum, seq });
          } catch (error) {
            // Surface the lost turn and notify observers, then rethrow for an awaiting caller.
            log.errorWith("durable append FAILED (turn lost)", error, { conversation_id: id });
            for (const cb of appendErrorListeners) {
              try { cb(id, error); } catch { /* an observer must not break the store */ }
            }
            throw error;
          }
        });
      // The chain advances on the settled promise so a failed write cannot wedge ordering, while
      // `next` preserves the rejection for the caller.
      writeChains.set(id, next.catch(() => {}));
      return next;
    },

    // Await everything enqueued so far for `id`; the chain's tail is the settled promise of the
    // last append.
    async flush(id) {
      await (writeChains.get(id) ?? Promise.resolve());
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
        // ENOENT means no log yet; any other error would replay a real conversation as blank
        // history, so propagate it.
        if (isENOENT(e)) return;
        throw e;
      }
      for (const line of data.split("\n")) {
        if (line.trim()) yield JSON.parse(line) as AguiEvent;
      }
    },

    async readEventsTailByCount(id, limit) {
      if (limit <= 0) return [];
      let data: string;
      try {
        data = await readFile(logPath(id), "utf8");
      } catch (e) {
        if (isENOENT(e)) return [];
        throw e;
      }
      const all = data
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as AguiEvent);
      return trimToBoundary(all.slice(-limit));
    },

    async readEventsBefore(id, beforeSeq, limit) {
      // The file has no seq column: a line's 1-based position is its seq.
      if (limit <= 0 || beforeSeq <= 1) return { events: [], firstSeq: beforeSeq, done: true };
      let data: string;
      try {
        data = await readFile(logPath(id), "utf8");
      } catch (e) {
        if (isENOENT(e)) return { events: [], firstSeq: beforeSeq, done: true };
        throw e;
      }
      const all = data
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as AguiEvent);
      const end = Math.min(beforeSeq - 1, all.length); // exclusive upper bound, 1-based
      const start = Math.max(0, end - limit);
      return {
        events: all.slice(start, end),
        firstSeq: start + 1,
        done: start === 0,
      };
    },

    async readEventsTail(id, runs) {
      // Window on run boundaries via tailByRuns, which orders by `ts` first because a log that
      // survived restarts concatenates runs from separate processes.
      let data: string;
      try {
        data = await readFile(logPath(id), "utf8");
      } catch (e) {
        if (isENOENT(e)) return [];
        throw e;
      }
      if (runs <= 0) return [];
      const all = data.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as AguiEvent);
      return tailByRuns(all, runs);
    },

    async *readEventsWithChecksum(id): AsyncIterable<ChecksummedEvent> {
      let prev = EMPTY_CHECKSUM;
      let seq = 0;
      for await (const event of this.readEvents(id)) {
        const checksum = chainNext(prev, event);
        yield { event, prevChecksum: prev, checksum, seq: ++seq };
        prev = checksum;
      }
    },

    async readEventsAfter(id, afterSeq, limit) {
      let anchor: string | undefined;
      const events: ChecksummedEvent[] = [];
      let more = false;
      for await (const c of this.readEventsWithChecksum!(id)) {
        if (c.seq! === afterSeq) anchor = c.checksum;
        if (c.seq! <= afterSeq) continue;
        if (events.length === limit) {
          more = true;
          break;
        }
        events.push(c);
      }
      return { anchor, events, more };
    },

    // Atomically rewrite the whole event log on the per-id write chain and re-seed the rolling
    // checksum from the new contents.
    async replaceEvents(id, events) {
      const prev = writeChains.get(id) ?? Promise.resolve();
      const next = prev
        .catch(() => {})
        .then(async () => {
          await ensureDir(id);
          const body = events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "");
          await writeFileAtomic(logPath(id), body);
          // Mark seeded so seedChecksum trusts the re-seeded value.
          let acc = EMPTY_CHECKSUM;
          for (const e of events) acc = chainNext(acc, e);
          checksums.set(id, acc);
          counts.set(id, events.length);
          seeded.add(id);
        });
      writeChains.set(id, next.catch(() => {}));
      return next;
    },

    /** Persist the conversation record, the sole home of lastActivityAt. */
    async saveMeta(meta: ConversationMeta) {
      await ensureDir(meta.id);
      await writeFileAtomic(metaPath(meta.id), JSON.stringify(meta));
    },

    /** Append a background-job record to the conversation's registry (newest first). */
    async saveJob(id: SessionId, job: JobRecord) {
      await ensureDir(id);
      const existing = await this.listJobs!(id);
      await writeFileAtomic(jobsPath(id), JSON.stringify([job, ...existing]));
    },

    /** The conversation's background-job records, [] if none. */
    async listJobs(id: SessionId): Promise<JobRecord[]> {
      try {
        return JSON.parse(await readFile(jobsPath(id), "utf8")) as JobRecord[];
      } catch {
        return [];
      }
    },

    /** Rewrite an existing job record in place by jobId; a no-op if the job is not found. */
    async updateJob(id: SessionId, job: JobRecord) {
      const existing = await this.listJobs!(id);
      const i = existing.findIndex((j) => j.jobId === job.jobId);
      if (i < 0) return;
      existing[i] = job;
      await writeFileAtomic(jobsPath(id), JSON.stringify(existing));
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

    /** Permanently remove a conversation's persisted state so it does not come back on the next
     *  hydrate(). */
    async removeConversation(id: SessionId) {
      await rm(join(root, id), { recursive: true, force: true });
    },

    /** Scan the state dir and rebuild conversation metadata; a dir with an event log but no
     *  meta.json still appears with defaults. */
    async listConversations(): Promise<ConversationMeta[]> {
      let ids: string[];
      try {
        const ents = await readdir(root, { withFileTypes: true });
        ids = ents.filter((e) => e.isDirectory()).map((e) => e.name);
      } catch (e) {
        // ENOENT means nothing persisted yet; any other readdir error would make the entire list
        // vanish, so propagate it.
        if (isENOENT(e)) return [];
        throw e;
      }
      const out: ConversationMeta[] = [];
      for (const id of ids) {
        let meta: Partial<ConversationMeta> = {};
        try {
          meta = JSON.parse(await readFile(metaPath(id), "utf8")) as ConversationMeta;
        } catch {
          // Without meta.json, only surface dirs that have an event log.
          try {
            await readFile(logPath(id), "utf8");
          } catch {
            continue;
          }
        }
        const lastActivityAt = meta.lastActivityAt ?? meta.createdAt ?? 0;
        out.push({
          id,
          threadId: meta.threadId ?? id,
          title: meta.title ?? PLACEHOLDER_TITLE,
          createdAt: meta.createdAt ?? lastActivityAt,
          lastActivityAt,
          model: meta.model,
          modelSetBy: meta.modelSetBy,
          owner: meta.owner,
          parentId: meta.parentId,
          userTitled: meta.userTitled,
          starred: meta.starred,
          ...(meta.visibility === "private" ? { visibility: "private" as const } : {}),
          // Carried through because hydrate rebuilds the Entry from this object, so dropping it
          // would lose the queued message across a restart.
          pendingQueue: meta.pendingQueue,
          ...(meta.sandboxRef ? { sandboxRef: meta.sandboxRef } : {}),
        });
      }
      return out;
    },

    gooseStatePath(id) {
      return join(root, id, "goose");
    },
  };
}
