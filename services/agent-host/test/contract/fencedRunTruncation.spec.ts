/**
 * TIER-1 REPRODUCTION of the cluster's truncated-run log.
 *
 * Observed on k3d (Tier-2 browser tests): a conversation's durable log ends mid-run —
 *
 *   RUN_STARTED, TEXT_MESSAGE_*, REASONING_START, REASONING_MESSAGE_CONTENT   <- stops
 *
 * no TOOL_CALL_*, no RUN_FINISHED — while `acp prompt: returned` logged SUCCESS for the
 * same run. Zero "durable append FAILED" lines. And TWO pods had resolved providers for
 * that conversation at the same second: the controller (re)assigned the CR while the run
 * was in flight.
 *
 * The mechanism: wireEventLog's ownership fence —
 *
 *   if (!ownershipGuard.canWrite(e.id)) return;     // manager.ts — SILENT
 *
 * The fence is correct to stop a stale pod from corrupting the log. But it is a silent
 * drop: when ownership moves MID-RUN, every remaining event of the in-flight run —
 * including its terminal — vanishes without one log line. The grep for "fencing
 * refusals" during the investigation found zero BECAUSE the fence never logs, which is
 * how this survived. The UI then reads a log with no terminal event and shows
 * "Working…" forever. Same silent-success family as #347/#350/#353.
 */
import { describe, it, expect, vi } from "vitest";

import {
  createSessionManager,
  type SandboxProvisioner,
  type ConversationStore,
} from "../../src/session/manager.js";
import type { AguiEvent } from "../../src/bridge.js";
import type { SandboxRef, SessionId } from "../../src/types.js";
import { hasDanglingRun } from "../../src/session/danglingRun.js";

const fakeProvisioner = (): SandboxProvisioner => {
  const refs = new Map<string, SandboxRef>();
  return {
    create: vi.fn(async (short: string) => {
      const ref = { name: `sb-${short}`, namespace: "ns" };
      refs.set(short, ref);
      return ref;
    }),
    resume: vi.fn(async () => {}),
    suspend: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
  } as never;
};

const inMemoryStore = (): ConversationStore & { dump(id: SessionId): AguiEvent[] } => {
  const logs = new Map<SessionId, AguiEvent[]>();
  return {
    appendEvent: async (id, e) => {
      (logs.get(id) ?? logs.set(id, []).get(id)!).push(e);
    },
    async *readEvents(id) {
      yield* logs.get(id) ?? [];
    },
    gooseStatePath: (id) => `/state/${id}/goose`,
    dump: (id) => logs.get(id) ?? [],
  } as never;
};

/** The run the cluster produced, replayed through the persist channel. `flipAt` is the
 *  index after which ownership moves away — where the CR reassignment landed. */
const RUN: AguiEvent[] = [
  { type: "RUN_STARTED", threadId: "t1", runId: "r1", host: "pod-A" },
  { type: "TEXT_MESSAGE_START", messageId: "m1", role: "user" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "!echo first-marker" },
  { type: "TEXT_MESSAGE_END", messageId: "m1" },
  { type: "REASONING_START", messageId: "re1" },
  { type: "REASONING_MESSAGE_START", messageId: "re1" },
  { type: "REASONING_MESSAGE_CONTENT", messageId: "re1", delta: "Planning…" },
  // ---- the cluster log ends HERE ----
  { type: "REASONING_MESSAGE_END", messageId: "re1" },
  { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "run: echo" },
  { type: "TOOL_CALL_END", toolCallId: "c1" },
  { type: "RUN_FINISHED", threadId: "t1", runId: "r1" },
] as never;

function harness(flipAt: number) {
  let owned = true;
  let persist: ((e: AguiEvent) => void) | undefined;
  const bridgeFactory = () =>
    ({
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      onEvent: () => () => {},
      onTitle: () => () => {},
      onPersist: (cb: (e: AguiEvent) => void) => {
        persist = cb;
        return () => {};
      },
      prompt: vi.fn(async () => {
        RUN.forEach((e, i) => {
          if (i === flipAt) owned = false; // the CR reassignment lands mid-run
          persist?.(e);
        });
        return "r1";
      }),
    }) as never;
  const store = inMemoryStore();
  const sessions = createSessionManager({
    provisioner: fakeProvisioner(),
    store,
    bridgeFactory,
    ownershipGuard: { canWrite: () => owned },
  });
  return { sessions, store };
}

const TERMINALS = ["RUN_FINISHED", "RUN_ERROR"];

describe("ownership moving MID-RUN", () => {
  it("the fence drop is LOUD — a truncated run must leave a trace", async () => {
    // THE ACTUAL DEFECT. The drop itself is by design (a stale pod must not corrupt the
    // log the new owner drives) — but it was silent, so the investigation's grep for
    // fencing refusals found zero and concluded the fence never fired. It had, every
    // time. warn() routes to console.error (log.ts:159).
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { sessions } = harness(7);
      const conv = await sessions.start("t1" as never);
      await sessions.prompt(conv.id as SessionId, "!echo first-marker");

      const fenceLines = errSpy.mock.calls.filter((args) =>
        args.some((a) => String(a).includes("ownership fence dropped")),
      );
      expect(fenceLines.length, "dropping a run's tail must be visible in the logs").toBeGreaterThan(0);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("the truncated log reads as DANGLING to the new owner, so resume can fire", async () => {
    // The designed recovery: the new owner sees a RUN_STARTED stamped with the OLD host,
    // treats the run as stranded (#350), and resumes it. If the truncated log ever stops
    // reading as dangling, the mid-run reassignment becomes an unrecoverable "Working…
    // forever" — which is what the cluster showed when recovery failed to fire.
    const { sessions, store } = harness(7);
    const conv = await sessions.start("t1" as never);
    await sessions.prompt(conv.id as SessionId, "!echo first-marker");

    const events = store.dump(conv.id as SessionId);
    expect(events.map((e) => e.type), "the log is truncated mid-run").not.toContain("RUN_FINISHED");
    expect(
      hasDanglingRun(events, { host: "pod-B" }),
      "the new owner must see this run as stranded",
    ).toBe(true);
  });

  it("control: with stable ownership the same run persists completely", async () => {
    const { sessions, store } = harness(RUN.length + 1); // never flips
    const conv = await sessions.start("t1" as never);
    await sessions.prompt(conv.id as SessionId, "!echo first-marker");
    const types = store.dump(conv.id as SessionId).map((e) => e.type);
    expect(types).toContain("RUN_FINISHED");
  });
});

describe("reviveFromMirror give-ups are LOUD", () => {
  it("warns when assigned a conversation the mirror does not have", async () => {
    // THE OTHER HALF of the "Working… forever" bug. On k3d the test platform had NO
    // history mirror (disabled with a stale "single-node doesn't need revival" note,
    // while CI forces podCap=1 + 3 replicas — constant reassignment). The newly
    // assigned pod pulled nothing and gave up through `if (!pulled) return;` — SILENT,
    // so the pod's total quiet read as "the revive push never arrived". It had.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const store = inMemoryStore();
      const sessions = createSessionManager({
        provisioner: fakeProvisioner(),
        store,
        hydrateFromMirror: async () => false, // the mirror has nothing (or does not exist)
      });
      await sessions.reviveFromMirror("ghost-conv" as SessionId, 1);

      const warned = errSpy.mock.calls.filter((args) =>
        args.some((a) => String(a).includes("mirror does not have")),
      );
      expect(warned.length, "an assigned-but-unrevivable conversation must leave a trace").toBeGreaterThan(0);
    } finally {
      errSpy.mockRestore();
    }
  });
});
