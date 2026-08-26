/**
 * Tier 1 — a user Stop that races the owner pod's death must STAY stopped.
 *
 * The cluster shape (e2e-full run 33015148191): Stop clicked, the scale-down kills
 * the owner before RUN_FINISHED lands, the next owner sees a dangling run. Before
 * the persisted CANCEL_REQUESTED marker, its only move was a resume nudge — which
 * resurrects work the user killed and leaves the browser's run bar up through the
 * whole resurrection. Now revive TERMINATES a cancelled dangling run by appending
 * the RUN_FINISHED{cancelled} the dead pod owed, which the reconnected stream
 * replays to the UI.
 */

import { describe, it, expect, vi } from "vitest";

import { createSessionManager } from "../../src/session/manager.js";
import type { ConversationStore, SessionId } from "../../src/session/manager.js";
import type { AguiEvent } from "../../src/bridge.js";

const fakeProvisioner = () =>
  ({
    create: vi.fn(async (short: string) => ({ name: `conv-${short}`, namespace: "ns" })),
    ensure: vi.fn(async (short: string) => ({ name: `conv-${short}`, namespace: "ns" })),
    resume: vi.fn(async () => {}),
    suspend: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
  }) as never;

const seededStore = (id: string, events: AguiEvent[]) => {
  const logs = new Map<string, AguiEvent[]>([[id, [...events]]]);
  return {
    store: {
      appendEvent: async (cid: string, e: AguiEvent) => {
        (logs.get(cid) ?? logs.set(cid, []).get(cid)!).push(e);
      },
      async *readEvents(cid: string) {
        yield* logs.get(cid) ?? [];
      },
      gooseStatePath: (cid: string) => `/state/${cid}/goose`,
    } as never as ConversationStore,
    dump: () => logs.get(id) ?? [],
  };
};

const DEAD_HOST_RUN: AguiEvent[] = [
  { type: "RUN_STARTED", threadId: "t1", runId: "r1", host: "dead-pod", gen: 1 },
  { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "run: sleep 20" },
] as never;

const CANCEL: AguiEvent = { type: "CANCEL_REQUESTED", threadId: "t1", runId: "r1" } as never;

describe("a cancelled dangling run is TERMINATED on reassignment, not resumed", () => {
  it("revive appends the RUN_FINISHED{cancelled} the dead pod owed @proves", async () => {
    const { store, dump } = seededStore("t1", [...DEAD_HOST_RUN, CANCEL]);
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(),
      store,
      selfPod: "new-pod",
      hydrateFromMirror: async () => true,
    } as never);
    const conv = await sessions.start("t1" as never);

    await sessions.reviveFromMirror(conv.id as SessionId, 2);

    const tail = dump().at(-1) as { type: string; cancelled?: boolean; runId?: string };
    expect(tail).toMatchObject({ type: "RUN_FINISHED", runId: "r1", cancelled: true });
  });

  it("an UNcancelled dangling run gets no synthetic terminal (the resume path owns it)", async () => {
    const { store, dump } = seededStore("t1", [...DEAD_HOST_RUN]);
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(),
      store,
      selfPod: "new-pod",
      hydrateFromMirror: async () => true,
    } as never);
    const conv = await sessions.start("t1" as never);
    const before = dump().filter((e) => (e as { type: string }).type === "RUN_FINISHED").length;

    await sessions.reviveFromMirror(conv.id as SessionId, 2);

    const after = dump().filter((e) => (e as { type: string }).type === "RUN_FINISHED").length;
    expect(after, "no synthetic terminal for a run that should RESUME").toBe(before);
  });
});
