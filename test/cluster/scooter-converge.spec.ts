/**
 * Tier-2 cluster — the deployment `.scooter` INJECTION path, end to end, in the REAL
 * OCI image (the prod container topology the VM nixosTests can't reproduce).
 *
 * A deployment ships a `.scooter` ConfigMap (module.nix + flake.nix + a tool source),
 * mounted at /etc/agent-sandbox/scooter. The boot unit runs `scooter-apply-module
 * --detach`, which builds+switches to (base + the mounted module) in the background. The
 * module declares the deployment's tool as a `programs.injectedTools` stub that resolves
 * `path:/etc/agent-sandbox/scooter#<tool>` from the mounted flake — so after the boot
 * converge the tool is on PATH (and builds on first call).
 *
 * Only this tier reproduces the interaction (minimal container, restricted PATH, the
 * real .scooter mount); the self-modify spec calls apply WITHOUT --detach and writes the
 * module directly, so it exercises neither the mount delivery nor the detach path. We
 * assert BOTH the tool lands on PATH AND the async status reaches a terminal state.
 *
 * Uses a GENERIC fake tool ("review-app") — no deployment-specific names (scooter is
 * independent of any one deployment).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;
const NS = "agent-sandbox-converge-test";
const IMAGE = process.env.OVERLAY_IMAGE ?? "agent-sandbox-os:latest";
const POD = "converge-boot";
const SELECTOR = "app=converge-boot";
const UPPER = "/nix/.scooter-rw";
const SCOOTER_MOUNT = "/etc/agent-sandbox/scooter";
const STATUS = "/run/scooter/env-switch/status";
const TOOL = "review-app";

// Pod-side store diagnostic, dumped when the converge does not reach 'done'.
//
// "path '…-sandbox-os-src' is not valid" only says a store path missed the Nix DB —
// it does not say WHICH db (the baked read-only lower, or the overlay upper's state),
// nor whether the miss is specific to that path or total. This answers both in one
// shot; the CONTROL path (/run/current-system, which is definitionally in the baked
// closure) is the discriminator: control-valid + tree-invalid = a registration gap,
// both invalid = the pod is not reading the baked DB at all.
const STORE_DIAGNOSTIC = [
  "set +e",
  'echo "--- nix.conf ---"; cat /etc/nix/nix.conf 2>&1',
  'echo "--- nix store mounts ---"; grep nix /proc/mounts 2>&1',
  'echo "--- baked lower db ---"; ls -l /nix/var/nix/db/ 2>&1',
  'echo "--- overlay upper state ---"; ls -lR /nix/.scooter-rw/state 2>&1 | head -20',
  // Pass the features explicitly: a diagnostic that dies on "experimental feature
  // not enabled" wastes the whole CI round-trip it exists to save.
  "EF='--extra-experimental-features nix-command --extra-experimental-features read-only-local-store --extra-experimental-features local-overlay-store'",
  "AP=$(readlink -f /run/current-system/sw/bin/scooter-apply-module)",
  "TREE=$(grep -o '/nix/store/[a-z0-9]*-sandbox-os-src' \"$AP\" | head -1)",
  'echo "tree=$TREE"',
  'echo "--- tree present on disk? ---"; ls -ld "$TREE" "/nix/.scooter-ro/${TREE#/nix/store/}" 2>&1',
  'echo "--- tree: merged (local-overlay) store ---"; nix $EF path-info "$TREE" 2>&1 | head -3',
  "echo \"--- tree: lower store only ---\"; nix $EF path-info --store 'local?root=/&real=/nix/.scooter-ro&read-only=true' \"$TREE\" 2>&1 | head -3",
  'echo "--- CONTROL (current system) : merged ---"; nix $EF path-info "$(readlink -f /run/current-system)" 2>&1 | head -3',
  "echo \"--- CONTROL : lower store only ---\"; nix $EF path-info --store 'local?root=/&real=/nix/.scooter-ro&read-only=true' \"$(readlink -f /run/current-system)\" 2>&1 | head -3",
  // NOT `nix eval builtins.storePath`: eval commands set readOnlyMode, which makes
  // storePath skip ensurePath entirely, so it passes even on an invalid path. This is
  // the same check the failing converge makes, in a mode that actually performs it.
  'echo "--- nix-store -r (the real validity check) ---"; nix-store -r "$TREE" 2>&1 | head -4',
  // Is it TRANSIENT? path-info above passed on a path the converge just called
  // invalid, and the overlay upper DB is carrying a ~164MB uncheckpointed WAL — i.e.
  // the store was still settling. If a straight retry now succeeds, the bug is a race
  // against the local-overlay store coming up, not a missing registration.
  // Capture the exit code BEFORE piping — `cmd | tail` reports tail's status, not the
  // converge's, which is the whole point of the probe.
  'echo "--- retry the converge now ---"; timeout 180 scooter-apply-module > /tmp/retry.out 2>&1; echo "retry-exit=$?"; tail -12 /tmp/retry.out',
  'echo "--- when did it fail vs now? ---"; date; ls -l --time-style=full-iso /run/scooter/env-switch/ 2>&1',
  'echo "--- upper WAL now (compare to above) ---"; ls -l /nix/.scooter-rw/state/db/ 2>&1',
  'echo "--- disk ---"; df -h /nix/.scooter-rw / 2>&1',
  'echo "--- units ---"; journalctl -b --no-pager -u overlay-store-setup -u nix-daemon -u scooter-apply-module 2>&1 | tail -40',
].join("\n");

// A minimal deployment `.scooter` dir: module.nix declares the tool as an INJECTED
// tool that resolves from ./flake.nix at runtime; flake.nix exposes it as a package built from
// ./review-app.sh. This mirrors the real deployment convention with a fake tool.
const MODULE_NIX = `{ config, lib, pkgs, ... }:
{
  programs.injectedTools.tools.${TOOL} = {
    package = "${TOOL}";
    flake = "${SCOOTER_MOUNT}";
  };
}
`;

// Mirrors the real deployment .scooter flake: nixpkgs is a declared input, and the
// injected stub builds --impure so `github:NixOS/nixpkgs` resolves against the sandbox's
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
    // On any non-done status, surface the pod's env-switch error + log tail so the
    // exact failure (e.g. "switch introduced failed units: X") is visible in CI —
    // otherwise a 'failed'/'' status is undiagnosable after the cluster is torn down.
    if (status !== "done") {
      const err = await cluster
        .exec(SELECTOR, ["sh", "-c", "cat /run/scooter/env-switch/error 2>/dev/null || true"], NS)
        .then((r) => r.stdout.trim())
        .catch(() => "");
      const log = await cluster
        .exec(SELECTOR, ["sh", "-c", "tail -50 /run/scooter/env-switch/log 2>/dev/null || true"], NS)
        .then((r) => r.stdout)
        .catch(() => "");
      const store = await cluster
        .exec(SELECTOR, ["sh", "-c", STORE_DIAGNOSTIC], NS)
        .then((r) => r.stdout)
        .catch((e) => `(diagnostic failed: ${e})`);
      // eslint-disable-next-line no-console
      console.error(`\n=== scooter-apply-module did not reach 'done' (status='${status}') ===\nerror: ${err}\n--- log tail ---\n${log}\n--- store diagnostic ---\n${store}\n=== end ===\n`);
    }
    expect(status, `env-switch status was '${status}' (empty/building/switching = the converge never completed)`).toBe("done");
  }, 320_000);

  it("the seeded lazy tool lands on PATH after the converge", async () => {
    // The injected-tool stub resolves path:${SCOOTER_MOUNT}#${TOOL} from the mounted
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
