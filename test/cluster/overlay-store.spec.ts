/**
 * Tier 2 — the read-only-base + writable-upper local-overlay Nix store works in a
 * REAL container (the production topology the nixosTest VM can't reproduce).
 *
 * In the VM the lower is the framework's own /nix/store overlay and a boot-time
 * register-nix-paths builds the DB; the nixosTest reconciles those VM-isms. HERE
 * the image is the OS image with `programs.overlayStore.enable = true`, so the
 * lower is the BAKED image store (a real, populated, read-only Nix store) and
 * there is no register-nix-paths — exactly how it runs in prod. We prove:
 *   - the pod boots (systemd PID 1) with the overlay store set up,
 *   - /nix/store is OUR overlay (writable upper mounted),
 *   - a real `nix build` lands in the UPPER and the baked LOWER stays untouched,
 *   - nix reports the local-overlay store.
 *
 * The upper is a disk-backed emptyDir (NOT tmpfs) — mirrors prod (emptyDir/PVC);
 * a RAM upper would charge every runtime-built closure to pod memory.
 *
 * Gated: RUN_CLUSTER_TESTS=1. Image: OVERLAY_IMAGE (built + imported by
 * cluster-up as .#sandbox-os-overlay-image). Skipped if unavailable.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;
// Dedicated namespace (not the shared agent-sandbox-test) so this spec never
// races/​conflicts with the other image-boot spec when CI runs them in the same
// cluster.
const NS = "agent-sandbox-overlay-test";
const IMAGE = process.env.OVERLAY_IMAGE ?? "agent-sandbox-os-overlay:latest";
const POD = "overlay-store-boot";
const SELECTOR = "app=overlay-store-boot";

// Must match programs.overlayStore.{lowerPath,upperPath} defaults.
const LOWER = "/nix/.scooter-ro";
const UPPER = "/nix/.scooter-rw";

maybe("local-overlay Nix store works in a real container (prod topology)", () => {
  let cluster: Cluster;

  beforeAll(async () => {
    cluster = await withCluster({ installController: false, namespace: NS });

    // Self-sufficient: ensure the namespace exists (the controller/platform isn't
    // installed for this image-boot test, so nothing else creates it). Tolerate
    // already-exists (a prior run / the broader suite may have created it).
    await cluster
      .apply({ apiVersion: "v1", kind: "Namespace", metadata: { name: NS } })
      .catch(() => {});

    await cluster.apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: POD, namespace: NS, labels: { app: "overlay-store-boot" } },
      spec: {
        containers: [
          {
            name: "sandbox", // cluster.exec() targets the "sandbox" container
            image: IMAGE,
            imagePullPolicy: "Never",
            // systemd PID 1 needs a writable cgroup + CAP_SYS_ADMIN; the overlay
            // setup also needs mount privileges. Privileged on dev (as elsewhere).
            securityContext: { privileged: true },
            volumeMounts: [
              { name: "run", mountPath: "/run" },
              { name: "tmp", mountPath: "/tmp" },
              // The writable UPPER. DISK-backed emptyDir (no medium: Memory) — the
              // deployer-mounted volume stand-in (emptyDir/PVC in prod).
              { name: "overlay-upper", mountPath: UPPER },
            ],
          },
        ],
        volumes: [
          { name: "run", emptyDir: { medium: "Memory" } },
          { name: "tmp", emptyDir: { medium: "Memory" } },
          { name: "overlay-upper", emptyDir: {} }, // disk-backed, NOT tmpfs
        ],
      },
    });
  }, 60_000);

  afterAll(async () => {
    await cluster?.deletePod(POD, NS).catch(() => {});
  });

  it("reaches Running (systemd PID 1 came up with the overlay store)", async () => {
    const pod = await cluster.waitFor<{ status: { phase: string } }>(
      "Pod",
      POD,
      (p) => p.status?.phase === "Running",
      180_000,
      NS,
    );
    expect(pod.status.phase).toBe("Running");
  });

  it("PID 1 is systemd and overlay-store-setup succeeded", async () => {
    const pid1 = await cluster.exec(SELECTOR, ["ps", "-o", "comm=", "-p", "1"], NS);
    expect(pid1.stdout.trim()).toBe("systemd");

    // overlay-store-setup is an early-boot oneshot; the pod can report Running
    // while it's still `activating` (esp. under concurrent pod boots). Poll until
    // it settles to `active` (fail fast on `failed`). All later tests depend on
    // this — once it's active, the overlay is up for the rest of the file.
    const state = await waitForUnit("overlay-store-setup.service", 120_000);
    expect(state).toBe("active");
  });

  // Re-exec `systemctl is-active` until the unit settles out of `activating`,
  // returning its terminal state. More robust than `is-active --wait` (which can
  // mis-report under load).
  async function waitForUnit(unit: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await cluster.exec(SELECTOR, ["systemctl", "is-active", unit], NS);
      const s = r.stdout.trim();
      if (s !== "activating" && s !== "" ) return s; // active | failed | inactive
      if (Date.now() > deadline) return s;
      await new Promise((res) => setTimeout(res, 2000));
    }
  }

  it("/nix/store is OUR overlay (writable upper mounted)", async () => {
    const mounts = await cluster.exec(SELECTOR, ["cat", "/proc/self/mountinfo"], NS);
    expect(mounts.stdout).toContain(`upperdir=${UPPER}/upper`);
  });

  it("the baked LOWER is read-only", async () => {
    // touch must FAIL on the read-only lower.
    const r = await cluster.exec(SELECTOR, ["sh", "-c", `touch ${LOWER}/canary 2>/dev/null; echo $?`], NS);
    expect(r.stdout.trim()).not.toBe("0");
  });

  it("a real `nix build` lands in the UPPER, not the baked lower", async () => {
    // Build a trivial derivation through the overlay store. Pure builder (/bin/sh
    // in the closure) so it needs no fetch — offline, deterministic.
    const expr =
      'derivation { name = "overlay-canary"; system = builtins.currentSystem; ' +
      'builder = "/bin/sh"; args = [ "-c" "echo built-in-upper > $out" ]; }';
    const build = await cluster.exec(
      SELECTOR,
      ["nix", "build", "--no-link", "--print-out-paths", "--impure", "--expr", expr],
      NS,
    );
    expect(build.exitCode).toBe(0);
    const outPath = build.stdout.trim().split("\n").pop()!.trim();
    expect(outPath).toMatch(/^\/nix\/store\/.+-overlay-canary$/);
    const base = outPath.split("/").pop()!;

    // The new path's files live in the UPPER...
    const inUpper = await cluster.exec(SELECTOR, ["sh", "-c", `test -e ${UPPER}/upper/${base}; echo $?`], NS);
    expect(inUpper.stdout.trim()).toBe("0");

    // ...and NOT in the read-only baked lower.
    const inLower = await cluster.exec(SELECTOR, ["sh", "-c", `test -e ${LOWER}/${base}; echo $?`], NS);
    expect(inLower.stdout.trim()).not.toBe("0");

    // ...and it's readable through the merged /nix/store view.
    const content = await cluster.exec(SELECTOR, ["cat", outPath], NS);
    expect(content.stdout.trim()).toBe("built-in-upper");
  });

  it("nix reports the local-overlay store", async () => {
    const store = await cluster.exec(SELECTOR, ["nix", "config", "show", "store"], NS);
    expect(store.stdout).toContain("local-overlay");
  });
});
