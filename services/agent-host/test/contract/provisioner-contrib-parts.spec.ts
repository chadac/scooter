/**
 * Contract — a CONTRIB reaches the sandbox pod through SANDBOX_CONTRIB_JSON, and the
 * provisioner knows no integration by name.
 *
 * This replaced a hardcoded `awsAccountsConfigMap` option that spliced aws's account
 * registry into three places here (a mount, a volume, an env var). The parts are opaque
 * now, so what needs guarding is different: that they ACTUALLY reach all three places
 * (a dropped one leaves the pod Pending on a volume it can't satisfy, or mounted with
 * nothing telling the sandbox where), that a malformed payload fails loudly rather
 * than silently provisioning without them, and that a deployment's own env still wins
 * over a contrib's. Why: PR #640.
 */

import { describe, it, expect } from "vitest";

import { sandboxManifest, parseContribParts } from "../../src/session/k8sProvisioner.js";

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

/** aws's real parts, as modules/sandbox-pod.nix renders them — the motivating case. */
const AWS_PARTS = {
  extraEnv: [{ name: "AWS_ACCOUNTS_FILE", value: "/etc/agent-sandbox/aws/accounts.json" }],
  extraVolumes: [{ name: "aws-accounts", configMap: { name: "agent-broker-aws-accounts" } }],
  extraVolumeMounts: [
    { name: "aws-accounts", mountPath: "/etc/agent-sandbox/aws", readOnly: true },
  ],
};

const render = (deploy: Record<string, unknown> = {}) =>
  sandboxManifest("abc", "conv-abc", "sandbox-abc", "img:latest", "ns", "aud", "10Gi", true, {
    extraEnv: [{ name: "CONVERSATION_ID", value: "conv-abc" }],
    ...deploy,
  }) as Manifest;

const ctr = (m: Manifest) => m.spec.podTemplate.spec.containers[0];

describe("sandbox pod: contributed parts", () => {
  it("splices a contrib's volume, mount and env into the pod", () => {
    const m = render({ contrib: AWS_PARTS });
    expect(m.spec.podTemplate.spec.volumes).toContainEqual(AWS_PARTS.extraVolumes[0]);
    expect(ctr(m).volumeMounts).toContainEqual(AWS_PARTS.extraVolumeMounts[0]);
    expect(ctr(m).env).toContainEqual(AWS_PARTS.extraEnv[0]);
  });

  it("adds nothing when no contrib contributes", () => {
    const m = render();
    const names = (m.spec.podTemplate.spec.volumes ?? []).map((v) => v.name);
    expect(names).not.toContain("aws-accounts");
    expect((ctr(m).env ?? []).map((e) => e.name)).not.toContain("AWS_ACCOUNTS_FILE");
  });

  it("keeps the platform's own wiring intact alongside a contrib's", () => {
    const m = render({ contrib: AWS_PARTS });
    const mounts = (ctr(m).volumeMounts ?? []).map((v) => v.name);
    expect(mounts).toEqual(expect.arrayContaining(["workspace", "broker-token"]));
    expect((ctr(m).env ?? []).map((e) => e.name)).toEqual(
      expect.arrayContaining(["BROKER_URL", "BROKER_TOKEN_PATH", "HOME", "CONVERSATION_ID"]),
    );
  });

  it("puts contrib env BEFORE the deployment's, so a deployment override wins", () => {
    // k8s keeps the LAST value of a duplicated env name, so order IS the precedence.
    const m = render({
      contrib: { extraEnv: [{ name: "SHARED", value: "from-contrib" }] },
      extraEnv: [{ name: "SHARED", value: "from-deployment" }],
    });
    const idx = (v: string) => (ctr(m).env ?? []).findIndex((e) => e.value === v);
    expect(idx("from-contrib")).toBeGreaterThanOrEqual(0);
    expect(idx("from-deployment")).toBeGreaterThan(idx("from-contrib"));
  });
});

describe("parseContribParts", () => {
  it("returns undefined when unset or empty", () => {
    expect(parseContribParts(undefined)).toBeUndefined();
    expect(parseContribParts("")).toBeUndefined();
    expect(parseContribParts("   ")).toBeUndefined();
  });

  it("round-trips what modules/platform.nix renders", () => {
    expect(parseContribParts(JSON.stringify(AWS_PARTS))).toEqual(AWS_PARTS);
  });

  it("throws on malformed input rather than provisioning without the parts", () => {
    // Silently dropping these is the bad failure: every sandbox comes up missing the
    // integration, and the agent reads that as the feature being broken.
    expect(() => parseContribParts("{not json")).toThrow(/not valid JSON/);
    expect(() => parseContribParts("[]")).toThrow(/must be a JSON object/);
    expect(() => parseContribParts('{"extraEnv":"AWS_ACCOUNTS_FILE=..."}')).toThrow(
      /extraEnv must be an array/,
    );
  });
});
