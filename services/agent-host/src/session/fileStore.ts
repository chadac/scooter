/**
 * File-backed ConversationStore — appends AG-UI events as JSONL on the
 * conversation-state PVC (mounted by the agent-host), one file per conversation.
 *
 * Revival replays the JSONL. Goose's own session state lives alongside under
 * gooseStatePath(id). A richer store (indexing, compaction) can come later.
 */

import { appendFile, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { AguiEvent } from "../bridge.js";
import type { ConversationStore, ConversationMeta, ChecksummedEvent } from "./manager.js";
import type { SessionId } from "../types.js";
import { EMPTY_CHECKSUM, chainNext } from "../agui/integrity.js";

export function createFileConversationStore(root: string): ConversationStore {
  const logPath = (id: SessionId) => join(root, id, "events.jsonl");
  const metaPath = (id: SessionId) => join(root, id, "meta.json");
  const ensureDir = (id: SessionId) => mkdir(join(root, id), { recursive: true });

  // Per-conversation write chain: appendEvent is fired-and-forgotten (void) for
  // a burst of events (e.g. a user prompt's START/CONTENT/END), so concurrent
  // awaits on appendFile would land in non-deterministic order and SCRAMBLE the
  // log (END before START) — which breaks history replay on switch/revive.
  // Serialize all appends per conversation so on-disk order == emission order.
  const writeChains = new Map<SessionId, Promise<void>>();

  return {
    appendEvent(id, event) {
      const prev = writeChains.get(id) ?? Promise.resolve();
      const next = prev
        .catch(() => {}) // a prior failure must not break the chain
        .then(async () => {
          await ensureDir(id);
          await appendFile(logPath(id), JSON.stringify(event) + "\n", "utf8");
        });
      writeChains.set(id, next);
      return next;
    },

    async *readEvents(id): AsyncIterable<AguiEvent> {
      let data: string;
      try {
        data = await readFile(logPath(id), "utf8");
      } catch {
        return;
      }
      for (const line of data.split("\n")) {
        if (line.trim()) yield JSON.parse(line) as AguiEvent;
      }
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
      await writeFile(join(root, id, "activity.json"), JSON.stringify({ lastActivityAt: at }), "utf8");
    },

    async saveMeta(meta: ConversationMeta) {
      await ensureDir(meta.id);
      await writeFile(metaPath(meta.id), JSON.stringify(meta), "utf8");
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
      } catch {
        return [];
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
        });
      }
      return out;
    },

    gooseStatePath(id) {
      return join(root, id, "goose");
    },
  };
}
