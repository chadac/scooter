/**
 * manager.setModel, the model picker's switch: applied without a prompt, and deferred to the
 * run's end when a run is in flight so the turn is never killed.
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

/** Bridges whose running state the test drives, and whose persisted events it can emit. */
function controllableFactory() {
  const built: Array<{ model?: string; stop: ReturnType<typeof vi.fn>; emit: (e: AguiEvent) => void }> = [];
  const state = { running: false };
  const factory = (args: { model?: string }) => {
    const listeners: Array<(e: AguiEvent) => void> = [];
    const stop = vi.fn(async () => {});
    built.push({ model: args.model, stop, emit: (e) => listeners.forEach((l) => l(e)) });
    return {
      start: vi.fn(async () => {}),
      prompt: vi.fn(async () => "run-x"),
      cancel: vi.fn(async () => {}),
      stop,
      queueState: () => ({ running: state.running, queued: 0 }),
      onEvent: () => () => {},
      onPersist: (l: (e: AguiEvent) => void) => {
        listeners.push(l);
        return () => {};
      },
      onTitle: () => () => {},
    } as never;
  };
  return { factory, built, state };
}

const setup = async () => {
  const f = controllableFactory();
  const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore(), bridgeFactory: f.factory });
  const conv = await sessions.start("thread-1", "opus");
  await sessions.prompt(conv.id, "hi");
  return { ...f, sessions, conv };
};

describe("setModel (switch without a prompt)", () => {
  it("idle: switches now, drops the old bridge, and the next prompt runs on the new model", async () => {
    const { sessions, conv, built } = await setup();
    expect(await sessions.setModel(conv.id, "sonnet")).toEqual({ deferred: false });
    expect(sessions.get(conv.id)?.model).toBe("sonnet");
    expect(sessions.get(conv.id)?.modelSetBy).toBe("user");
    expect(built[0].stop).toHaveBeenCalled();

    await sessions.prompt(conv.id, "next");
    expect(built.at(-1)!.model).toBe("sonnet");
  });

  it("mid-run: records the model but keeps the run alive, then rebuilds when it ends", async () => {
    const { sessions, conv, built, state } = await setup();
    state.running = true;
    expect(await sessions.setModel(conv.id, "sonnet")).toEqual({ deferred: true });
    expect(sessions.get(conv.id)?.model).toBe("sonnet");
    expect(built[0].stop).not.toHaveBeenCalled();

    // A message sent meanwhile must not kill the turn either.
    await sessions.prompt(conv.id, "queued");
    expect(built[0].stop).not.toHaveBeenCalled();

    state.running = false;
    built[0].emit({ type: "RUN_FINISHED" } as AguiEvent);
    await vi.waitFor(() => expect(built[0].stop).toHaveBeenCalled());

    await sessions.prompt(conv.id, "after");
    expect(built.at(-1)!.model).toBe("sonnet");
  });

  it("is a no-op when the model is already current", async () => {
    const { sessions, conv, built } = await setup();
    expect(await sessions.setModel(conv.id, "opus")).toEqual({ deferred: false });
    expect(built[0].stop).not.toHaveBeenCalled();
  });

  it("a provider-only switch rebuilds too", async () => {
    const { sessions, conv, built } = await setup();
    await sessions.setModel(conv.id, "opus", "bedrock");
    expect(built[0].stop).toHaveBeenCalled();
  });

  it("throws on an unknown conversation", async () => {
    const { sessions } = await setup();
    await expect(sessions.setModel("nope", "sonnet")).rejects.toThrow(/unknown conversation/);
  });
});
