/**
 * Query the platform's `agent_host` Postgres from a Tier-2 cluster spec.
 *
 * Cluster specs assert on what is DURABLE, and the durable thing is a row. The HTTP API can
 * only report what a pod currently believes: a conversation can read as deleted over HTTP
 * while its `conversation_events` rows are still there (exactly the day-one bug PR #723
 * fixes), so a test that asks the API is blind to the invariant it means to pin.
 *
 * Extracted from test/cluster/event-backfill.spec.ts, which carries the same helper inline.
 * That spec is deliberately left alone — this is a second caller, not a refactor of the
 * first — so a regression here cannot break the backfill coverage.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const PSQL_IMAGE = "postgres:16-alpine";

/** A raw kubectl call. Throws with stderr on failure. */
export async function kubectl(args: string[]): Promise<string> {
  const { stdout } = await execFileP("kubectl", args, { maxBuffer: 16 << 20 });
  return stdout;
}

/** The agent_host Postgres password, from the platform's own Secret — so a query runs as the
 *  same role agent-host writes as, and a permissions regression is visible rather than
 *  worked around. */
async function agentHostPassword(ns: string): Promise<string> {
  const b64 = (
    await kubectl(["get", "secret", "agent-pg-agent-host", "-n", ns, "-o", "jsonpath={.data.password}"])
  ).trim();
  return Buffer.from(b64, "base64").toString("utf8");
}

let podSeq = 0;

/**
 * A psql runner bound to the platform's agent_host database.
 *
 * SINGLE-VALUE QUERIES ONLY, and that is a correctness requirement rather than a style
 * preference: `kubectl run --rm -i` intermittently hands back the container's stdout TWICE
 * (seen in CI as `expected '3\n3' to be '3'`), so this returns the LAST non-empty line. A
 * multi-row query would silently lose every row but the last. Aggregate instead —
 * `count(*)`, `max(seq)`, `string_agg(...)` — and the duplicate capture collapses harmlessly.
 */
export async function psqlForAgentHost(ns: string): Promise<(query: string) => Promise<string>> {
  const pw = await agentHostPassword(ns);
  return async (query: string): Promise<string> => {
    podSeq += 1;
    const name = `pgq-${Date.now().toString(36)}-${podSeq}`;
    const args = [
      "run", name, "-n", ns, "--rm", "-i", "--restart=Never", "--image", PSQL_IMAGE,
      "--env", `PGPASSWORD=${pw}`,
      "--command", "--",
      "psql", "-h", "agent-shared-db", "-U", "agent_host", "-d", "agent_host", "-tAc", query,
    ];
    let out: string;
    try {
      out = await kubectl(args);
    } catch (e) {
      // kubectl exits non-zero when the container does, even though stdout was captured —
      // prefer the capture, and only rethrow when there is genuinely nothing to read.
      const err = e as { stdout?: string };
      if (!err.stdout) throw e;
      out = err.stdout;
    }
    const lines = out
      .replace(/pod "[^"]+" deleted.*$/s, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return lines.length > 0 ? lines[lines.length - 1] : "";
  };
}
