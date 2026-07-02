/**
 * Tier 1 contract test — the file store's integrity surface.
 *
 * onAppend must fire each event with its rolling checksum, in persisted order,
 * and those checksums must match what readEventsWithChecksum yields (so the live
 * stream and history agree). The chain must also survive a "restart" (a fresh
 * store over the same dir continues the same checksum).
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileConversationStore } from "../../src/session/fileStore.js";
import type { ChecksummedEvent } from "../../src/session/manager.js";
import type { AguiEvent } from "../../src/bridge.js";

const events: AguiEvent[] = [
  { type: "RUN_STARTED", threadId: "t", runId: "r" },
  { type: "TEXT_MESSAGE_START", messageId: "m1", role: "user" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "hello" },
  { type: "TEXT_MESSAGE_END", messageId: "m1" },
];

describe("fileStore integrity surface", () => {
  it("onAppend fires checksummed events that match readEventsWithChecksum", async () => {
    const root = mkdtempSync(join(tmpdir(), "store-integ-"));
    try {
      const store = createFileConversationStore(root);
      const fired: ChecksummedEvent[] = [];
      store.onAppend!((id, c) => {
        expect(id).toBe("conv-1");
        fired.push(c);
      });

      for (const e of events) await store.appendEvent("conv-1", e);

      // Live (onAppend) and replay (readEventsWithChecksum) must agree exactly.
      const replayed: ChecksummedEvent[] = [];
      for await (const c of store.readEventsWithChecksum!("conv-1")) replayed.push(c);

      expect(fired).toHaveLength(events.length);
      expect(fired.map((c) => c.checksum)).toEqual(replayed.map((c) => c.checksum));
      // Each event links to the prior checksum (a real chain).
      for (let i = 1; i < fired.length; i++) {
        expect(fired[i].prevChecksum).toBe(fired[i - 1].checksum);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the checksum chain continues across a restart (fresh store, same dir)", async () => {
    const root = mkdtempSync(join(tmpdir(), "store-integ-"));
    try {
      const store1 = createFileConversationStore(root);
      for (const e of events) await store1.appendEvent("conv-1", e);

      // "Restart": a new store over the same dir must seed from disk so the next
      // append's prevChecksum == the last checksum store1 produced.
      let last = "";
      for await (const c of store1.readEventsWithChecksum!("conv-1")) last = c.checksum;

      const store2 = createFileConversationStore(root);
      const fired: ChecksummedEvent[] = [];
      store2.onAppend!((_id, c) => fired.push(c));
      await store2.appendEvent("conv-1", { type: "TEXT_MESSAGE_START", messageId: "m2", role: "assistant" });

      expect(fired).toHaveLength(1);
      expect(fired[0].prevChecksum).toBe(last); // chain continued, not reset
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("readEventsTail returns ONLY the last N runs (fast window, parses just the tail)", async () => {
    const root = mkdtempSync(join(tmpdir(), "store-integ-"));
    try {
      const store = createFileConversationStore(root);
      const run = (n: number): AguiEvent[] => [
        { type: "RUN_STARTED", threadId: "c", runId: `r${n}` },
        { type: "TEXT_MESSAGE_START", messageId: `m${n}`, role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: `m${n}`, delta: `t${n}` },
        { type: "TEXT_MESSAGE_END", messageId: `m${n}` },
        { type: "RUN_FINISHED", threadId: "c", runId: `r${n}` },
      ];
      for (let n = 1; n <= 5; n++) for (const e of run(n)) await store.appendEvent("conv-1", e);

      const tail = await store.readEventsTail!("conv-1", 2);
      // Last 2 runs, starting at r4's RUN_STARTED; every kept run is complete.
      expect(tail[0]).toMatchObject({ type: "RUN_STARTED", runId: "r4" });
      const runs = tail.filter((e) => e.type === "RUN_STARTED").map((e) => (e as { runId: string }).runId);
      expect(runs).toEqual(["r4", "r5"]);

      // Fewer runs than requested → the whole log; a missing conversation → [].
      expect((await store.readEventsTail!("conv-1", 99)).filter((e) => e.type === "RUN_STARTED")).toHaveLength(5);
      expect(await store.readEventsTail!("nope", 3)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
