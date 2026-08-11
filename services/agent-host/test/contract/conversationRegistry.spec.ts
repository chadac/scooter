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

/** A fake KubeConfig whose CustomObjectsApi records create calls and can be told to fail. */
function fakeKc(opts: { code?: number } = {}) {
  const creates: Array<Record<string, unknown>> = [];
  const api = {
    createNamespacedCustomObject: async (args: Record<string, unknown>) => {
      creates.push(args);
      if (opts.code) throw Object.assign(new Error("k8s"), { code: opts.code });
      return {};
    },
  };
  return { kc: { makeApiClient: () => api as never } as never, creates };
}

describe("noopRegistry (single-replica default)", () => {
  it("register() is a no-op that resolves", async () => {
    await expect(noopRegistry.register("conv-1", { model: "m" })).resolves.toBeUndefined();
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

  it("swallows a non-409 error (a conversation must still start) and logs it", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { kc } = fakeKc({ code: 500 });
    await expect(createK8sConversationRegistry("ns", kc).register("conv-1", {})).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
