/**
 * Tier 2 — the one-shot mirror→Postgres event backfill RENDERS and RUNS in a real cluster.
 *
 * The contract tests (services/agent-host/test/contract/eventBackfill.spec.ts) cover the
 * verify logic against a fake db. What they CANNOT cover is the seam this migration actually
 * ships across: a rendered Kubernetes Job, built from modules/event-backfill.nix, that mounts
 * the real history-mirror PVC, connects to the real agent_host Postgres with the platform's own
 * credentials, loads the event logs, and exits non-zero if anything fails to verify. A broken
 * image ref, wrong DB env, a missing volume, or a script that never made it into dist/ are all
 * invisible to Tier 1 and are exactly what destroys history during a customer's cutover.
 *
 * So this test:
 *   1. builds the ACTUAL Job manifest (`nix build .#platform-manifests-k3d-backfill`) and
 *      asserts its shape — image, command, DB wiring, read-only mirror volume, service account;
 *   2. seeds the mirror PVC with real conversation event logs, runs that Job, and proves the
 *      rows land in Postgres (happy path);
 *   3. seeds a CORRUPT conversation and proves the Job FAILS rather than reporting success —
 *      the "127 of 128 loaded, exit 0" failure the whole design exists to prevent.
 *
 * Gated on RUN_CLUSTER_TESTS=1. Runs against the deployed platform-manifests-k3d (namespace
 * agent-sandbox): Postgres up, agent-host image in the k3d registry, agent-host-history PVC
 * provisioned. Nothing mounts that PVC in the running platform (post-cutover the mirror is
 * legacy), so seeding it here is safe.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadAllYaml, type V1Job, type V1Pod } from "@kubernetes/client-node";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;

const NS = "agent-sandbox";
const MIRROR_PVC = "agent-host-history";
const SEEDER = "backfill-seeder";
const SEEDER_IMAGE = "busybox:1.36";
const PSQL_IMAGE = "postgres:16-alpine";

const execFileP = promisify(execFile);

/** A raw kubectl call. Throws with stderr on failure (except where we tolerate it). */
async function kubectl(args: string[]): Promise<string> {
  const { stdout } = await execFileP("kubectl", args, { maxBuffer: 16 << 20 });
  return stdout;
}

/** kubectl run a throwaway pod that runs one command and is removed (`--rm`). kubectl exits
 *  non-zero when the container does, even though we captured stdout — so prefer stdout. */
let podSeq = 0;
async function runOnce(image: string, env: Record<string, string>, argv: string[]): Promise<string> {
  podSeq += 1;
  const name = `bf-${Date.now().toString(36)}-${podSeq}`;
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
  const args = [
    "run", name, "-n", NS, "--rm", "-i", "--restart=Never", "--image", image,
    ...envArgs, "--command", "--", ...argv,
  ];
  try {
    const out = await kubectl(args);
    return out.replace(/pod "[^"]+" deleted.*$/s, "").trim();
  } catch (e) {
    const err = e as { stdout?: string };
    if (err.stdout) return err.stdout.replace(/pod "[^"]+" deleted.*$/s, "").trim();
    throw e;
  }
}

/** The agent_host Postgres password, from the platform's Secret. Used to run psql against the
 *  same database + role the backfill writes as, so the verification is end-to-end honest. */
async function agentHostPassword(): Promise<string> {
  const b64 = (await kubectl([
    "get", "secret", "agent-pg-agent-host", "-n", NS, "-o", "jsonpath={.data.password}",
  ])).trim();
  return Buffer.from(b64, "base64").toString("utf8");
}

/** Run a query as the agent_host role against the agent_host DB (tuples-only, unaligned). */
async function psql(pw: string, query: string): Promise<string> {
  return runOnce(
    PSQL_IMAGE,
    { PGPASSWORD: pw },
    ["psql", "-h", "agent-shared-db", "-U", "agent_host", "-d", "agent_host", "-tAc", query],
  );
}

/** A valid AG-UI event line. The backfill hashes each into the integrity chain; any flat
 *  JSON record works, matching the contract test's shape. */
const ev = (n: number): string =>
  JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", messageId: `m${n}`, delta: `d${n}`, ts: n });

/**
 * Seed conversation logs onto the mirror PVC under `<mirrorRoot>/<id>/events.jsonl`.
 * Uses a long-lived seeder pod (mounts the PVC RW) that we exec into; content is base64-piped
 * so JSON quoting survives the shell. Wipes the root first so each run is deterministic.
 */
async function seedMirror(mirrorRoot: string, tree: Record<string, string[]>): Promise<void> {
  const parts: string[] = [`set -e`, `rm -rf ${mirrorRoot}`];
  for (const [id, lines] of Object.entries(tree)) {
    const dir = `${mirrorRoot}/${id}`;
    parts.push(`mkdir -p ${dir}`);
    if (lines.length > 0) {
      const b64 = Buffer.from(lines.join("\n") + "\n", "utf8").toString("base64");
      // busybox base64 handles the wrapped lines from a single echo fine.
      parts.push(`echo ${b64} | base64 -d > ${dir}/events.jsonl`);
    }
  }
  await kubectl(["exec", SEEDER, "-n", NS, "-c", "seed", "--", "sh", "-c", parts.join(" && ")]);
}

/** Clone the rendered Job into a fresh, uniquely-named instance for one test run: its own name,
 *  its own mirror sub-path, and (optionally) backoffLimit 0 so a failure surfaces fast. */
function jobInstance(
  rendered: V1Job,
  name: string,
  mirrorRoot: string,
  opts: { backoffLimit?: number } = {},
): V1Job {
  const job: V1Job = JSON.parse(JSON.stringify(rendered));
  job.metadata = { name, namespace: NS, labels: job.metadata?.labels };
  const spec = job.spec!;
  if (opts.backoffLimit !== undefined) spec.backoffLimit = opts.backoffLimit;
  const container = spec.template.spec!.containers[0];
  // Only the read path is overridden — image, DB env, volume, SA stay as rendered so the run
  // exercises the real module output. mirrorRoot is /mirror + a per-test subdir for isolation.
  container.command = ["node", "dist/scripts/runEventBackfill.js", mirrorRoot];
  return job;
}

/** Wait until a Job has finished, returning its terminal status. */
async function waitJobDone(cluster: Cluster, name: string, timeoutMs = 180_000) {
  const job = await cluster.waitFor<V1Job>(
    "Job",
    name,
    (j) => (j.status?.succeeded ?? 0) >= 1 || (j.status?.failed ?? 0) >= 1,
    timeoutMs,
    NS,
  );
  return job.status ?? {};
}

maybe("event backfill Job renders and runs in a real cluster", () => {
  let cluster: Cluster;
  let renderedJob: V1Job;
  let pw: string;
  const createdJobs: string[] = [];

  beforeAll(async () => {
    cluster = await withCluster({ installController: false, namespace: NS });

    // 1) Build the ACTUAL rendered Job from the module (real k3d image ref + DB wiring).
    const built = (await execFileP(
      "nix",
      ["build", ".#platform-manifests-k3d-backfill", "--no-link", "--print-out-paths"],
      { maxBuffer: 16 << 20 },
    )).stdout.trim();
    const yaml = await execFileP("cat", [built], { maxBuffer: 32 << 20 });
    const docs = loadAllYaml(yaml.stdout) as Array<{ kind?: string; metadata?: { name?: string } }>;
    const job = docs.find((d) => d.kind === "Job" && d.metadata?.name === "agent-event-backfill");
    expect(job, "the rendered manifest must contain the agent-event-backfill Job").toBeTruthy();
    renderedJob = job as unknown as V1Job;

    pw = await agentHostPassword();

    // The event log table the backfill writes into. The platform creates it at boot; ensure it
    // (as the agent_host role, so ownership lets the Job insert) to keep this test hermetic.
    await psql(
      pw,
      `CREATE TABLE IF NOT EXISTS conversation_events (
         conversation_id text NOT NULL,
         seq bigint NOT NULL,
         event jsonb NOT NULL,
         checksum text NOT NULL,
         prev_checksum text NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (conversation_id, seq));`,
    );

    // A long-lived seeder pod mounting the mirror PVC read-write, so tests can write logs into it.
    await cluster.deletePod(SEEDER, NS).catch(() => {});
    const seeder: V1Pod = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: SEEDER, namespace: NS, labels: { app: SEEDER } },
      spec: {
        restartPolicy: "Never",
        securityContext: { fsGroup: 0 },
        containers: [
          {
            name: "seed",
            image: SEEDER_IMAGE,
            command: ["sh", "-c", "sleep 3600"],
            volumeMounts: [{ name: "mirror", mountPath: "/mirror" }],
          },
        ],
        volumes: [{ name: "mirror", persistentVolumeClaim: { claimName: MIRROR_PVC } }],
      },
    };
    await cluster.apply(seeder);
    await cluster.waitFor<V1Pod>("Pod", SEEDER, (p) => p.status?.phase === "Running", 120_000, NS);
  });

  afterAll(async () => {
    for (const name of createdJobs) {
      await kubectl(["delete", "job", name, "-n", NS, "--ignore-not-found", "--wait=false"]).catch(
        () => {},
      );
    }
    await cluster.deletePod(SEEDER, NS).catch(() => {});
  });

  it("renders a Job with the agent-host image, DB wiring, and a read-only mirror mount", () => {
    const spec = renderedJob.spec!;
    const podSpec = spec.template.spec!;
    const c = podSpec.containers[0];

    expect(c.image, "uses an agent-host image").toMatch(/agent-host/);
    expect(c.command).toEqual([
      "node",
      "dist/scripts/runEventBackfill.js",
      "/mirror/conversations",
    ]);

    // The SAME agent_host DB wiring the live service uses — a DATABASE_URL here (the original
    // restore's bug) would point at nothing and the load would fail.
    const envNames = (c.env ?? []).map((e) => e.name);
    expect(envNames).toContain("AGENT_HOST_DB_HOST");
    expect(envNames).toContain("AGENT_HOST_DB_PASSWORD");
    expect(envNames).not.toContain("DATABASE_URL");
    const pwEnv = (c.env ?? []).find((e) => e.name === "AGENT_HOST_DB_PASSWORD");
    expect(pwEnv?.valueFrom?.secretKeyRef?.name).toBe("agent-pg-agent-host");

    // The mirror is the only copy of un-migrated history: it must be mounted READ-ONLY.
    const mount = (c.volumeMounts ?? []).find((m) => m.mountPath === "/mirror");
    expect(mount?.readOnly).toBe(true);
    const vol = (podSpec.volumes ?? []).find((v) => v.name === mount?.name);
    expect(vol?.persistentVolumeClaim?.claimName).toBe(MIRROR_PVC);
    expect(podSpec.serviceAccountName).toBe("agent-host");
  });

  it("loads every seeded conversation's events into Postgres and exits 0", async () => {
    const run = `t${Date.now().toString(36)}`;
    const root = `/mirror/${run}/conversations`;
    const convA = `backfill-e2e-${run}-a`;
    const convB = `backfill-e2e-${run}-b`;
    const tree = { [convA]: [ev(1), ev(2), ev(3)], [convB]: [ev(1), ev(2)] };
    await seedMirror(root, tree);

    const jobName = `agent-event-backfill-${run}`;
    createdJobs.push(jobName);
    await cluster.apply(jobInstance(renderedJob, jobName, root));

    const status = await waitJobDone(cluster, jobName);
    expect(status.succeeded, `job status: ${JSON.stringify(status)}`).toBe(1);
    expect(status.failed ?? 0).toBe(0);

    // Independent confirmation the rows actually landed (the Job's own exit only proves it
    // THINKS it verified). Row count per conversation must equal the seeded line count.
    expect(Number(await psql(pw, `SELECT count(*) FROM conversation_events WHERE conversation_id = '${convA}'`))).toBe(3);
    expect(Number(await psql(pw, `SELECT count(*) FROM conversation_events WHERE conversation_id = '${convB}'`))).toBe(2);
    // seq is dense and 1-based.
    expect(await psql(pw, `SELECT max(seq) FROM conversation_events WHERE conversation_id = '${convA}'`)).toBe("3");
  });

  it("FAILS the whole run when one conversation is corrupt (never a false success)", async () => {
    const run = `t${Date.now().toString(36)}-bad`;
    const root = `/mirror/${run}/conversations`;
    const good = `backfill-e2e-${run}-good`;
    const bad = `backfill-e2e-${run}-bad`;
    // One valid conversation, one with a malformed line: parseLog must throw, and a single
    // failure has to fail the run — the mirror is reclaimed after this, so a partial "success"
    // silently destroys history.
    await seedMirror(root, { [good]: [ev(1)], [bad]: ["{ not json"] });

    const jobName = `agent-event-backfill-${run}`;
    createdJobs.push(jobName);
    // backoffLimit 0 so the failure is observed after a single attempt.
    await cluster.apply(jobInstance(renderedJob, jobName, root, { backoffLimit: 0 }));

    const status = await waitJobDone(cluster, jobName);
    expect(status.failed ?? 0, `job status: ${JSON.stringify(status)}`).toBeGreaterThanOrEqual(1);
    expect(status.succeeded ?? 0).toBe(0);
  });
});
