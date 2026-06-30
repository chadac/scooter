/**
 * Tier 1 contract test — a FAILED durable append must leave a trace.
 *
 * Audit finding #4 (HIGH): the conversation's only persistence is this JSONL log.
 * appendEvent is fired-and-forgotten (`void store.appendEvent(...)`) and its
 * per-conversation write chain swallows a prior link's rejection (correct, to
 * keep ordering). But THIS append's own appendFile failure (ENOSPC/EACCES/
 * unmounted PVC) was never observed — a turn vanished with no log/metric/signal.
 *
 * Fix: an onAppendError observer fires on a failed append. This test asserts the
 * failure is surfaced (not silent). RED until onAppendError exists + fires.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileConversationStore } from "../../src/session/fileStore.js";
import type { SessionId } from "../../src/types.js";
import type { AguiEvent } from "../../src/bridge.js";

const event: AguiEvent = { type: "RUN_STARTED", threadId: "t", runId: "r" };

describe("fileStore persistence-error surface", () => {
  it("onAppendError fires when a durable append fails (not silently dropped)", async () => {
    const root = mkdtempSync(join(tmpdir(), "store-perr-"));
    try {
      const id = "conv-x" as SessionId;
      // Make the conversation's directory path collide with a FILE, so ensureDir's
      // mkdir (and the subsequent appendFile) fails — a stand-in for an unwritable
      // / unmounted conversation-state volume.
      writeFileSync(join(root, "conv-x"), "i am a file, not a dir", "utf8");

      const store = createFileConversationStore(root);
      const errors: Array<{ id: SessionId; error: unknown }> = [];
      store.onAppendError?.((eid, error) => errors.push({ id: eid, error }));

      // Fire-and-forget, exactly like the manager does.
      const p = store.appendEvent(id, event);
      await p.catch(() => {}); // the returned promise still rejects; await it settling

      expect(errors.length).toBe(1);
      expect(errors[0].id).toBe(id);
      expect(errors[0].error).toBeInstanceOf(Error);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the returned promise still rejects so awaiting callers see the failure too", async () => {
    const root = mkdtempSync(join(tmpdir(), "store-perr2-"));
    try {
      writeFileSync(join(root, "conv-y"), "file", "utf8");
      const store = createFileConversationStore(root);
      await expect(store.appendEvent("conv-y" as SessionId, event)).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
