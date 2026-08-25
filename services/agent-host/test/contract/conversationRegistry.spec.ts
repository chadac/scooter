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
import { createK8sConversationRegistry } from "../../src/session/k8sConversationRegistry.js";

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
