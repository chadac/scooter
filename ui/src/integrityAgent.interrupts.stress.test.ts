/**
 * Tier 1 (ui) — STRESS TEST for the approval-interrupt state machine (IntegrityAgent.trackInterrupt).
 *
 * The recurring "approval request doesn't appear in the panel" bug. We drive the agent through many
 * sequences of raise / RUN_STARTED / RUN_FINISHED / PERMISSION_RESOLVED and compare its
 * getPendingInterrupts() against a REFERENCE MODEL of what SHOULD be pending. Divergence = a drop.
 *
 * The intended contract (what the model encodes):
 *   - A raised interrupt is pending until it is explicitly resolved (PERMISSION_RESOLVED for its id).
 *   - Run boundaries (RUN_STARTED / a normal RUN_FINISHED) must NOT clear an UNANSWERED interrupt —
 *     approval is a human decision that outlives the agent's runs.
 *   - This must hold for goose (run-scoped) AND broker (ext-) interrupts, and any interleaving.
 *
 * If a scenario fails, its name + the diff (expected vs actual pending ids) pinpoints the sequence
 * that drops the approval.
 */

import { describe, it, expect } from "vitest";

import { createIntegrityAgent } from "./integrityAgent.js";

function sseFetch(frames: unknown[]): typeof fetch {
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
  return (async (url: string) => {
    if (typeof url === "string" && url.includes("/tail")) {
      return new Response(JSON.stringify({ events: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

/** Drive the agent's render pump until the integrity stream settles (mirrors integrityAgent.test.ts). */
async function foldTo(agent: ReturnType<typeof createIntegrityAgent>): Promise<void> {
  const stop = agent.renderPump();
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const done = () => { unsub(); stop(); resolve(); };
    const { unsubscribe: unsub } = agent.subscribe({
      onMessagesChanged: () => { clearTimeout(timer); timer = setTimeout(done, 100); },
    });
    setTimeout(done, 1000); // fallback: settle even if no message change fires
  });
}

// --- The scenario DSL --------------------------------------------------------
// A step is one thing that happens on the wire. `interruptGoose`/`interruptExt` RAISE an approval;
// `startRun`/`finishRun` are run boundaries; `resolve` settles an approval by id.
type Step =
  | { op: "interruptGoose"; runId: string; id: string } // a run-scoped (goose) permission request
  | { op: "interruptExt"; id: string } // a broker (ext-) approval
  | { op: "startRun"; runId: string }
  | { op: "finishRun"; runId: string } // a plain RUN_FINISHED (no interrupt)
  | { op: "resolve"; id: string }; // PERMISSION_RESOLVED for an approval

function framesFor(steps: Step[]): unknown[] {
  const frames: unknown[] = [];
  for (const s of steps) {
    switch (s.op) {
      case "interruptGoose":
        frames.push({ kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: s.runId,
          outcome: { type: "interrupt", interrupts: [{ id: s.id, reason: "confirmation", message: `approve ${s.id}?` }] } } });
        break;
      case "interruptExt":
        frames.push({ kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: `ext-${s.id}`,
          outcome: { type: "interrupt", interrupts: [{ id: s.id, reason: "confirmation", message: `approve ${s.id}?` }] } } });
        break;
      case "startRun":
        frames.push({ kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: s.runId } });
        break;
      case "finishRun":
        frames.push({ kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: s.runId } });
        break;
      case "resolve":
        frames.push({ kind: "event", event: { type: "PERMISSION_RESOLVED", threadId: "c1", toolCallId: s.id, optionId: "approve" } });
        break;
    }
  }
  frames.push({ kind: "synced" });
  return frames;
}

/** The REFERENCE MODEL: what SHOULD be pending after these steps. A raise adds the id; a resolve
 *  removes it; run boundaries change NOTHING. This is the contract the UI must honor for approvals
 *  to reliably appear + persist. */
function expectedPending(steps: Step[]): Set<string> {
  const pending = new Set<string>();
  for (const s of steps) {
    if (s.op === "interruptGoose" || s.op === "interruptExt") pending.add(s.id);
    else if (s.op === "resolve") pending.delete(s.id);
    // startRun / finishRun: no effect on an unanswered approval.
  }
  return pending;
}

async function pendingAfter(steps: Step[]): Promise<Set<string>> {
  const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: sseFetch(framesFor(steps)) });
  await foldTo(agent);
  const ids = new Set(agent.getPendingInterrupts().map((p) => p.id));
  agent.dispose();
  return ids;
}

// --- Named scenarios (each is a distinct real-world sequence) -----------------
const SCENARIOS: Array<{ name: string; steps: Step[] }> = [
  {
    name: "single goose interrupt, unanswered, survives to reload",
    steps: [{ op: "interruptGoose", runId: "r1", id: "g1" }],
  },
  {
    name: "single goose interrupt then a NEW run starts (must NOT clear the pending approval)",
    steps: [{ op: "interruptGoose", runId: "r1", id: "g1" }, { op: "startRun", runId: "r2" }],
  },
  {
    name: "two goose interrupts from different runs, both unanswered (both must remain)",
    steps: [
      { op: "interruptGoose", runId: "r1", id: "g1" },
      { op: "startRun", runId: "r2" },
      { op: "interruptGoose", runId: "r2", id: "g2" },
    ],
  },
  {
    name: "goose interrupt, then a plain RUN_FINISHED for another run (must NOT clear it)",
    steps: [
      { op: "interruptGoose", runId: "r1", id: "g1" },
      { op: "startRun", runId: "r2" },
      { op: "finishRun", runId: "r2" },
    ],
  },
  {
    name: "two goose interrupts, resolve the FIRST — second must remain",
    steps: [
      { op: "interruptGoose", runId: "r1", id: "g1" },
      { op: "interruptGoose", runId: "r1b", id: "g2" },
      { op: "resolve", id: "g1" },
    ],
  },
  {
    name: "two goose interrupts, resolve the SECOND (out of order) — first must remain",
    steps: [
      { op: "interruptGoose", runId: "r1", id: "g1" },
      { op: "interruptGoose", runId: "r1b", id: "g2" },
      { op: "resolve", id: "g2" },
    ],
  },
  {
    name: "mixed: goose + ext interrupt pending together",
    steps: [
      { op: "interruptGoose", runId: "r1", id: "g1" },
      { op: "interruptExt", id: "aws1" },
    ],
  },
  {
    name: "mixed: ext interrupt survives a goose run's start+finish (the #276-adjacent case)",
    steps: [
      { op: "interruptExt", id: "aws1" },
      { op: "startRun", runId: "g9" },
      { op: "finishRun", runId: "g9" },
    ],
  },
  {
    name: "mixed: goose interrupt survives while an ext interrupt is resolved",
    steps: [
      { op: "interruptGoose", runId: "r1", id: "g1" },
      { op: "interruptExt", id: "aws1" },
      { op: "resolve", id: "aws1" },
    ],
  },
  {
    name: "three interrupts interleaved with runs, resolve middle",
    steps: [
      { op: "interruptGoose", runId: "r1", id: "g1" },
      { op: "startRun", runId: "r2" },
      { op: "interruptExt", id: "aws1" },
      { op: "interruptGoose", runId: "r2", id: "g2" },
      { op: "resolve", id: "aws1" },
    ],
  },
  {
    name: "resolve-all leaves nothing pending",
    steps: [
      { op: "interruptGoose", runId: "r1", id: "g1" },
      { op: "interruptExt", id: "aws1" },
      { op: "resolve", id: "g1" },
      { op: "resolve", id: "aws1" },
    ],
  },
];

describe("IntegrityAgent — approval-interrupt stress (model-based)", () => {
  for (const sc of SCENARIOS) {
    it(sc.name, async () => {
      const expected = expectedPending(sc.steps);
      const actual = await pendingAfter(sc.steps);
      expect([...actual].sort(), `pending set diverged from the model for: ${sc.name}`).toEqual([...expected].sort());
    });
  }
});
