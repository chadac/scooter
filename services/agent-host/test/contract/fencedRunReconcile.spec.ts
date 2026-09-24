/**
 * Tier 1 — why a run truncated by an ownership fence is never reconciled.
 *
 * Live evidence (valhalla, 2026-09-02, conversation 9cb8bd61):
 *   - agent-host rolled out 10 times; the controller reassigned the conversation
 *     each time (generation 2 -> 11)
 *   - the outgoing pod's fence dropped 1,100 events INCLUDING the terminal
 *   - `reconcileDanglingRun` logged "nothing to settle" on every adopt, having
 *     read the WHOLE log (events_seen=10917) — so it is not reading a short tail
 *   - the conversation ended with 12 "acp prompt: sending" and 9 "returned"
 *
 * These tests pin the mechanism so a fix can be judged against it.
 */

import { describe, it, expect } from "vitest";

import { danglingRunInfo, orphanRuns, tailOpenRun } from "../../src/session/danglingRun.js";
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
  // This is the shape production actually produces. The fence truncates the run
  // in flight; the user (or the resume path) then prompts again on the NEW owner
  // and that run completes normally. The log now holds an orphan RUN_STARTED
  // BELOW a RUN_FINISHED.
  const log = [...truncatedRun("fenced"), ...completeRun("later")];

  it("is INVISIBLE to danglingRunInfo — it stops at the first terminal from the end", () => {
    // The scan returns null on the first RUN_FINISHED/RUN_ERROR it meets going
    // backwards, so the orphan below it is never reached. This is why every
    // production check logged "nothing to settle" despite reading 10,917 events.
    expect(danglingRunInfo(log, SELF)).toBeNull();
  });

  it("the orphan is really there — the log is NOT self-consistent", () => {
    // What the UI replays: a RUN_STARTED with no matching terminal. Its `running`
    // flag is a boolean, so this reads as "still running" forever.
    const started = log.filter((e) => e.type === "RUN_STARTED").map((e) => (e as { runId: string }).runId);
    const ended = new Set(
      log.filter((e) => e.type === "RUN_FINISHED" || e.type === "RUN_ERROR")
        .map((e) => (e as { runId?: string }).runId),
    );
    expect(started.filter((r) => !ended.has(r))).toEqual(["fenced"]);
  });

  it("stays invisible however many complete runs pile on top", () => {
    // Each subsequent turn buries it further — the conversation never self-heals.
    const deep = [...truncatedRun("fenced"), ...completeRun("a"), ...completeRun("b"), ...completeRun("c")];
    expect(danglingRunInfo(deep, SELF)).toBeNull();
  });
});

describe("isOwnRun is not the cause", () => {
  it("an un-stamped RUN_STARTED reads as foreign, so it is not skipped", () => {
    // An event from before bridge.ts stamped origin carries no host/gen, so isOwnRun
    // returns false (unknown origin -> foreign) and cannot suppress detection.
    // NOTE: bridge.ts DOES stamp host+gen today (`stamp`, bridge.ts) — see the
    // own-in-flight suite below for what that changes.
    const noOrigin = truncatedRun("fenced");
    expect(danglingRunInfo(noOrigin, SELF)).not.toBeNull();
    // Even claiming to be the same pod at the same generation only matters when the
    // event actually carries that origin:
    const withOrigin = [ev({ type: "RUN_STARTED", threadId: "c", runId: "r", host: SELF.host, gen: SELF.gen })];
    expect(danglingRunInfo(withOrigin, SELF)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The heal pass must not close the run THIS pod is driving right now.
//
// Live evidence (nightly e2e full, 2026-09-24, run 35967750871, shard 4). Three
// stop-run tests failed identically; conversation 80318d91 is representative:
//
//   07:25:22.481  acp prompt: sending      run-6f3aa19f   (RUN_STARTED, host+gen stamped)
//   07:25:22.797  waiting for a ready pod  conv-1lnmrl    (cold sandbox boot)
//   07:25:26.440  closed runs left open by a hand-off     closed:1 run-6f3aa19f
//   07:25:26.440  dangling-run check: nothing to settle   events_seen:14
//   07:25:28.851  ready-pod wait ended
//   07:25:49.500  acp prompt: returned     run-6f3aa19f   (the run was alive all along)
//
// Both log lines at the same millisecond: `danglingRunInfo` said "nothing to
// settle" BECAUSE the run was ours, which left `inFlight` undefined, which let the
// orphan pass close the very run the pod was executing. The UI took the terminal at
// +4s, cleared its run bar, and the test waited 90s for a bar that never returned.
// ---------------------------------------------------------------------------

describe("a run this pod is DRIVING, when the assignment push arrives mid-run", () => {
  // What bridge.ts writes today: RUN_STARTED stamped with this pod + generation.
  const ownInFlight = (runId: string): AguiEvent[] => [
    ev({ type: "RUN_STARTED", threadId: "c", runId, host: SELF.host, gen: SELF.gen }),
    ev({ type: "TEXT_MESSAGE_START", messageId: `m-${runId}`, role: "assistant" }),
  ];

  it("reads as NOT dangling — it is in flight, not stranded", () => {
    // The premise the orphan pass got wrong: null here means "nothing stranded",
    // NOT "no run is open".
    expect(danglingRunInfo(ownInFlight("mine"), SELF)).toBeNull();
    expect(orphanRuns(ownInFlight("mine")).map((o) => o.runId)).toEqual(["mine"]);
  });

  it("tailOpenRun still sees it — the ownership-blind exclusion", () => {
    expect(tailOpenRun(ownInFlight("mine"))).toEqual({ runId: "mine", threadId: "c" });
  });

  it("tailOpenRun agrees with danglingRunInfo on a FOREIGN stranded tail run", () => {
    // The pre-existing exclusion must be preserved, not merely replaced: for a run a
    // dead pod left at the tail, both name the same run.
    const foreign = truncatedRun("stranded");
    expect(tailOpenRun(foreign)?.runId).toBe(danglingRunInfo(foreign, SELF)?.runId);
  });

  it("returns null when the last run completed, so healing is unrestricted", () => {
    expect(tailOpenRun([...truncatedRun("buried"), ...completeRun("later")])).toBeNull();
    expect(tailOpenRun([])).toBeNull();
  });

  it("protects ONLY the tail — this pod's own EARLIER orphan is still healed", () => {
    // An own run buried under a completed one is genuinely abandoned; the heal pass
    // must still close it, or the fenced-hand-off bug comes back.
    const log = [...ownInFlight("mine-abandoned"), ...completeRun("later"), ...ownInFlight("mine-now")];
    const inFlight = tailOpenRun(log)?.runId;
    expect(inFlight).toBe("mine-now");
    expect(orphanRuns(log).filter((o) => o.runId !== inFlight).map((o) => o.runId)).toEqual([
      "mine-abandoned",
    ]);
  });
});

describe("orphanRuns — the heal-on-adopt input", () => {
  it("finds an orphan buried under a later completed run", () => {
    // The case danglingRunInfo structurally cannot see.
    const log = [...truncatedRun("fenced"), ...completeRun("later")];
    expect(danglingRunInfo(log, SELF)).toBeNull();
    expect(orphanRuns(log)).toEqual([{ runId: "fenced", threadId: "c" }]);
  });

  it("finds EVERY orphan, in log order", () => {
    // 9cb8bd61's real shape: 12 runs started, 9 returned.
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

  it("does not invent runs from events that merely carry a runId", () => {
    // Tool/queue events carry runId too; only RUN_STARTED opens a run.
    const log = [ev({ type: "TOOL_CALL_START", toolCallId: "t", runId: "never-started" })];
    expect(orphanRuns(log)).toEqual([]);
  });

  it("healing the log makes it readable — the UI's running flag settles", () => {
    // The whole point: after the adopting pod closes the orphans, replaying the
    // log leaves `running` false. Mirrors integrityAgent.trackRunning, which flips
    // on ANY terminal regardless of runId — so no UI change is needed.
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
    // Rollouts reassign repeatedly (9cb8bd61: 10x in a day). Healing must not
    // append a duplicate terminal every time.
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

// ---------------------------------------------------------------------------
// End-to-end through the real SessionManager: adopting a conversation whose log
// carries buried orphans must leave that log self-consistent.
// ---------------------------------------------------------------------------

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
    // Exactly the production shape: the fence truncated `fenced`, the next turn
    // completed on top, and the tail-only check has reported "nothing to settle"
    // on every adopt since.
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
    // The tail run belongs to the resume path (it re-drives the work). Closing it
    // here would tell the UI the turn ended while the agent carries on.
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
    // 9cb8bd61 was reassigned 10x in a day; healing must not stack duplicates.
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

describe("adopting a conversation whose own run is STILL IN FLIGHT", () => {
  // The 2026-09-24 nightly trace, through the real SessionManager: the controller's
  // assignment push lands while this pod's first run is still waiting for a cold
  // sandbox pod. Closing that run tells the UI the turn ended while the agent is
  // still working — the run bar clears and never comes back.
  const ownInFlight = (runId: string, host: string, gen: number): AguiEvent[] => [
    ev({ type: "RUN_STARTED", threadId: "c", runId, host, gen }),
    ev({ type: "TEXT_MESSAGE_START", messageId: `m-${runId}`, role: "assistant" }),
  ];

  it("leaves this pod's in-flight run open @proves", async () => {
    const { store, dump } = seededStore("t1", ownInFlight("run-6f3aa19f", "new-pod", 2) as never);
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(), store, selfPod: "new-pod",
    } as never);
    const conv = await sessions.start("t1" as never);

    await sessions.reviveFromMirror(conv.id as SessionId, 2);

    const terminals = dump().filter(
      (e) => e.type === "RUN_FINISHED" && (e as { runId?: string }).runId === "run-6f3aa19f",
    );
    expect(terminals, "the pod is still executing this run — nobody may end it").toEqual([]);
    expect(openRuns(dump())).toEqual(["run-6f3aa19f"]);
  });

  it("still heals an own orphan buried beneath that in-flight run", async () => {
    const { store, dump } = seededStore("t1", [
      ...ownInFlight("abandoned", "new-pod", 1),
      ev({ type: "RUN_STARTED", threadId: "c", runId: "done", host: "new-pod", gen: 2 }),
      ev({ type: "RUN_FINISHED", threadId: "c", runId: "done" }),
      ...ownInFlight("current", "new-pod", 2),
    ] as never);
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(), store, selfPod: "new-pod",
    } as never);
    const conv = await sessions.start("t1" as never);

    await sessions.reviveFromMirror(conv.id as SessionId, 2);

    expect(openRuns(dump()), "only the live run survives").toEqual(["current"]);
  });
});
