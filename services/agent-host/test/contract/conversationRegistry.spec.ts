/**
 * Tier 1 contract — the ConversationRegistry writes the assignment-table CR.
 *
 * register() creates a `Conversation` CR (the controller then assigns it a hostPod, the
 * router forwards to it). It MUST be idempotent (409 AlreadyExists = a re-start/race =
 * no-op) and MUST NOT throw on any k8s error — a conversation has to start locally even
 * if the CR write fails (the guard fails open until a CR appears). noopRegistry (the
 * single-replica default) does nothing.
 */

import { describe, it, expect, vi } from "vitest";

import { noopRegistry } from "../../src/session/conversationRegistry.js";
import { createK8sConversationRegistry, retryAfterMs } from "../../src/session/k8sConversationRegistry.js";

/** A fake KubeConfig whose CustomObjectsApi records create + status-patch calls and can be
 *  told to fail (create failures via opts.code; status-patch failures via opts.patchCode). */
function fakeKc(opts: { code?: number; patchCode?: number; specPatchCode?: number } = {}) {
  const creates: Array<Record<string, unknown>> = [];
  const patches: Array<Record<string, unknown>> = [];
  const specPatches: Array<Record<string, unknown>> = [];
  const api = {
    patchNamespacedCustomObject: async (args: Record<string, unknown>) => {
      specPatches.push(args);
      if (opts.specPatchCode) throw Object.assign(new Error("k8s"), { code: opts.specPatchCode });
      return {};
    },
    createNamespacedCustomObject: async (args: Record<string, unknown>) => {
      creates.push(args);
      if (opts.code) throw Object.assign(new Error("k8s"), { code: opts.code });
      return {};
    },
    patchNamespacedCustomObjectStatus: async (args: Record<string, unknown>) => {
      patches.push(args);
      if (opts.patchCode) throw Object.assign(new Error("k8s"), { code: opts.patchCode });
      return {};
    },
  };
  return { kc: { makeApiClient: () => api as never } as never, creates, patches, specPatches };
}

describe("noopRegistry (single-replica default)", () => {
  it("register() is a no-op that resolves", async () => {
    await expect(noopRegistry.register("conv-1", { model: "m" })).resolves.toBeUndefined();
  });
  it("setPhase() is a no-op that resolves", async () => {
    await expect(noopRegistry.setPhase("conv-1", "Suspended")).resolves.toBeUndefined();
  });
});

describe("k8sConversationRegistry.register", () => {
  it("creates a Conversation CR named by the conversation id, with the spec fields set", async () => {
    const { kc, creates } = fakeKc();
    await createK8sConversationRegistry("agent-sandbox", kc).register("conv-abc", {
      model: "claude-opus-4-8",
      owner: "alice",
      parentId: "conv-parent",
      sandboxRef: "conv-conv-abc",
    });
    expect(creates).toHaveLength(1);
    const body = creates[0].body as { metadata: { name: string }; kind: string; spec: Record<string, string> };
    expect(creates[0]).toMatchObject({ group: "scooter.chadac.dev", version: "v1alpha1", plural: "conversations", namespace: "agent-sandbox" });
    expect(body.kind).toBe("Conversation");
    expect(body.metadata.name).toBe("conv-abc");
    expect(body.spec).toEqual({
      model: "claude-opus-4-8",
      owner: "alice",
      parentId: "conv-parent",
      sandboxRef: "conv-conv-abc",
    });
  });

  it("omits undefined spec fields (anonymous, no parent) rather than sending nulls", async () => {
    const { kc, creates } = fakeKc();
    await createK8sConversationRegistry("agent-sandbox", kc).register("conv-1", { model: "m" });
    const body = creates[0].body as { spec: Record<string, string> };
    expect(body.spec).toEqual({ model: "m" });
    expect("owner" in body.spec).toBe(false);
    expect("parentId" in body.spec).toBe(false);
  });

  it("swallows a 409 AlreadyExists (idempotent re-register / race)", async () => {
    const { kc } = fakeKc({ code: 409 });
    await expect(createK8sConversationRegistry("ns", kc).register("conv-1", {})).resolves.toBeUndefined();
  });

  it("PATCHES the spec on 409 so a router-created CR gets its sandboxRef", async () => {
    // The router creates the CR (POST /conversations) with no sandboxRef — it does not
    // provision. So 409 is now the COMMON path, not a rare race. Swallowing it outright
    // meant sandboxRef could never be written, and the router derives its routing short-id
    // from that field: the conversation stayed unroutable for its whole life.
    const { kc, specPatches } = fakeKc({ code: 409 });
    await createK8sConversationRegistry("ns", kc).register("conv-1", {
      model: "sonnet",
      sandboxRef: "conv-abc123",
    });

    expect(specPatches).toHaveLength(1);
    const body = specPatches[0].body as { spec: Record<string, string> };
    expect(body.spec.sandboxRef).toBe("conv-abc123");
    // MERGE patch, not replace — owner/model/parentId as the creator set them must survive.
    expect(specPatches[0].name).toBe("conv-1");
  });

  it("swallows a 404 on the 409 spec-patch (CR deleted mid-flight)", async () => {
    const { kc } = fakeKc({ code: 409, specPatchCode: 404 });
    await expect(
      createK8sConversationRegistry("ns", kc).register("conv-1", { sandboxRef: "conv-abc" }),
    ).resolves.toBeUndefined();
  });

  it("swallows a non-409 error (a conversation must still start) and logs it", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { kc } = fakeKc({ code: 500 });
    await expect(createK8sConversationRegistry("ns", kc).register("conv-1", {})).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("k8sConversationRegistry.setPhase (liveness → status.phase)", () => {
  it("patches ONLY status.phase on the status subresource (leaving hostPod/gen untouched)", async () => {
    const { kc, patches } = fakeKc();
    await createK8sConversationRegistry("agent-sandbox", kc).setPhase("conv-abc", "Suspended");
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      group: "scooter.chadac.dev", version: "v1alpha1", plural: "conversations",
      namespace: "agent-sandbox", name: "conv-abc",
      body: { status: { phase: "Suspended" } },
    });
    // a merge patch of just {status:{phase}} — no hostPod/hostIP/generation keys.
    const body = patches[0].body as { status: Record<string, unknown> };
    expect(Object.keys(body.status)).toEqual(["phase"]);
  });

  it("swallows a 404 (CR not created yet / gone) without logging an error", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { kc } = fakeKc({ patchCode: 404 });
    await expect(createK8sConversationRegistry("ns", kc).setPhase("conv-1", "Assigned")).resolves.toBeUndefined();
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("swallows a non-404 error and logs it (a failed publish must not block suspend)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { kc } = fakeKc({ patchCode: 500 });
    await expect(createK8sConversationRegistry("ns", kc).setPhase("conv-1", "Suspended")).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

/**
 * Tier 1 contract — a 429 is "later", not "no".
 *
 * The apiserver throttles under priority-and-fairness (59 of them in a day on a live
 * cluster). Treated as a plain failure, a 429 is a LOST write: the phase never lands, the
 * CR goes stale, and the ownership fence then reads a view that disagrees with reality.
 * These tests pin the retry, the Retry-After it must honour, and the coalescing that stops
 * the registry generating the burst in the first place.
 */

/** Records every call and can be told to fail the next N with a given error. */
function throttlingKc(opts: { failStatus?: Array<{ code: number; headers?: Record<string, string> }>; failCreate?: Array<{ code: number; headers?: Record<string, string> }> } = {}) {
  const failStatus = [...(opts.failStatus ?? [])];
  const failCreate = [...(opts.failCreate ?? [])];
  const phases: string[] = [];
  const creates: number[] = [];
  let holdNext = false;
  let release: (() => void) | undefined;
  const api = {
    patchNamespacedCustomObjectStatus: async (args: Record<string, unknown>) => {
      phases.push(((args.body as { status: { phase: string } }).status.phase));
      if (holdNext) {
        holdNext = false;
        await new Promise<void>((r) => (release = r));
      }
      const f = failStatus.shift();
      if (f) throw Object.assign(new Error("k8s"), f);
      return {};
    },
    createNamespacedCustomObject: async () => {
      creates.push(1);
      const f = failCreate.shift();
      if (f) throw Object.assign(new Error("k8s"), f);
      return {};
    },
    patchNamespacedCustomObject: async () => ({}),
    deleteNamespacedCustomObject: async () => ({}),
  };
  return {
    kc: { makeApiClient: () => api as never } as never,
    phases,
    creates,
    hold: () => {
      holdNext = true;
    },
    release: () => release?.(),
  };
}

/** An instant sleep that RECORDS what it was asked to wait — the delay is the behaviour
 *  under test, so a real timer would only make the suite slow, not more truthful. */
function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

describe("k8sConversationRegistry throttling (429)", () => {
  it("retries a throttled create instead of dropping the CR", async () => {
    const { kc, creates } = throttlingKc({ failCreate: [{ code: 429 }] });
    const { sleep, waits } = recordingSleep();
    await createK8sConversationRegistry("ns", kc, { sleep }).register("conv-1", { model: "m" });
    expect(creates).toHaveLength(2); // throttled once, then landed
    expect(waits).toHaveLength(1);
  });

  it("waits exactly as long as Retry-After asks, rather than guessing", async () => {
    // The apiserver knows when its queue will have room; a client retrying on its own
    // schedule is what turns a throttle into a storm.
    const { kc } = throttlingKc({ failStatus: [{ code: 429, headers: { "retry-after": "2" } }] });
    const { sleep, waits } = recordingSleep();
    await createK8sConversationRegistry("ns", kc, { sleep }).setPhase("conv-1", "Suspended");
    expect(waits).toEqual([2000]);
  });

  it("backs off EXPONENTIALLY when the server sends no Retry-After", async () => {
    const { kc } = throttlingKc({ failStatus: [{ code: 429 }, { code: 429 }, { code: 429 }] });
    const { sleep, waits } = recordingSleep();
    await createK8sConversationRegistry("ns", kc, { sleep }).setPhase("conv-1", "Suspended");
    expect(waits).toHaveLength(3);
    // Jittered (half the ceiling to the ceiling), so assert the envelope, not a value —
    // without jitter the whole fleet retries in lockstep and rebuilds the burst.
    expect(waits[0]).toBeGreaterThanOrEqual(125);
    expect(waits[0]).toBeLessThanOrEqual(250);
    expect(waits[2]).toBeGreaterThan(waits[0]);
    expect(waits[2]).toBeLessThanOrEqual(1000);
  });

  it("gives up after the attempt budget WITHOUT throwing (a write must not fail suspend)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { kc, phases } = throttlingKc({ failStatus: Array(5).fill({ code: 429 }) });
    const { sleep } = recordingSleep();
    const reg = createK8sConversationRegistry("ns", kc, { sleep, maxAttempts: 3 });
    await expect(reg.setPhase("conv-1", "Suspended")).resolves.toBeUndefined();
    expect(phases).toHaveLength(3);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("does NOT retry a 404/409/500 — those mean something other than 'later'", async () => {
    const { kc, phases } = throttlingKc({ failStatus: [{ code: 404 }] });
    const { sleep, waits } = recordingSleep();
    await createK8sConversationRegistry("ns", kc, { sleep }).setPhase("conv-1", "Assigned");
    expect(phases).toHaveLength(1);
    expect(waits).toEqual([]);
  });
});

describe("k8sConversationRegistry.setPhase coalescing", () => {
  it("does not re-publish a phase the CR already carries", async () => {
    const { kc, phases } = throttlingKc();
    const reg = createK8sConversationRegistry("ns", kc);
    await reg.setPhase("conv-1", "Suspended");
    await reg.setPhase("conv-1", "Suspended");
    await reg.setPhase("conv-1", "Suspended");
    expect(phases).toEqual(["Suspended"]);
  });

  it("folds a burst into the write in flight plus ONE write of the final phase", async () => {
    // Liveness is a level, not an edge: the intermediate values of a burst are not
    // information, they are just requests the apiserver has to answer.
    const f = throttlingKc();
    const reg = createK8sConversationRegistry("ns", f.kc);
    f.hold();
    const first = reg.setPhase("conv-1", "Suspended");
    void reg.setPhase("conv-1", "Assigned");
    void reg.setPhase("conv-1", "Suspended");
    void reg.setPhase("conv-1", "Assigned");
    f.release();
    await first;
    expect(f.phases).toEqual(["Suspended", "Assigned"]);
  });

  it("re-publishes after a FAILED write rather than believing a phase that never landed", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { kc, phases } = throttlingKc({ failStatus: [{ code: 500 }] });
    const reg = createK8sConversationRegistry("ns", kc);
    await reg.setPhase("conv-1", "Suspended");
    await reg.setPhase("conv-1", "Suspended");
    expect(phases).toEqual(["Suspended", "Suspended"]);
    err.mockRestore();
  });

  it("forgets the published phase when the CR is removed (a recreated id starts clean)", async () => {
    const { kc, phases } = throttlingKc();
    const reg = createK8sConversationRegistry("ns", kc);
    await reg.setPhase("conv-1", "Assigned");
    await reg.remove("conv-1");
    await reg.setPhase("conv-1", "Assigned");
    expect(phases).toEqual(["Assigned", "Assigned"]);
  });
});

describe("retryAfterMs", () => {
  it("reads delta-seconds", () => {
    expect(retryAfterMs({ headers: { "retry-after": "3" } })).toBe(3000);
  });

  it("reads the HTTP-date form, relative to now", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(retryAfterMs({ headers: { "Retry-After": "Thu, 01 Jan 2026 00:00:05 GMT" } }, now)).toBe(5000);
  });

  it("never returns a negative wait for a date already past", () => {
    const now = Date.parse("2026-01-01T00:00:10Z");
    expect(retryAfterMs({ headers: { "retry-after": "Thu, 01 Jan 2026 00:00:05 GMT" } }, now)).toBe(0);
  });

  it("is undefined when there is no usable header, so the caller backs off on its own", () => {
    expect(retryAfterMs({})).toBeUndefined();
    expect(retryAfterMs({ headers: {} })).toBeUndefined();
    expect(retryAfterMs({ headers: { "retry-after": "soon" } })).toBeUndefined();
  });
});
