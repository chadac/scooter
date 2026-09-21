/**
 * Cluster-test sandbox fixture — create/suspend/resume/destroy a real Sandbox.
 *
 * The cluster specs need a live sandbox pod to exec into. They used to build one with
 * the agent-host's own `createK8sProvisioner`, which no longer exists: the BROKER is
 * the single provisioning entrypoint and it renders the manifest in Python.
 *
 * So this does NOT re-implement the manifest. It shells out to `scooter-sandbox-manifest`
 * (services/broker/broker/sandbox/cli.py) for the exact manifest the broker provisions
 * with, then applies it. One renderer, no lockstep comment to forget. A hand-rolled
 * manifest would not even boot the image — the NixOS systemd sandbox needs the
 * cgroup-delegating runtimeClass, CAP_SYS_ADMIN and the tmpfs /run + /tmp.
 *
 * Manifest CONTENT is asserted in services/broker/tests/test_sandbox_manifest.py (unit,
 * no cluster). What these specs add is that a real cluster reconciles it.
 */

import { execFileSync } from "node:child_process";

import { CoreV1Api, CustomObjectsApi, KubeConfig } from "@kubernetes/client-node";

import type { SandboxRef } from "../../services/agent-host/src/types.js";

const GROUP = "agents.x-k8s.io";
const VERSION = "v1beta1";
const PLURAL = "sandboxes";

export interface SandboxFixtureOptions {
  namespace: string;
  image: string;
  /** e.g. "crun". Omit for the cluster default runtime. */
  runtimeClass?: string;
  /** Side-loaded local clusters have no registry: "Never"/"IfNotPresent". */
  pullPolicy?: "Always" | "IfNotPresent" | "Never";
}

/** Build + cache the broker's manifest CLI once per process (a nix build, ~seconds
 *  warm). SCOOTER_SANDBOX_MANIFEST_BIN short-circuits it when one is already on PATH. */
let cliPath: string | undefined;
function manifestCli(): string {
  if (process.env.SCOOTER_SANDBOX_MANIFEST_BIN) return process.env.SCOOTER_SANDBOX_MANIFEST_BIN;
  if (cliPath) return cliPath;
  const out = execFileSync("nix", ["build", ".#broker", "--no-link", "--print-out-paths"], {
    encoding: "utf8",
  }).trim().split("\n")[0];
  cliPath = `${out}/bin/scooter-sandbox-manifest`;
  return cliPath;
}

export function createSandboxFixture(opts: SandboxFixtureOptions) {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const core = kc.makeApiClient(CoreV1Api);
  const custom = kc.makeApiClient(CustomObjectsApi);
  const ns = opts.namespace;

  const setMode = async (name: string, operatingMode: "Running" | "Suspended") => {
    await custom.patchNamespacedCustomObject({
      group: GROUP, version: VERSION, namespace: ns, plural: PLURAL, name,
      body: { spec: { operatingMode } },
    });
  };

  return {
    async create(id: string, threadId?: string): Promise<SandboxRef> {
      const args = [
        "--conv", id, "--image", opts.image, "--namespace", ns,
        "--pull-policy", opts.pullPolicy ?? "Never",
        ...(opts.runtimeClass ? ["--runtime-class", opts.runtimeClass] : []),
        ...(threadId ? ["--thread-id", threadId] : []),
      ];
      const manifest = JSON.parse(execFileSync(manifestCli(), args, { encoding: "utf8" }));

      // 409s are the goal on a re-run, not an error (mirrors the broker's create).
      await core
        .createNamespacedServiceAccount({
          namespace: ns,
          body: { metadata: { name: `sandbox-${id}`, namespace: ns } },
        })
        .catch((e: { code?: number }) => {
          if (e?.code !== 409) throw e;
        });
      await custom
        .createNamespacedCustomObject({ group: GROUP, version: VERSION, namespace: ns, plural: PLURAL, body: manifest })
        .catch((e: { code?: number }) => {
          if (e?.code !== 409) throw e;
        });
      return { name: `conv-${id}`, namespace: ns };
    },

    async suspend(ref: SandboxRef): Promise<void> {
      await setMode(ref.name, "Suspended");
    },

    async resume(ref: SandboxRef): Promise<SandboxRef> {
      await setMode(ref.name, "Running");
      return ref;
    },

    async destroy(ref: SandboxRef): Promise<void> {
      const gone = (e: { code?: number }) => {
        if (e?.code !== 404) throw e;
      };
      await custom
        .deleteNamespacedCustomObject({ group: GROUP, version: VERSION, namespace: ns, plural: PLURAL, name: ref.name })
        .catch(gone);
      await core
        .deleteNamespacedServiceAccount({ name: ref.name.replace(/^conv-/, "sandbox-"), namespace: ns })
        .catch(gone);
    },
  };
}
