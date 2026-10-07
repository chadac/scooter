/**
 * Tier 1 contract — the ConversationRegistry writes the assignment-table CR.
 *
 * register() converges the `Conversation` CR the controller assigns a hostPod to and the
 * router forwards by. It PATCHES first and creates only on 404: every conversation a
 * creator made already has a CR (the router writes it — #654 top-level, #726 subagents),
 * so create-first guaranteed a 409 before the patch that was always the real write.
 *
 * It MUST be idempotent and MUST NOT throw on any k8s error — a conversation has to start
 * locally even if the CR write fails (the guard fails open until a CR appears).
 * noopRegistry (the single-replica default) does nothing.
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
  // THE COMMON PATH. A creator wrote the CR, so one merge-patch is the whole operation —
  // no create, so no guaranteed 409 ahead of it.
  it("PATCHES the existing CR and does not attempt a create", async () => {
    const { kc, creates, specPatches } = fakeKc();
    await createK8sConversationRegistry("agent-sandbox", kc).register("conv-abc", {
      model: "claude-opus-4-8",
      owner: "alice",
      parentId: "conv-parent",
      sandboxRef: "conv-conv-abc",
    });

    expect(creates, "create-first was a wasted apiserver write on every start").toHaveLength(0);
    expect(specPatches).toHaveLength(1);
    expect(specPatches[0]).toMatchObject({
      group: "scooter.chadac.dev", version: "v1alpha1", plural: "conversations",
      namespace: "agent-sandbox", name: "conv-abc",
    });
    // MERGE patch — the creator's owner/model/parentId must survive, and sandboxRef (which
    // the router derives its routing short-id from) must land.
    const body = specPatches[0].body as { spec: Record<string, string> };
    expect(body.spec).toEqual({
      model: "claude-opus-4-8",
      owner: "alice",
      parentId: "conv-parent",
      sandboxRef: "conv-conv-abc",
    });
  });

  it("omits undefined spec fields (anonymous, no parent) rather than sending nulls", async () => {
    const { kc, specPatches } = fakeKc();
    await createK8sConversationRegistry("agent-sandbox", kc).register("conv-1", { model: "m" });
    const body = specPatches[0].body as { spec: Record<string, string> };
    expect(body.spec).toEqual({ model: "m" });
    expect("owner" in body.spec).toBe(false);
    expect("parentId" in body.spec).toBe(false);
  });

  it("CREATES on 404 — the stacks with no creator ahead of them still get a CR", async () => {
    // The native/kube-less stack and adoption of a conversation that predates the router.
    const { kc, creates } = fakeKc({ specPatchCode: 404 });
    await createK8sConversationRegistry("ns", kc).register("conv-1", { model: "m", sandboxRef: "conv-abc" });

    expect(creates).toHaveLength(1);
    const body = creates[0].body as { metadata: { name: string }; kind: string; spec: Record<string, string> };
    expect(body.kind).toBe("Conversation");
    expect(body.metadata.name).toBe("conv-1");
    expect(body.spec).toEqual({ model: "m", sandboxRef: "conv-abc" });
  });

  it("swallows a 409 on that create (a creator wrote the CR inside the 404 window)", async () => {
    const { kc } = fakeKc({ specPatchCode: 404, code: 409 });
    await expect(createK8sConversationRegistry("ns", kc).register("conv-1", {})).resolves.toBeUndefined();
  });

  it("swallows a non-404 patch error (a conversation must still start) and logs it", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { kc, creates } = fakeKc({ specPatchCode: 500 });
    await expect(createK8sConversationRegistry("ns", kc).register("conv-1", {})).resolves.toBeUndefined();
    expect(creates, "a 500 is not 'no CR' — creating would be a guess").toHaveLength(0);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("swallows a failed create after a 404 and logs it", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { kc } = fakeKc({ specPatchCode: 404, code: 500 });
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
function throttlingKc(opts: {
  failStatus?: Array<{ code: number; headers?: Record<string, string> }>;
  failCreate?: Array<{ code: number; headers?: Record<string, string> }>;
  failSpecPatch?: Array<{ code: number; headers?: Record<string, string> }>;
} = {}) {
  const failStatus = [...(opts.failStatus ?? [])];
  const failCreate = [...(opts.failCreate ?? [])];
  const failSpecPatch = [...(opts.failSpecPatch ?? [])];
  const phases: string[] = [];
  const creates: number[] = [];
  const specPatches: number[] = [];
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
    patchNamespacedCustomObject: async () => {
      specPatches.push(1);
      const f = failSpecPatch.shift();
      if (f) throw Object.assign(new Error("k8s"), f);
      return {};
    },
    deleteNamespacedCustomObject: async () => ({}),
  };
  return {
    kc: { makeApiClient: () => api as never } as never,
    phases,
    creates,
    specPatches,
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
  it("retries a throttled register instead of dropping the spec write", async () => {
    // register() patches first now, so the throttled call on the hot path is the PATCH.
    const { kc, specPatches } = throttlingKc({ failSpecPatch: [{ code: 429 }] });
    const { sleep, waits } = recordingSleep();
    await createK8sConversationRegistry("ns", kc, { sleep }).register("conv-1", { model: "m" });
    expect(specPatches).toHaveLength(2); // throttled once, then landed
    expect(waits).toHaveLength(1);
  });

  it("retries a throttled CREATE too, on the 404 path", async () => {
    const { kc, creates } = throttlingKc({
      failSpecPatch: [{ code: 404 }],
      failCreate: [{ code: 429 }],
    });
    const { sleep, waits } = recordingSleep();
    await createK8sConversationRegistry("ns", kc, { sleep }).register("conv-1", { model: "m" });
    expect(creates).toHaveLength(2);
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
