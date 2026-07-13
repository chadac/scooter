/**
 * Tier 1 contract — manager.switchModelNow (agent model-switch, stage 2).
 *
 * The immediate MID-TURN switch the switch_model MCP tool calls: cancel the live
 * run, rebuild goose with the new model, and re-nudge to continue. Pins the exact
 * sequence + the load-bearing regression guard: it must REBUILD (not just tear the
 * bridge down and strand the turn), and it must not race (the continue-nudge is
 * strictly after the rebuild). See docs/AGENT_MODEL_SWITCH.md.
 */

import { describe, it, expect, vi } from "vitest";

import {
  createSessionManager,
  type SandboxProvisioner,
  type ConversationStore,
} from "../../src/session/manager.js";
import type { AguiEvent } from "../../src/bridge.js";
import type { SandboxRef, SessionId } from "../../src/types.js";

const fakeProvisioner = (): SandboxProvisioner => ({
  create: vi.fn(async (id) => ({ name: `conv-${id}`, namespace: "ns" }) as SandboxRef),
  suspend: vi.fn(async () => {}),
  resume: vi.fn(async (ref) => ref),
  destroy: vi.fn(async () => {}),
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

/** A bridgeFactory that records the model each built bridge got + a shared,
 *  ordered call log across all bridges (so we can assert cancel-then-continue
 *  spanned the OLD bridge (cancel) and a NEW one (prompt)). */
function trackingFactory() {
  const built: Array<{ model?: string }> = [];
  const log: string[] = [];
  const factory = (args: { model?: string }) => {
    const idx = built.length;
    built.push({ model: args.model });
    return {
      start: vi.fn(async () => {}),
      prompt: vi.fn(async () => {
        log.push(`prompt#${idx}`);
        return "run-x";
      }),
      cancel: vi.fn(async () => {
        log.push(`cancel#${idx}`);
      }),
      stop: vi.fn(async () => {}),
      onEvent: () => () => {},
      onPersist: () => () => {},
      onTitle: () => () => {},
    } as never;
  };
  return { factory, built, log };
}

describe("switchModelNow (immediate mid-turn model switch)", () => {
  it("cancels the running turn, rebuilds goose with the NEW model, and re-nudges to continue", async () => {
    const { factory, built, log } = trackingFactory();
    const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore(), bridgeFactory: factory });
    // Start on "opus" (the first prompt picks the model), then a normal prompt so a
    // live bridge exists (goose "running").
    const conv = await sessions.start("thread-1", "opus");
    await sessions.prompt(conv.id, "do the thing");
    log.length = 0; // ignore the setup prompt

    const switched = await sessions.switchModelNow(conv.id, "sonnet");
    expect(switched).toBe(true);

    // The OLD bridge (built with opus) was cancelled; a NEW bridge (built with
    // sonnet) ran the continue-nudge. Cancel strictly before the continue.
    expect(built[0].model).toBe("opus");
    expect(built.at(-1)!.model).toBe("sonnet");
    expect(log[0]).toMatch(/^cancel#/);
    expect(log.at(-1)).toMatch(/^prompt#/);
    // The continue prompt ran on a DIFFERENT (newer) bridge than the one cancelled.
    const cancelIdx = Number(log[0].split("#")[1]);
    const promptIdx = Number(log.at(-1)!.split("#")[1]);
    expect(promptIdx).toBeGreaterThan(cancelIdx);

    // The conversation's persisted model is now sonnet.
    expect(sessions.get(conv.id)?.model).toBe("sonnet");
  });

  it("is a no-op when the model is already current (no cancel, no rebuild)", async () => {
    const { factory, log } = trackingFactory();
    const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore(), bridgeFactory: factory });
    const conv = await sessions.start("thread-1", "opus");
    await sessions.prompt(conv.id, "hi");
    log.length = 0;

    const switched = await sessions.switchModelNow(conv.id, "opus");
    expect(switched).toBe(false);
    expect(log).toEqual([]); // nothing cancelled or re-prompted
    expect(sessions.get(conv.id)?.model).toBe("opus");
  });

  it("ALWAYS leaves a live bridge on the new model (never tears down without rebuilding)", async () => {
    // The mid-turn-kill regression: applyModelSwitch alone sets bridge=undefined and
    // relies on the NEXT prompt to rebuild — if switchModelNow did that it would
    // strand the turn that called it. Assert a live bridge on the new model remains.
    const { factory, built } = trackingFactory();
    const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore(), bridgeFactory: factory });
    const conv = await sessions.start("thread-1", "opus");
    await sessions.prompt(conv.id, "work");

    await sessions.switchModelNow(conv.id, "sonnet");

    // A subsequent normal prompt must NOT need to build yet another bridge (the
    // switch already left one live) — i.e. the last built bridge is on sonnet and
    // is the live one.
    const builtCount = built.length;
    await sessions.prompt(conv.id, "next");
    expect(built.length).toBe(builtCount); // no extra rebuild -> bridge was live
    expect(built.at(-1)!.model).toBe("sonnet");
  });

  it("throws on an unknown conversation", async () => {
    const { factory } = trackingFactory();
    const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore(), bridgeFactory: factory });
    await expect(sessions.switchModelNow("nope", "sonnet")).rejects.toThrow(/unknown conversation/);
  });
});
