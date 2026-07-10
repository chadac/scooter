/**
 * Tier 1 contract — create() SEEDS the per-conversation module CM from the
 * deployment's .scooter files (ALL keys of its scooterConfigMap), not empty and not
 * just module.nix.
 *
 * WHY: the per-conv module CM owns the converge path (mounted at
 * /etc/agent-sandbox/scooter), so the deployment's own scooter-tools mount is skipped
 * when it's present. If the CM were seeded empty, the deployment's injected tools
 * (e.g. a review CLI) would NEVER land + the boot converge would no-op on a 0-byte
 * module. And the mount is a DIRECTORY: the lazy tool path resolves
 * `path:/etc/agent-sandbox/scooter#<tool>` from the mounted flake, so seeding ONLY
 * module.nix leaves the declared stub without its flake.nix + tool sources and the
 * tool never lands on PATH (the deployment-scooter-injection bug — copy ALL keys).
 */

import { describe, it, expect } from "vitest";

import { createK8sProvisioner } from "../../src/session/k8sProvisioner.js";

const BASE_MODULE = `{ pkgs, ... }: { environment.systemPackages = [ pkgs.hello ]; }`;

/** A fake k8s API capturing the module-CM create body, with a scriptable
 *  readNamespacedConfigMap (the seed source). Stubs the rest of create()'s calls. */
function fakeKc(opts: { deploymentCm?: Record<string, string>; readThrows?: boolean } = {}) {
  const created: Array<{ name?: string; data?: Record<string, string> }> = [];
  const reads: string[] = [];
  const api = {
    createNamespacedServiceAccount: async () => ({}),
    createNamespacedConfigMap: async (p: { body?: { metadata?: { name?: string }; data?: Record<string, string> } }) => {
      created.push({ name: p.body?.metadata?.name, data: p.body?.data });
      return {};
    },
    readNamespacedConfigMap: async (p: { name?: string }) => {
      reads.push(p.name ?? "");
      if (opts.readThrows) throw Object.assign(new Error("boom"), { code: 500 });
      if (opts.deploymentCm) return { data: opts.deploymentCm };
      throw Object.assign(new Error("not found"), { code: 404 });
    },
    createNamespacedCustomObject: async () => ({}),
    readNamespacedPersistentVolumeClaim: async () => ({}),
  };
  const moduleCm = () => created.find((c) => c.name?.endsWith("-module"));
  return { kc: { makeApiClient: () => api as never } as never, created, reads, moduleCm };
}

// scooterConfigMap is a CONSTRUCTOR option (the deployment's, fixed per platform).
const provisioner = (kc: never, scooterConfigMap?: string) =>
  createK8sProvisioner({ namespace: "agent-manager", sandboxImage: "img", kubeConfig: kc, scooterConfigMap });

describe("k8sProvisioner.create — module CM seeding", () => {
  it("seeds the module CM from the deployment scooterConfigMap's module.nix", async () => {
    const { kc, moduleCm, reads } = fakeKc({ deploymentCm: { "module.nix": BASE_MODULE } });
    await provisioner(kc, "deploy-scooter").create("conv1", "conv1");
    expect(reads).toContain("deploy-scooter"); // read the deployment CM to seed
    expect(moduleCm()?.data?.["module.nix"]).toBe(BASE_MODULE); // seeded, not empty
  });

  it("seeds ALL keys (flake.nix + tool sources), not just module.nix", async () => {
    // A realistic deployment .scooter dir: module.nix declares a lazy tool that
    // resolves from ./flake.nix, which builds ./review-app.sh. Seeding only
    // module.nix would leave the lazy stub without its flake and the tool off PATH.
    const deploymentCm = {
      "module.nix": BASE_MODULE,
      "flake.nix": `{ outputs = _: { }; }`,
      "review-app.sh": `#!/bin/sh\necho review`,
    };
    const { kc, moduleCm } = fakeKc({ deploymentCm });
    await provisioner(kc, "deploy-scooter").create("conv1", "conv1");
    // Every key from the deployment CM is copied into the per-conv module CM.
    expect(moduleCm()?.data).toEqual(deploymentCm);
  });

  it("seeds EMPTY when no deployment scooterConfigMap is configured", async () => {
    const { kc, moduleCm, reads } = fakeKc();
    await provisioner(kc).create("conv1", "conv1");
    expect(reads).toEqual([]); // nothing to read
    expect(moduleCm()?.data?.["module.nix"]).toBe("");
  });

  it("seeds EMPTY (base config only) when the deployment CM has no module.nix key", async () => {
    const { kc, moduleCm } = fakeKc({ deploymentCm: { "other.nix": "x" } });
    await provisioner(kc, "deploy-scooter").create("conv1", "conv1");
    expect(moduleCm()?.data?.["module.nix"]).toBe("");
  });

  it("seeds EMPTY (never blocks create) when the deployment CM read FAILS", async () => {
    const { kc, moduleCm } = fakeKc({ readThrows: true });
    // A read error must not throw out of create() — the conversation still provisions.
    await expect(provisioner(kc, "deploy-scooter").create("conv1", "conv1")).resolves.toBeTruthy();
    expect(moduleCm()?.data?.["module.nix"]).toBe("");
  });
});
