/**
 * Contract — a CONTRIB reaches the sandbox pod through the manifest-overlay seam the
 * provisioner ALREADY has, and the provisioner knows no integration by name.
 *
 * This replaced a hardcoded `awsAccountsConfigMap` option that spliced aws's account
 * registry into three places here (a mount, a volume, an env var). Those three splices
 * are gone: modules/platform.nix renders the parts as an overlay, so what needs
 * guarding is that the overlay shape it emits ACTUALLY lands in all three places (a
 * dropped one leaves the pod Pending on a volume it can't satisfy, or mounted with
 * nothing telling the sandbox where), and that a deployment's own patch still wins a
 * name collision. Why: PR #640.
 */

import { describe, it, expect } from "vitest";

import { sandboxManifest } from "../../src/session/k8sProvisioner.js";
import { deepMerge } from "../../src/session/sandboxOverlay.js";

interface Manifest {
  spec: {
    podTemplate: {
      spec: {
        volumes?: Array<{ name: string; configMap?: { name: string } }>;
        containers: Array<{
          volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
          env?: Array<{ name: string; value: string }>;
        }>;
      };
    };
  };
}

/** aws's real parts in the overlay shape modules/platform.nix renders from
 *  `agentSandbox.sandboxPod.*` — the motivating case, copied from that render. */
const AWS_OVERLAY = {
  spec: {
    podTemplate: {
      spec: {
        containers: [
          {
            name: "sandbox",
            env: [{ name: "AWS_ACCOUNTS_FILE", value: "/etc/agent-sandbox/aws/accounts.json" }],
            volumeMounts: [
              { name: "aws-accounts", mountPath: "/etc/agent-sandbox/aws", readOnly: true },
            ],
          },
        ],
        volumes: [{ name: "aws-accounts", configMap: { name: "agent-broker-aws-accounts" } }],
      },
    },
  },
};

const render = (deploy: Record<string, unknown> = {}) =>
  sandboxManifest("abc", "conv-abc", "sandbox-abc", "img:latest", "ns", "aud", "10Gi", true, {
    extraEnv: [{ name: "CONVERSATION_ID", value: "conv-abc" }],
    ...deploy,
  }) as Manifest;

const ctr = (m: Manifest) => m.spec.podTemplate.spec.containers[0];
const named = (xs: Array<{ name: string }> | undefined, n: string) =>
  (xs ?? []).filter((x) => x.name === n);

describe("sandbox pod: contributed parts", () => {
  it("lands a contrib's volume, mount and env in the pod", () => {
    const m = render({ overlay: AWS_OVERLAY });
    expect(named(m.spec.podTemplate.spec.volumes, "aws-accounts")).toHaveLength(1);
    expect(named(ctr(m).volumeMounts, "aws-accounts")[0]?.mountPath).toBe("/etc/agent-sandbox/aws");
    expect(named(ctr(m).env, "AWS_ACCOUNTS_FILE")[0]?.value).toBe(
      "/etc/agent-sandbox/aws/accounts.json",
    );
  });

  it("adds nothing when no contrib contributes", () => {
    const m = render();
    expect(named(m.spec.podTemplate.spec.volumes, "aws-accounts")).toHaveLength(0);
    expect(named(ctr(m).env, "AWS_ACCOUNTS_FILE")).toHaveLength(0);
  });

  it("keeps the platform's own wiring intact alongside a contrib's", () => {
    const m = render({ overlay: AWS_OVERLAY });
    // The seam appends; it must not displace the identity/auth wiring the
    // conversation depends on.
    expect(named(m.spec.podTemplate.spec.volumes, "broker-token")).toHaveLength(1);
    expect(named(ctr(m).volumeMounts, "workspace")).toHaveLength(1);
    expect(named(ctr(m).env, "CONVERSATION_ID")[0]?.value).toBe("conv-abc");
  });

  it("lets a deployment override a contrib's env BY NAME, exactly once", () => {
    // What loadManifestOverlay composes: contrib parts, consumer patch on top.
    const consumer = {
      spec: {
        podTemplate: {
          spec: {
            containers: [
              { name: "sandbox", env: [{ name: "AWS_ACCOUNTS_FILE", value: "/mine.json" }] },
            ],
          },
        },
      },
    };
    const m = render({ overlay: deepMerge(AWS_OVERLAY, consumer) as Record<string, unknown> });
    const hits = named(ctr(m).env, "AWS_ACCOUNTS_FILE");
    // Strategic merge by name, so the deployment wins in place — NOT two entries
    // relying on k8s keeping the last duplicate.
    expect(hits).toHaveLength(1);
    expect(hits[0]?.value).toBe("/mine.json");
  });
});
