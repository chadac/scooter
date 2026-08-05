/**
 * Tier 1 contract — store.flush() closes the fire-and-forget append→read race.
 *
 * appendEvent is fired-and-forget (`void store.appendEvent(...)`) so a burst of
 * events doesn't block emission. A reader that runs right after an event is EMITTED
 * (e.g. the subagent-completion watcher, which fires from the bridge's RUN_FINISHED
 * onEvent) can therefore read a log that doesn't yet include that event — and
 * lastRunCompleted() then sees no finish and DROPS the completion (the goose
 * subagent "finished but no result" bug). flush(id) awaits the enqueued appends so
 * a subsequent read is guaranteed to see them.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileConversationStore } from "../../src/session/fileStore.js";
import type { AguiEvent } from "../../src/bridge.js";
import type { SessionId } from "../../src/types.js";

const collect = async (it: AsyncIterable<AguiEvent>): Promise<AguiEvent[]> => {
  const out: AguiEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};

const runFinished: AguiEvent = { type: "RUN_FINISHED", threadId: "t", runId: "r" };

describe("store.flush() — fire-and-forget append/read race", () => {
  it("without flush, a read immediately after a fire-and-forget append can MISS it", async () => {
    const root = mkdtempSync(join(tmpdir(), "flush-"));
    try {
      const store = createFileConversationStore(root);
      // Fire-and-forget the RUN_STARTED then RUN_FINISHED (as wireEventLog does).
      void store.appendEvent("sub-1" as SessionId, { type: "RUN_STARTED", threadId: "t", runId: "r" });
      void store.appendEvent("sub-1" as SessionId, runFinished);
      // Read WITHOUT flushing — the async file writes haven't landed yet, so the
      // log is empty/partial. (This is exactly what reportCompletion used to do.)
      const eager = await collect(store.readEvents("sub-1" as SessionId));
      expect(eager.some((e) => e.type === "RUN_FINISHED")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("after flush(id), the read sees ALL enqueued appends (RUN_FINISHED present)", async () => {
    const root = mkdtempSync(join(tmpdir(), "flush-"));
    try {
      const store = createFileConversationStore(root);
      void store.appendEvent("sub-1" as SessionId, { type: "RUN_STARTED", threadId: "t", runId: "r" });
      void store.appendEvent("sub-1" as SessionId, runFinished);
      await store.flush!("sub-1" as SessionId);
      const flushed = await collect(store.readEvents("sub-1" as SessionId));
      expect(flushed.some((e) => e.type === "RUN_FINISHED")).toBe(true);
      expect(flushed).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flush on a conversation with no pending writes resolves (no-op)", async () => {
    const root = mkdtempSync(join(tmpdir(), "flush-"));
    try {
      const store = createFileConversationStore(root);
      await expect(store.flush!("never-written" as SessionId)).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
