/**
 * Tier 2 — broker credential flow (IRSA / per-conversation identity).
 *
 * Proves the full credential path on a real cluster: a per-conversation Sandbox
 * pod, with its projected broker-audience SA token, calls the broker via the
 * in-pod `agent-broker` shim; the broker validates the token with K8s
 * TokenReview and confirms the caller's identity is sandbox-{conversationId}.
 *
 * This is the cluster half of the UI-driven credential test — the same path a
 * `!agent-broker test/whoami` message exercises end to end.
 *
 * Gated: RUN_CLUSTER_TESTS=1 RUN_BROKER_TESTS=1 (needs the broker deployed with
 * its `test` provider enabled). Provisioner sets BROKER_URL + projects the
 * broker token (mirrors modules/conversation.nix).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";
import { createK8sProvisioner } from "../../services/agent-host/src/session/k8sProvisioner.js";
import type { SandboxProvisioner } from "../../services/agent-host/src/session/manager.js";
import type { SandboxRef } from "../../services/agent-host/src/types.js";

const enabled = clusterTestsEnabled() && process.env.RUN_BROKER_TESTS === "1";
const maybe = enabled ? describe : describe.skip;

const NS = process.env.BROKER_NS ?? "agent-sandbox";
const IMAGE = process.env.SANDBOX_IMAGE ?? "agent-sandbox-nix:latest";
const SELECTOR = (id: string) => `agents.x-k8s.io/sandbox-name=conv-${id}`;
const ready = (s: { status?: { conditions?: Array<{ type: string; status: string }> } }) =>
  !!s.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True");

maybe("broker credential flow (IRSA)", () => {
  let cluster: Cluster;
  let provisioner: SandboxProvisioner;
  let ref: SandboxRef;
  const id = "brkr01";

  beforeAll(async () => {
    cluster = await withCluster({ namespace: NS });
    provisioner = createK8sProvisioner({ namespace: NS, sandboxImage: IMAGE });
    ref = await provisioner.create(id);
    await cluster.waitFor("Sandbox", `conv-${id}`, ready, 180_000, NS);
  }, 240_000);

  afterAll(async () => {
    await provisioner?.destroy(ref).catch(() => {});
  });

  it("the broker authenticates the pod as its per-conversation identity", async () => {
    // `agent-broker test/whoami` reads the projected SA token and hits the
    // broker, which does a real TokenReview.
    const { stdout, exitCode } = await cluster.exec(
      SELECTOR(id),
      ["agent-broker", "test/whoami"],
      NS,
    );
    expect(exitCode).toBe(0);
    const identity = JSON.parse(stdout);
    expect(identity.conversation_id).toBe(id);
    expect(identity.namespace).toBe(NS);
    expect(identity.service_account).toBe(`system:serviceaccount:${NS}:sandbox-${id}`);
  });

  it("rejects a request with no/garbage token", async () => {
    const { stdout } = await cluster.exec(
      SELECTOR(id),
      ["sh", "-c", "curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer bogus' \"$BROKER_URL/test/whoami\""],
      NS,
    );
    expect(stdout.trim()).toBe("401");
  });

  it("git-credential-broker vends a credential for an authenticated pod", async () => {
    // Invoke the helper exactly as git would: `get` with the credential
    // description on stdin. It reads the projected SA token, maps the host to
    // the broker `test` provider (GIT_BROKER_HOST_MAP) and returns git creds.
    const { stdout, exitCode } = await cluster.exec(
      SELECTOR(id),
      [
        "sh",
        "-c",
        "printf 'protocol=https\\nhost=test-git.local\\n\\n' | git-credential-broker get",
      ],
      NS,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("username=test-user");
    expect(stdout).toContain("password=test-broker-token");
  });

  it("git itself uses the broker helper (credential.helper broker)", async () => {
    // `git credential fill` runs the configured helper chain. The entrypoint set
    // credential.helper=broker, so this proves git -> git-credential-broker ->
    // broker end to end (the same path `git clone https://test-git.local/...`
    // takes). HOME must match the entrypoint's so the global config applies.
    const { stdout, exitCode } = await cluster.exec(
      SELECTOR(id),
      [
        "sh",
        "-c",
        "printf 'protocol=https\\nhost=test-git.local\\n\\n' | git credential fill",
      ],
      NS,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("username=test-user");
    expect(stdout).toContain("password=test-broker-token");
  });
});
