/**
 * Tier-2 cluster — the deployment `.scooter` INJECTION path, end to end, in the REAL
 * OCI image (the prod container topology the VM nixosTests can't reproduce).
 *
 * A deployment ships a `.scooter` ConfigMap (module.nix + flake.nix + a tool source);
 * the provisioner seeds it into the per-conversation module CM, mounted at
 * /etc/agent-sandbox/scooter. The boot unit runs `scooter-apply-module --detach`, which
 * builds+switches to (base + the mounted module) in the background. The module declares
 * the deployment's tool as a `programs.lazyTools` stub that resolves
 * `path:/etc/agent-sandbox/scooter#<tool>` from the mounted flake — so after the boot
 * converge the tool is on PATH (and builds on first call).
 *
 * This is the gap that let two bugs ship green:
 *   - the seed copied ONLY module.nix, not flake.nix/tool sources (the lazy stub had no
 *     flake beside it → tool never on PATH);
 *   - `scooter-apply-module --detach` used `setsid` but util-linux wasn't on the
 *     writeShellApplication PATH → the detached converge never launched, status wedged.
 * Both reproduce ONLY here (minimal container, restricted PATH, the .scooter mount);
 * the self-modify spec calls apply WITHOUT --detach and writes the module directly, so
 * it exercises neither. We assert BOTH the tool lands on PATH AND the async status
 * reaches a terminal state.
 *
 * Uses a GENERIC fake tool ("review-app") — no deployment-specific names (scooter is
 * independent of any one deployment).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;
const NS = "agent-sandbox-converge-test";
const IMAGE = process.env.OVERLAY_IMAGE ?? "agent-sandbox-os-overlay:latest";
const POD = "converge-boot";
const SELECTOR = "app=converge-boot";
const UPPER = "/nix/.scooter-rw";
const SCOOTER_MOUNT = "/etc/agent-sandbox/scooter";
const STATUS = "/run/scooter/env-switch/status";
const TOOL = "review-app";

// A minimal deployment `.scooter` dir: module.nix declares the tool as a lazy stub
// that resolves from ./flake.nix; flake.nix exposes it as a package built from
// ./review-app.sh. This mirrors the real deployment convention with a fake tool.
const MODULE_NIX = `{ config, lib, pkgs, ... }:
{
  programs.lazyTools.tools.${TOOL} = {
    package = "${TOOL}";
    localFlake = "${SCOOTER_MOUNT}";
  };
}
`;

// Mirrors the real deployment .scooter flake: nixpkgs is a declared input, and the
// lazy stub builds --impure so `github:NixOS/nixpkgs` resolves against the sandbox's
// PINNED registry (devEnvNix) — the closure is already present in the image, no cold
// fetch. A bare `nixpkgs` with no input url falls to `flake:nixpkgs` registry lookup,
// which isn't resolvable in the pod (the cause of the first CI failure here).
const FLAKE_NIX = `{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs";
  outputs = { self, nixpkgs }:
    let system = "x86_64-linux";
    in {
      packages.\${system}.${TOOL} =
        nixpkgs.legacyPackages.\${system}.writeShellScriptBin "${TOOL}"
          (builtins.readFile ./review-app.sh);
    };
}
`;

const TOOL_SH = `#!/usr/bin/env bash
echo "review-app: fake deployment tool (help)"
`;

async function podStatus(cluster: Cluster): Promise<string> {
  const r = await cluster.exec(SELECTOR, ["sh", "-c", `cat ${STATUS} 2>/dev/null || true`], NS);
  return r.stdout.trim();
}

maybe("scooter .scooter injection: seed → boot converge → tool on PATH (k3d, real image)", () => {
  let cluster: Cluster;

  beforeAll(async () => {
    cluster = await withCluster({ installController: false, namespace: NS });
    await cluster.apply({ apiVersion: "v1", kind: "Namespace", metadata: { name: NS } }).catch(() => {});

    // The seeded .scooter files as a ConfigMap (what the provisioner would create as
    // the per-conversation module CM). Apply BEFORE the pod so it mounts from birth.
    await cluster.apply({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "scooter-module", namespace: NS },
      data: { "module.nix": MODULE_NIX, "flake.nix": FLAKE_NIX, "review-app.sh": TOOL_SH },
    });

    // Idempotent boot: delete a lingering pod from a crashed prior run first.
    await cluster.deletePod(POD, NS).catch(() => {});
    for (let i = 0; i < 60; i++) {
      const gone = await cluster.get("Pod", POD, NS).then(() => false).catch(() => true);
      if (gone) break;
      await new Promise((res) => setTimeout(res, 1000));
    }

    await cluster.apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: POD, namespace: NS, labels: { app: "converge-boot" } },
      spec: {
        containers: [
          {
            name: "sandbox",
            image: IMAGE,
            imagePullPolicy: "Never",
            securityContext: { privileged: true },
            volumeMounts: [
              { name: "run", mountPath: "/run" },
              { name: "tmp", mountPath: "/tmp" },
              { name: "overlay-upper", mountPath: UPPER },
              { name: "scooter", mountPath: SCOOTER_MOUNT, readOnly: true },
            ],
          },
        ],
        volumes: [
          { name: "run", emptyDir: { medium: "Memory" } },
          { name: "tmp", emptyDir: { medium: "Memory" } },
          { name: "overlay-upper", emptyDir: {} },
          { name: "scooter", configMap: { name: "scooter-module" } },
        ],
      },
    });
  }, 60_000);

  afterAll(async () => {
    await cluster?.deletePod(POD, NS).catch(() => {});
  });

  it("reaches Running and mounts all three .scooter files", async () => {
    await cluster.waitFor<{ status: { phase: string } }>(
      "Pod",
      POD,
      (p) => p.status?.phase === "Running",
      120_000,
      NS,
    );
    const ls = await cluster.exec(SELECTOR, ["ls", SCOOTER_MOUNT], NS);
    // All three seeded keys present (not just module.nix — the seed-all-keys fix).
    expect(ls.stdout).toContain("module.nix");
    expect(ls.stdout).toContain("flake.nix");
    expect(ls.stdout).toContain("review-app.sh");
  });

  it("the boot --detach converge runs and reaches a terminal status (not wedged at 'building'/'switching')", async () => {
    // The boot unit re-execs under setsid; if util-linux is missing the detached
    // converge never launches and this stays 'building' forever (the setsid bug).
    let status = "";
    for (let i = 0; i < 60; i++) {
      status = await podStatus(cluster);
      if (status === "done" || status === "failed") break;
      await new Promise((res) => setTimeout(res, 5000));
    }
    // A terminal status proves the async daemon actually launched + finished. We
    // accept "done"; a "failed" here would be a real converge regression, and
    // "building"/"switching" (never terminal) is the setsid wedge.
    expect(status, `env-switch status was '${status}' (empty/building/switching = the converge never completed)`).toBe("done");
  }, 320_000);

  it("the seeded lazy tool lands on PATH after the converge", async () => {
    // The lazyTools stub resolves path:${SCOOTER_MOUNT}#${TOOL} from the mounted
    // flake; after the switch it's on the new system's PATH. Query the CURRENT
    // system's sw/bin (a long-lived exec shell may still hold the pre-switch PATH).
    // The STUB being present on PATH is the product assertion (the seed + converge
    // wired the deployment tool in) — this is what the two bugs broke.
    const current = (await cluster.exec(SELECTOR, ["readlink", "-f", "/run/current-system"], NS)).stdout.trim();
    const which = await cluster.exec(SELECTOR, ["sh", "-c", `ls ${current}/sw/bin/${TOOL}; echo $?`], NS);
    expect(which.stdout.trim().split("\n").pop()).toBe("0");

    // And it RUNS: the stub builds the tool from the mounted flake on FIRST call
    // (nix build, substituting from cache), whose build logs interleave with the
    // tool's own output — and land on stderr/stdout unpredictably. So warm the build
    // with a throwaway first call, then assert on the SECOND (cached, clean) run, and
    // match against stdout+stderr combined so build noise on either stream can't hide
    // the tool's marker. Generous timeout for the cold first build.
    await cluster.exec(SELECTOR, ["sh", "-lc", `${current}/sw/bin/${TOOL} || true`], NS);
    const run = await cluster.exec(SELECTOR, ["sh", "-lc", `${current}/sw/bin/${TOOL}`], NS);
    expect(`${run.stdout}${run.stderr}`).toContain("review-app");
  }, 300_000);
});
