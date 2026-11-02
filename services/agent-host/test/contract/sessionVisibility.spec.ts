/**
 * SessionManager visibility: start private, inherit into a subagent, and setVisibility over the
 * whole tree with the durable write first.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionManager, type ConversationStore, type SandboxProvisioner } from "../../src/session/manager.js";
import { createFileConversationStore } from "../../src/session/fileStore.js";
import type { AguiEvent } from "../../src/bridge.js";
import type { SessionId } from "../../src/types.js";

const provisioner = (): SandboxProvisioner => ({
  create: vi.fn(async (id) => ({ name: `conv-${id}`, namespace: "ns" })),
  suspend: vi.fn(async () => {}),
  resume: vi.fn(async (ref) => ref),
  destroy: vi.fn(async () => {}),
});

const store = (over: Partial<ConversationStore> = {}): ConversationStore => {
  const logs = new Map<SessionId, AguiEvent[]>();
  return {
    appendEvent: async (id, e) => {
      (logs.get(id) ?? logs.set(id, []).get(id)!).push(e);
    },
    async *readEvents(id) {
      yield* logs.get(id) ?? [];
    },
    gooseStatePath: (id) => `/state/${id}/goose`,
    setVisibility: vi.fn(async () => {}),
    ...over,
  };
};

describe("SessionManager visibility", () => {
  it("starts shared by default and writes nothing extra", async () => {
    const s = store();
    const sessions = createSessionManager({ provisioner: provisioner(), store: s });
    const c = await sessions.start("t1", undefined, "alice");
    expect(c.visibility ?? "shared").toBe("shared");
    expect(s.setVisibility).not.toHaveBeenCalled();
  });

  it("starts private through the one visibility writer", async () => {
    const s = store();
    const sessions = createSessionManager({ provisioner: provisioner(), store: s });
    const c = await sessions.start("t1", undefined, "alice", { visibility: "private" });
    expect(c.visibility).toBe("private");
    expect(s.setVisibility).toHaveBeenCalledWith("t1", "private");
  });

  it("refuses to start a private conversation with no owner", async () => {
    const sessions = createSessionManager({ provisioner: provisioner(), store: store() });
    await expect(sessions.start("t1", undefined, undefined, { visibility: "private" })).rejects.toThrow(/owner/);
  });

  it("makes a subagent of a private parent private", async () => {
    const sessions = createSessionManager({ provisioner: provisioner(), store: store() });
    const parent = await sessions.start("p", undefined, "alice", { visibility: "private" });
    const child = await sessions.spawnChild(parent.id, "kid", { prompt: "x" });
    expect(child.visibility).toBe("private");
  });

  it("sets the whole tree, root first in the store", async () => {
    const s = store();
    const sessions = createSessionManager({ provisioner: provisioner(), store: s });
    const root = await sessions.start("root", undefined, "alice");
    const kid = await sessions.spawnChild(root.id, "kid", { prompt: "x" });
    const grandkid = await sessions.spawnChild(kid.id, "grandkid", { prompt: "x" });
    const other = await sessions.start("other", undefined, "alice");

    await sessions.setVisibility(root.id, "private");

    expect(s.setVisibility).toHaveBeenCalledWith(root.id, "private");
    for (const id of [root.id, kid.id, grandkid.id]) expect(sessions.get(id)?.visibility).toBe("private");
    expect(sessions.get(other.id)?.visibility ?? "shared").toBe("shared");
  });

  it("refreshRouterMeta picks up a visibility another replica stored", async () => {
    let stored: "shared" | "private" = "shared";
    const s = store({
      readRouterMeta: async () => ({ owner: "alice", visibility: stored }),
    });
    const sessions = createSessionManager({ provisioner: provisioner(), store: s });
    const c = await sessions.start("t1", undefined, "alice");

    stored = "private";
    await sessions.refreshRouterMeta(c.id);
    expect(sessions.get(c.id)?.visibility).toBe("private");
    // A subagent spawned after the refresh inherits the stored value.
    const kid = await sessions.spawnChild(c.id, "kid", { prompt: "x" });
    expect(kid.visibility).toBe("private");

    stored = "shared";
    await sessions.refreshRouterMeta(c.id);
    expect(sessions.get(c.id)?.visibility).toBe("shared");
  });

  it("refuses a subagent and an unowned conversation", async () => {
    const sessions = createSessionManager({ provisioner: provisioner(), store: store() });
    const root = await sessions.start("root", undefined, "alice");
    const kid = await sessions.spawnChild(root.id, "kid", { prompt: "x" });
    await expect(sessions.setVisibility(kid.id, "private")).rejects.toThrow(/parent/);
    const unowned = await sessions.start("unowned");
    await expect(sessions.setVisibility(unowned.id, "private")).rejects.toThrow(/owner/);
  });

  it("leaves memory unchanged when the durable write fails", async () => {
    const s = store({
      setVisibility: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    const sessions = createSessionManager({ provisioner: provisioner(), store: s });
    const root = await sessions.start("root", undefined, "alice");
    await expect(sessions.setVisibility(root.id, "private")).rejects.toThrow("db down");
    expect(sessions.get(root.id)?.visibility ?? "shared").toBe("shared");
  });

  it("survives a restart through the file store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vis-"));
    try {
      const first = createSessionManager({ provisioner: provisioner(), store: createFileConversationStore(dir) });
      const root = await first.start("root", undefined, "alice");
      await first.setVisibility(root.id, "private");
      // saveMeta is fire-and-forget in setVisibility; let the write land.
      await new Promise((r) => setTimeout(r, 50));

      const second = createSessionManager({ provisioner: provisioner(), store: createFileConversationStore(dir) });
      await second.hydrate();
      expect(second.get(root.id)?.visibility).toBe("private");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
