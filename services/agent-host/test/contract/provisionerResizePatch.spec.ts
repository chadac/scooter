/**
 * Contract — a resize must be sent as a MERGE patch.
 *
 * `@kubernetes/client-node` defaults `patchNamespacedCustomObject` to
 * `application/json-patch+json`, which expects an ARRAY of ops. `setSize` sent a
 * merge-shaped OBJECT without overriding that header, so the API server rejected
 * every resize with:
 *
 *     400 cannot unmarshal object into Go value of type []handlers.jsonPatchOp
 *
 * which broke ALL of it — the UI's Sandbox tab, the agent's own resize tool, the size
 * picker — for both presets and raw resources. The two other patch call sites in
 * k8sProvisioner always passed the header; this one did not, so nothing in the file
 * looked wrong on inspection.
 *
 * Found by trying to resize this very sandbox and reading the 400. Why: PR #653.
 */

import { describe, it, expect } from "vitest";
import { PatchStrategy } from "@kubernetes/client-node";

import { createK8sProvisioner } from "../../src/session/k8sProvisioner.js";

/** A fake k8s API recording the patch call's body AND its per-call options. */
function fakeKc(existing = true) {
  const patches: Array<{ body: unknown; opts: unknown }> = [];
  const created: unknown[] = [];
  const api = {
    createNamespacedServiceAccount: async () => ({}),
    createNamespacedCustomObject: async (p: { body?: unknown }) => {
      created.push(p.body);
      return {};
    },
    getNamespacedCustomObject: async () => {
      if (!existing) throw Object.assign(new Error("not found"), { code: 404 });
      return { spec: { podTemplate: { spec: { containers: [{ name: "sandbox", image: "img" }] } } } };
    },
    patchNamespacedCustomObject: async (body: unknown, opts: unknown) => {
      patches.push({ body, opts });
      return {};
    },
  };
  return { kc: { makeApiClient: () => api as never } as never, patches, created };
}

/**
 * The Content-Type the patch will actually be sent with.
 *
 * `setHeaderOptions` returns `{ middleware: [{ pre, post }] }` — the header lives
 * inside a closure, so inspecting (or JSON-stringifying) the options object tells you
 * nothing. Run the middleware against a recording context instead: that asserts the
 * header the REQUEST carries, which is the thing the API server rejects.
 */
function contentTypeOf(opts: unknown): string | undefined {
  const mw = (opts as { middleware?: Array<{ pre?: (ctx: unknown) => unknown }> } | undefined)?.middleware?.[0];
  if (!mw?.pre) return undefined;
  let seen: string | undefined;
  mw.pre({
    setHeaderParam: (k: string, v: string) => {
      if (k.toLowerCase() === "content-type") seen = v;
    },
  });
  return seen;
}

const provisioner = (kc: never, sizes?: Record<string, unknown>) =>
  createK8sProvisioner({
    namespace: "agent-sandbox",
    sandboxImage: "img",
    kubeConfig: kc,
    ...(sizes ? { sizePresetsJson: JSON.stringify(sizes) } : {}),
  });

describe("setSize — the patch content type", () => {
  it("sends a MERGE patch, not the client's default json-patch", async () => {
    const { kc, patches } = fakeKc();
    await provisioner(kc).setSize("conv1", { requests: { cpu: "2", memory: "8Gi" }, limits: { cpu: "2", memory: "8Gi" } });

    expect(patches).toHaveLength(1);
    // The header override is the whole fix: without it the API server 400s.
    expect(contentTypeOf(patches[0].opts)).toBe(PatchStrategy.MergePatch);
  });

  it("sends a merge-SHAPED body (an object), which is why the header must match", async () => {
    // A json-patch body would be an array of {op, path, value}. Asserting the shape
    // alongside the header keeps the two from drifting apart — either one alone is a
    // 400.
    const { kc, patches } = fakeKc();
    await provisioner(kc).setSize("conv1", { requests: { cpu: "2", memory: "8Gi" }, limits: { cpu: "2", memory: "8Gi" } });

    const body = (patches[0].body as { body: unknown }).body;
    expect(Array.isArray(body)).toBe(false);
    const containers = (body as {
      spec: { podTemplate: { spec: { containers: Array<{ resources?: unknown; name?: string }> } } };
    }).spec.podTemplate.spec.containers;
    expect(containers[0].resources).toEqual({
      requests: { cpu: "2", memory: "8Gi" },
      limits: { cpu: "2", memory: "8Gi" },
    });
    // The existing container is PATCHED, not replaced — dropping its name/image would
    // make the merge patch clobber the container it is trying to resize.
    expect(containers[0].name).toBe("sandbox");
  });

  it("applies the same patch for a named preset", async () => {
    // Presets and raw resources take the same path, so both broke together; assert the
    // preset route too rather than trusting they cannot diverge.
    const { kc, patches } = fakeKc();
    await provisioner(kc, { big: { cpu: "4", memory: "16Gi" } }).setSize("conv1", { size: "big" });

    expect(contentTypeOf(patches[0].opts)).toBe(PatchStrategy.MergePatch);
    const body = (patches[0].body as { body: unknown }).body as {
      spec: { podTemplate: { spec: { containers: Array<{ resources?: unknown }> } } };
    };
    expect(body.spec.podTemplate.spec.containers[0].resources).toEqual({
      requests: { cpu: "4", memory: "16Gi" },
      limits: { cpu: "4", memory: "16Gi" },
    });
  });

  it("creates the Sandbox cold instead of patching when none exists yet", async () => {
    // A size chosen before the first turn has no CR to patch; it must not silently
    // do nothing.
    const { kc, patches, created } = fakeKc(false);
    await provisioner(kc).setSize("conv1", { requests: { cpu: "2", memory: "8Gi" }, limits: { cpu: "2", memory: "8Gi" } });
    expect(patches).toHaveLength(0);
    expect(created).toHaveLength(1);
    expect((created[0] as { spec: { operatingMode: string } }).spec.operatingMode).toBe("Suspended");
  });
});
