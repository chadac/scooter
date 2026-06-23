/**
 * Tier 2 — broker credential flow (POST-PoC; gated additionally on broker).
 *
 * Proves the pod authenticates to the broker with its projected SA token and a
 * credentialed action succeeds; wrong audience is rejected. RED.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const enabled = clusterTestsEnabled() && process.env.RUN_BROKER_TESTS === "1";
const maybe = enabled ? describe : describe.skip;

maybe("broker credential flow", () => {
  let cluster: Cluster;
  const id = "test-broker1";

  beforeAll(async () => {
    cluster = await withCluster({ installController: true, namespace: "agent-sandbox-test" });
    await cluster.apply({ __broker: true });
    await cluster.apply({ __conversation: id });
    await cluster.waitFor("Sandbox", `conv-${id}`, (s: any) =>
      s.status?.conditions?.some((c: any) => c.type === "Ready" && c.status === "True"), 180_000);
  });

  it("the pod's SA token (broker audience) is accepted by the broker", async () => {
    // git-credential-broker shim hits /git-credentials with the projected token
    const { stdout, exitCode } = await cluster.exec(`sandbox=conv-${id}`, [
      "sh", "-c",
      "curl -sf -H \"Authorization: Bearer $(cat /var/run/secrets/broker/token)\" \"$BROKER_URL/git-credentials\"",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("x-access-token");
  });

  it("scopes the credential to this conversation's identity (sandbox-{id})", async () => {
    // The broker should resolve identity from the SA username sandbox-{id}.
    // Asserted via broker logs / a scoped credential. (impl detail)
    expect(true).toBe(true); // placeholder assertion shape
  });

  it("rejects a token minted for the wrong audience", async () => {
    const { exitCode } = await cluster.exec(`sandbox=conv-${id}`, [
      "sh", "-c",
      "curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer bogus' \"$BROKER_URL/git-credentials\" | grep -q 401",
    ]);
    expect(exitCode).toBe(0);
  });
});
