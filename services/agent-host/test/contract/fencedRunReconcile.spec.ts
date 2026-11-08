/**
 * Contract tests for runs truncated by an ownership fence. A fence can drop a
 * run's terminal event, and a later completed run then buries the orphan below a
 * RUN_FINISHED where the tail-only check cannot see it; adopting a conversation
 * must close such orphans without touching a run that is genuinely in flight.
 */

import { describe, it, expect } from "vitest";

import { danglingRunInfo, orphanRuns } from "../../src/session/danglingRun.js";
import type { AguiEvent } from "../../src/bridge.js";

const ev = (o: Record<string, unknown>) => o as unknown as AguiEvent;
const SELF = { host: "agent-host-5799784b7c-5hnz5", gen: 11 };

/** A run the fence truncated: RUN_STARTED + content, no terminal. */
const truncatedRun = (runId: string): AguiEvent[] => [
  ev({ type: "RUN_STARTED", threadId: "c", runId }),
  ev({ type: "TEXT_MESSAGE_START", messageId: `m-${runId}`, role: "assistant" }),
  ev({ type: "TEXT_MESSAGE_CONTENT", messageId: `m-${runId}`, delta: "working" }),
];

/** A run that completed normally. */
const completeRun = (runId: string): AguiEvent[] => [
  ev({ type: "RUN_STARTED", threadId: "c", runId }),
  ev({ type: "TEXT_MESSAGE_CONTENT", messageId: `m-${runId}`, delta: "done" }),
  ev({ type: "RUN_FINISHED", threadId: "c", runId }),
];

describe("a fence-truncated run, alone at the tail", () => {
  it("IS detected — the simple case works", () => {
    expect(danglingRunInfo(truncatedRun("fenced"), SELF)).toMatchObject({ runId: "fenced" });
  });
});

describe("a fence-truncated run followed by a later COMPLETED run", () => {
  // The log holds an orphan RUN_STARTED below a RUN_FINISHED.
  const log = [...truncatedRun("fenced"), ...completeRun("later")];

  it("is INVISIBLE to danglingRunInfo — it stops at the first terminal from the end", () => {
    // The scan returns null on the first terminal it meets going backwards, so the orphan below it is never reached.
    expect(danglingRunInfo(log, SELF)).toBeNull();
  });

  it("the orphan is really there — the log is NOT self-consistent", () => {
    // The UI's `running` flag is a boolean, so an unterminated RUN_STARTED reads as running forever.
    const started = log.filter((e) => e.type === "RUN_STARTED").map((e) => (e as { runId: string }).runId);
    const ended = new Set(
      log.filter((e) => e.type === "RUN_FINISHED" || e.type === "RUN_ERROR")
        .map((e) => (e as { runId?: string }).runId),
    );
    expect(started.filter((r) => !ended.has(r))).toEqual(["fenced"]);
  });

  it("stays invisible however many complete runs pile on top", () => {
    const deep = [...truncatedRun("fenced"), ...completeRun("a"), ...completeRun("b"), ...completeRun("c")];
    expect(danglingRunInfo(deep, SELF)).toBeNull();
  });
});

describe("isOwnRun is not the cause", () => {
  it("a RUN_STARTED with no origin is not skipped", () => {
    // bridge.ts stamps host/gen only when `selfPod` is configured, and an unstamped event reads as foreign.
    const noOrigin = truncatedRun("fenced");
    expect(danglingRunInfo(noOrigin, SELF)).not.toBeNull();
    // Claiming the same pod and generation only matters when the event carries that origin.
    const withOrigin = [ev({ type: "RUN_STARTED", threadId: "c", runId: "r", host: SELF.host, gen: SELF.gen })];
    expect(danglingRunInfo(withOrigin, SELF)).toBeNull();
  });
});

describe("orphanRuns — the heal-on-adopt input", () => {
  it("finds an orphan buried under a later completed run", () => {
    const log = [...truncatedRun("fenced"), ...completeRun("later")];
    expect(danglingRunInfo(log, SELF)).toBeNull();
    expect(orphanRuns(log)).toEqual([{ runId: "fenced", threadId: "c" }]);
  });

  it("finds EVERY orphan, in log order", () => {
    const log = [
      ...completeRun("a"), ...truncatedRun("run-5480af92"), ...completeRun("b"),
      ...truncatedRun("run-35ee5950"), ...completeRun("c"), ...truncatedRun("run-418ed982"),
    ];
    expect(orphanRuns(log).map((o) => o.runId)).toEqual([
      "run-5480af92", "run-35ee5950", "run-418ed982",
    ]);
  });

  it("returns nothing for a healthy log", () => {
    expect(orphanRuns([...completeRun("a"), ...completeRun("b")])).toEqual([]);
    expect(orphanRuns([])).toEqual([]);
  });

  it("counts a RUN_ERROR as a terminal", () => {
    const log = [
      ev({ type: "RUN_STARTED", threadId: "c", runId: "r" }),
      ev({ type: "RUN_ERROR", message: "boom", runId: "r" }),
    ];
    expect(orphanRuns(log)).toEqual([]);
  });

  it("does NOT report a run THIS pod is still executing", () => {
    // The controller may assign the conversation while this pod's first run is still in flight; that run is ours and live, not an orphan.
    const live = [ev({ type: "RUN_STARTED", threadId: "c", runId: "live", host: SELF.host })];
    expect(orphanRuns(live), "no self -> unknown origin, still an orphan").toEqual([
      { runId: "live", threadId: "c" },
    ]);
    expect(orphanRuns(live, SELF)).toEqual([]);
  });

  it("still reports an open run a DIFFERENT pod started", () => {
    // A rollout replaces the pod, so the orphan's host is the dead one and the adopting pod closes it.
    const foreign = [ev({ type: "RUN_STARTED", threadId: "c", runId: "dead", host: "old-pod" })];
    expect(orphanRuns(foreign, SELF)).toEqual([{ runId: "dead", threadId: "c" }]);
  });

  it("still reports our own run from an EARLIER generation", () => {
    // The conversation was assigned away and back, so the run was stranded even though the host matches.
    const stale = [
      ev({ type: "RUN_STARTED", threadId: "c", runId: "stale", host: SELF.host, gen: SELF.gen - 1 }),
    ];
    expect(orphanRuns(stale, SELF)).toEqual([{ runId: "stale", threadId: "c" }]);
  });

  it("does not invent runs from events that merely carry a runId", () => {
    // Tool/queue events carry runId too; only RUN_STARTED opens a run.
    const log = [ev({ type: "TOOL_CALL_START", toolCallId: "t", runId: "never-started" })];
    expect(orphanRuns(log)).toEqual([]);
  });

  it("healing the log makes it readable — the UI's running flag settles", () => {
    // Mirrors integrityAgent.trackRunning, which flips on any terminal regardless of runId.
    const log = [
      ...completeRun("a"), ...truncatedRun("orphan-1"),
      ...completeRun("b"), ...truncatedRun("orphan-2"),
    ];
    const healed = [
      ...log,
      ...orphanRuns(log).map((o) =>
        ev({ type: "RUN_FINISHED", threadId: o.threadId, runId: o.runId, interrupted: true }),
      ),
    ];
    let running = false;
    for (const e of healed) {
      if (e.type === "RUN_STARTED") running = true;
      else if (e.type === "RUN_FINISHED" || e.type === "RUN_ERROR") running = false;
    }
    expect(running, "the UI would still show 'working'").toBe(false);
    expect(orphanRuns(healed)).toEqual([]);
  });

  it("is idempotent — a second adopt finds nothing left to close", () => {
    // Healing must not append a duplicate terminal on every reassignment.
    const log = [...truncatedRun("fenced"), ...completeRun("later")];
    const once = [
      ...log,
      ...orphanRuns(log).map((o) =>
        ev({ type: "RUN_FINISHED", threadId: o.threadId, runId: o.runId, interrupted: true }),
      ),
    ];
    expect(orphanRuns(once)).toEqual([]);
  });
});

// --- Through the real SessionManager: adopting a conversation with buried orphans leaves the log self-consistent ---

import { vi } from "vitest";
import { createSessionManager } from "../../src/session/manager.js";
import type { ConversationStore, SessionId } from "../../src/session/manager.js";

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

const openRuns = (log: AguiEvent[]) => {
  const ended = new Set(
    log.filter((e) => e.type === "RUN_FINISHED" || e.type === "RUN_ERROR")
      .map((e) => (e as { runId?: string }).runId),
  );
  return log.filter((e) => e.type === "RUN_STARTED")
    .map((e) => (e as { runId: string }).runId)
    .filter((r) => !ended.has(r));
};

describe("adopting a conversation heals a fenced hand-off", () => {
  it("closes an orphan buried under a later completed run @proves", async () => {
    const { store, dump } = seededStore("t1", [
      ...truncatedRun("fenced"),
      ...completeRun("later"),
    ] as never);
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(), store, selfPod: "new-pod",
    } as never);
    const conv = await sessions.start("t1" as never);

    expect(openRuns(dump()), "precondition: the log has an orphan").toEqual(["fenced"]);
    await sessions.reviveFromMirror(conv.id as SessionId, 2);

    expect(openRuns(dump()), "the adopting pod should have closed it").toEqual([]);
    const closed = dump().find(
      (e) => e.type === "RUN_FINISHED" && (e as { runId?: string }).runId === "fenced",
    ) as { interrupted?: boolean } | undefined;
    expect(closed?.interrupted, "marked interrupted, not a real completion").toBe(true);
  });

  it("does NOT close the run that is genuinely dangling at the tail", async () => {
    // The tail run belongs to the resume path, which re-drives the work.
    const { store, dump } = seededStore("t1", [
      ...completeRun("earlier"),
      ...truncatedRun("still-running"),
    ] as never);
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(), store, selfPod: "new-pod",
    } as never);
    const conv = await sessions.start("t1" as never);

    await sessions.reviveFromMirror(conv.id as SessionId, 2);

    const terminals = dump().filter(
      (e) => e.type === "RUN_FINISHED" && (e as { runId?: string }).runId === "still-running",
    );
    expect(terminals, "the resume path owns the tail run").toEqual([]);
  });

  it("is idempotent across repeated reassignments", async () => {
    const { store, dump } = seededStore("t1", [
      ...truncatedRun("fenced"), ...completeRun("later"),
    ] as never);
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(), store, selfPod: "new-pod",
    } as never);
    const conv = await sessions.start("t1" as never);

    await sessions.reviveFromMirror(conv.id as SessionId, 2);
    const afterFirst = dump().filter((e) => e.type === "RUN_FINISHED").length;
    await sessions.reviveFromMirror(conv.id as SessionId, 3);

    expect(dump().filter((e) => e.type === "RUN_FINISHED").length).toBe(afterFirst);
  });

  it("does NOT close the pod's OWN run that is still in flight @proves", async () => {
    // The first assignment can land while this pod's own run is still in flight.
    const { store, dump } = seededStore("t1", [
      // No `gen`: the run started before the conversation was ever assigned.
      ev({ type: "RUN_STARTED", threadId: "c", runId: "live", host: "new-pod" }),
      ev({ type: "TEXT_MESSAGE_START", messageId: "m", role: "assistant" }),
    ] as never);
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(), store, selfPod: "new-pod",
    } as never);
    const conv = await sessions.start("t1" as never);

    await sessions.reviveFromMirror(conv.id as SessionId, 1);

    expect(
      dump().filter((e) => e.type === "RUN_FINISHED"),
      "our own live run must survive its own assignment",
    ).toEqual([]);
    expect(openRuns(dump())).toEqual(["live"]);
  });

  it("leaves a healthy log untouched", async () => {
    const { store, dump } = seededStore("t1", [...completeRun("a"), ...completeRun("b")] as never);
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(), store, selfPod: "new-pod",
    } as never);
    const conv = await sessions.start("t1" as never);
    const before = dump().length;

    await sessions.reviveFromMirror(conv.id as SessionId, 2);

    expect(dump().length).toBe(before);
  });
});

describe("closing older orphans at the tail does not hide the live run", () => {
  // What reconcileDanglingRun appends: interrupted terminals for older orphans, after the live run.
  const closed = (runId: string) => ev({ type: "RUN_FINISHED", threadId: "c", runId, interrupted: true });

  it("the latest open run stays dangling after its predecessors are closed @proves", () => {
    const log = [...truncatedRun("old1"), ...truncatedRun("old2"), ...truncatedRun("live"), closed("old1"), closed("old2")];
    expect(danglingRunInfo(log, SELF)).toMatchObject({ runId: "live" });
  });

  it("a terminal for the run itself still settles it", () => {
    const log = [...truncatedRun("live"), ev({ type: "RUN_FINISHED", threadId: "c", runId: "live" })];
    expect(danglingRunInfo(log, SELF)).toBeNull();
  });

  it("a RUN_ERROR without a runId still ends the latest run", () => {
    const log = [...truncatedRun("live"), ev({ type: "RUN_ERROR", message: "remote agent disconnected" })];
    expect(danglingRunInfo(log, SELF)).toBeNull();
  });

  it("the orphan sweep agrees: a runId-less RUN_ERROR is not an orphan to close @proves", () => {
    const log = [...truncatedRun("errored"), ev({ type: "RUN_ERROR", message: "remote agent disconnected" })];
    expect(orphanRuns(log, SELF)).toEqual([]);
  });

  it("a runId-less RUN_ERROR ends only the latest run, not an older orphan", () => {
    const log = [...truncatedRun("fenced"), ...truncatedRun("errored"), ev({ type: "RUN_ERROR", message: "boom" })];
    expect(orphanRuns(log, SELF)).toEqual([{ runId: "fenced", threadId: "c" }]);
  });
});
