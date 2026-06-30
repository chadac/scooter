/**
 * Tier 2 — the agent-self-modify LIVE SWITCH works in a real container.
 *
 * This is the validation the nixosTest can't do: in a VM, switch-to-configuration
 * stops the test framework's backdoor.service (the control channel) and the test
 * hangs. A real pod has no backdoor, so the switch behaves as in prod. We drive
 * the same path moduleManager does — upload a module to a writable path, run
 * `scooter-apply-module --module <path>` — and assert:
 *   - a GOOD module applies live (its tool appears in a later exec, no restart),
 *   - the new system generation is registered,
 *   - a BAD module fails the apply (non-zero) and the good tool still works
 *     (build gate / auto-rollback kept the environment intact).
 *
 * Uses the overlay-store image (the in-pod nix build needs the writable upper).
 * Gated: RUN_CLUSTER_TESTS=1. Image: OVERLAY_IMAGE.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;
const NS = "agent-sandbox-selfmod-test";
const IMAGE = process.env.OVERLAY_IMAGE ?? "agent-sandbox-os-overlay:latest";
const POD = "self-modify-boot";
const SELECTOR = "app=self-modify-boot";
const UPPER = "/nix/.scooter-rw";

// A GOOD module: declares a lazy tool `selfmod-demo` -> hello (resolves on first
// call; light, no eager build at switch time).
const GOOD_MODULE = `{ ... }: {
  programs.lazyTools.tools.selfmod-demo = { package = "hello"; bin = "hello"; };
}`;
// A BAD module: references an undefined variable -> eval/build fails (the gate).
const BAD_MODULE = `{ ... }: { environment.systemPackages = [ thisIsNotDefined ]; }`;

async function waitForUnit(cluster: Cluster, unit: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await cluster.exec(SELECTOR, ["systemctl", "is-active", unit], NS);
    const s = r.stdout.trim();
    if (s !== "activating" && s !== "") return s;
    if (Date.now() > deadline) return s;
    await new Promise((res) => setTimeout(res, 2000));
  }
}

maybe("agent self-modify live switch works in a real container", () => {
  let cluster: Cluster;

  beforeAll(async () => {
    cluster = await withCluster({ installController: false, namespace: NS });
    await cluster
      .apply({ apiVersion: "v1", kind: "Namespace", metadata: { name: NS } })
      .catch(() => {});

    await cluster.apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: POD, namespace: NS, labels: { app: "self-modify-boot" } },
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

  it("reaches Running + the overlay store is up", async () => {
    await cluster.waitFor<{ status: { phase: string } }>(
      "Pod",
      POD,
      (p) => p.status?.phase === "Running",
      180_000,
      NS,
    );
    expect(await waitForUnit(cluster, "overlay-store-setup.service", 120_000)).toBe("active");
  });

  it("applies a GOOD module live — the tool appears, a generation is registered", async () => {
    const prof = "/nix/var/nix/profiles";
    const genBefore = (await cluster.exec(SELECTOR, ["readlink", "-f", `${prof}/system`], NS)).stdout.trim();

    // BEFORE: the tool isn't present.
    const before = await cluster.exec(SELECTOR, ["sh", "-c", "command -v selfmod-demo; echo $?"], NS);
    expect(before.stdout.trim().split("\n").pop()).not.toBe("0");

    // Upload the module + apply it (the moduleManager path, exercised directly).
    // The FIRST apply is a COLD build — it realises a whole new system toplevel
    // (substituting from cache) + switches, which is genuinely slow in k3d
    // (several minutes). Generous timeout.
    await cluster.exec(SELECTOR, ["sh", "-c", `mkdir -p /run/sm && cat > /run/sm/module.nix <<'EOF'\n${GOOD_MODULE}\nEOF`], NS);
    const apply = await cluster.exec(
      SELECTOR,
      ["scooter-apply-module", "--module", "/run/sm/module.nix"],
      NS,
    );
    expect(apply.exitCode).toBe(0);

    // A new generation was registered, the running system advanced to it, and the
    // lazy tool now runs (first call resolves hello). PID 1 survived (systemd).
    const genAfter = (await cluster.exec(SELECTOR, ["readlink", "-f", `${prof}/system`], NS)).stdout.trim();
    expect(genAfter).not.toBe(genBefore);
    // The switch made the new generation current (so the tool is on the new PATH).
    const current = (await cluster.exec(SELECTOR, ["readlink", "-f", "/run/current-system"], NS)).stdout.trim();
    expect(current).toBe(genAfter);
    // Run the tool via the NEW system's sw/bin (a long-lived exec shell may still
    // hold the pre-switch PATH; the new generation's bin is authoritative).
    const run = await cluster.exec(SELECTOR, ["sh", "-lc", `${current}/sw/bin/selfmod-demo`], NS);
    expect(run.stdout).toContain("Hello, world!");
    expect((await cluster.exec(SELECTOR, ["ps", "-o", "comm=", "-p", "1"], NS)).stdout.trim()).toBe("systemd");
  }, 900_000);

  it("a BAD module fails the apply and leaves the good environment intact", async () => {
    await cluster.exec(SELECTOR, ["sh", "-c", `cat > /run/sm/bad.nix <<'EOF'\n${BAD_MODULE}\nEOF`], NS);
    const apply = await cluster.exec(SELECTOR, ["scooter-apply-module", "--module", "/run/sm/bad.nix"], NS);
    expect(apply.exitCode).not.toBe(0); // build gate: never switched

    // The previously-applied good tool still works (the environment wasn't broken).
    const current = (await cluster.exec(SELECTOR, ["readlink", "-f", "/run/current-system"], NS)).stdout.trim();
    const run = await cluster.exec(SELECTOR, ["sh", "-lc", `${current}/sw/bin/selfmod-demo`], NS);
    expect(run.stdout).toContain("Hello, world!");
  }, 300_000);
});
