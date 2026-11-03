/**
 * conversation_status reports who a conversation acts for; make_conversation_private may
 * narrow it to its owner, never widen it. The owner-only PATCH /visibility stays the sole
 * way back to shared.
 */

import { describe, it, expect } from "vitest";

import { createSessionManager, type SandboxProvisioner, type ConversationStore } from "../../src/session/manager.js";
import {
  formatDuration,
  handleConversationStatus,
  handleMakeConversationPrivate,
  type ConversationToolsWiring,
} from "../../src/agent/conversationTools.js";
import type { AguiEvent, SessionBridge } from "../../src/bridge.js";
import type { SessionId } from "../../src/types.js";

const fakeProvisioner = (): SandboxProvisioner => ({
  create: async (id) => ({ name: `conv-${id}`, namespace: "ns" }),
  suspend: async () => {},
  resume: async (ref) => ref,
  destroy: async () => {},
});

const inMemoryStore = (): ConversationStore => {
  const logs = new Map<SessionId, AguiEvent[]>();
  return {
    appendEvent: async (id, e) => {
      (logs.get(id) ?? logs.set(id, []).get(id)!).push(e);
    },
    async *readEvents(id) {
      yield* logs.get(id) ?? [];
    },
    gooseStatePath: (id) => `/state/${id}/goose`,
  };
};

const idleBridge = () =>
  ({
    onEvent: () => () => {},
    onPersist: () => () => {},
    prompt: async () => {},
    cancel: () => {},
    stop: async () => {},
    start: async () => {},
    queueState: () => ({ running: false, currentRunMs: 0, queued: 0, maxQueuedPriority: 0 }),
    answerPermission: () => {},
  }) as unknown as SessionBridge;

/** A session manager plus the wiring index.ts builds, with memory standing in for the store. */
function setup() {
  const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore(), bridgeFactory: idleBridge });
  const wiring: ConversationToolsWiring = {
    get: (id) => sessions.get(id as SessionId),
    currentVisibility: async (id) => sessions.get(id as SessionId)?.visibility ?? "shared",
    makePrivate: (id) => sessions.setVisibility(id as SessionId, "private"),
    resources: async () => ({ limits: { cpu: "2", memory: "4Gi" } }),
  };
  return { sessions, wiring };
}

const textOf = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join("");

describe("make_conversation_private", () => {
  it("makes an owned shared conversation private", async () => {
    const { sessions, wiring } = setup();
    await sessions.start("t", undefined, "alice");
    const r = await handleMakeConversationPrivate(wiring, "t");
    expect(r.isError).toBeFalsy();
    expect(sessions.get("t" as SessionId)?.visibility).toBe("private");
  });

  it("reports an already-private conversation without erroring", async () => {
    const { sessions, wiring } = setup();
    await sessions.start("t", undefined, "alice", { visibility: "private" });
    const r = await handleMakeConversationPrivate(wiring, "t");
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/already private/);
  });

  it("refuses a conversation with no owner", async () => {
    const { sessions, wiring } = setup();
    await sessions.start("t");
    const r = await handleMakeConversationPrivate(wiring, "t");
    expect(r.isError).toBe(true);
    expect(sessions.get("t" as SessionId)?.visibility ?? "shared").toBe("shared");
  });

  it("from a subagent, makes the root and the subagent private", async () => {
    const { sessions, wiring } = setup();
    const root = await sessions.start("root", undefined, "alice");
    const child = await sessions.spawnChild(root.id, "child", { prompt: "x" });
    const r = await handleMakeConversationPrivate(wiring, child.id);
    expect(r.isError).toBeFalsy();
    expect(sessions.get(root.id)?.visibility).toBe("private");
    expect(sessions.get(child.id)?.visibility).toBe("private");
  });

  it("refuses an unknown conversation", async () => {
    const { wiring } = setup();
    const r = await handleMakeConversationPrivate(wiring, "nope");
    expect(r.isError).toBe(true);
  });
});

describe("conversation_status", () => {
  it("reports a shared conversation and its sandbox", async () => {
    const { sessions, wiring } = setup();
    await sessions.start("t", undefined, "alice");
    const out = textOf(await handleConversationStatus(wiring, "t"));
    expect(out).toMatch(/owner: alice/);
    expect(out).toMatch(/visibility: shared/);
    expect(out).toMatch(/limits cpu=2, memory=4Gi/);
  });

  it("reflects make_conversation_private, and a subagent reports its root's", async () => {
    const { sessions, wiring } = setup();
    const root = await sessions.start("root", undefined, "alice");
    const child = await sessions.spawnChild(root.id, "child", { prompt: "x" });
    await handleMakeConversationPrivate(wiring, root.id);
    const out = textOf(await handleConversationStatus(wiring, child.id));
    expect(out).toMatch(/subagent of: root/);
    expect(out).toMatch(/visibility: private/);
  });

  it("errors on an unknown conversation", async () => {
    const { wiring } = setup();
    expect((await handleConversationStatus(wiring, "nope")).isError).toBe(true);
  });

  it("formats durations as their two largest units", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(2 * 3600_000 + 5_000)).toBe("2h 0m");
    expect(formatDuration(3 * 86400_000 + 4 * 3600_000)).toBe("3d 4h");
  });
});
