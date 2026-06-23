/**
 * File-backed ConversationStore — appends AG-UI events as JSONL on the
 * conversation-state PVC (mounted by the agent-host), one file per conversation.
 *
 * Revival replays the JSONL. Goose's own session state lives alongside under
 * gooseStatePath(id). A richer store (indexing, compaction) can come later.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AguiEvent } from "../bridge.js";
import type { ConversationStore } from "./manager.js";
import type { SessionId } from "../types.js";

export function createFileConversationStore(root: string): ConversationStore {
  const logPath = (id: SessionId) => join(root, id, "events.jsonl");
  const ensureDir = (id: SessionId) => mkdir(join(root, id), { recursive: true });

  return {
    async appendEvent(id, event) {
      await ensureDir(id);
      await appendFile(logPath(id), JSON.stringify(event) + "\n", "utf8");
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

    async recordActivity(id, at) {
      await ensureDir(id);
      // Last-activity marker — small, overwritten; queryable by an external
      // lifecycle manager that mounts the same PVC.
      await writeFile(join(root, id, "activity.json"), JSON.stringify({ lastActivityAt: at }), "utf8");
    },

    gooseStatePath(id) {
      return join(root, id, "goose");
    },
  };
}
