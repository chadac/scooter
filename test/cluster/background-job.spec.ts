/**
 * Tier 2 — the run_background detached-job mechanism works in a REAL pod.
 *
 * jobManager launches a command via `setsid … & ` so it survives the exec shell,
 * captures stdout+exit to files, and check() reads them back. The unit tier fakes
 * the exec; this proves the actual in-pod behavior the fake can't:
 *   - setsid detaches the job so the launcher exec returns IMMEDIATELY (the job
 *     keeps running after),
 *   - a still-running job has NO status file (check -> running),
 *   - once it finishes, the exit code lands in `status` and stdout in `log`,
 *   - a non-zero exit is captured.
 *
 * Drives the exact shell the jobManager emits, against the OS image (which now
 * ships util-linux for setsid). Gated: RUN_CLUSTER_TESTS=1.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;
const NS = "agent-sandbox-bgjob-test";
const IMAGE = process.env.SANDBOX_OS_IMAGE ?? "agent-sandbox-os:latest";
const POD = "bgjob-boot";
const SELECTOR = "app=bgjob-boot";
const JOBS = "/tmp/scooter-jobs"; // writable in the bare pod (no workspace PVC here)

/** The detached launcher jobManager.start() emits (JOBS_DIR/<jobId>). */
const launch = (jobId: string, command: string) => {
  const d = `${JOBS}/${jobId}`;
  return (
    `mkdir -p ${d} && printf %s '${command}' > ${d}/cmd && ` +
    `setsid sh -c '${command}; printf %s "$?" > ${d}/status' > ${d}/log 2>&1 < /dev/null & ` +
    `printf %s "$!" > ${d}/pid`
  );
};

maybe("run_background detached-job mechanism works in a real pod", () => {
  let cluster: Cluster;

  beforeAll(async () => {
    cluster = await withCluster({ installController: false, namespace: NS });
    await cluster.apply({ apiVersion: "v1", kind: "Namespace", metadata: { name: NS } }).catch(() => {});
    await cluster.deletePod(POD, NS).catch(() => {});
    for (let i = 0; i < 60; i++) {
      const gone = await cluster.get("Pod", POD, NS).then(() => false).catch(() => true);
      if (gone) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await cluster.apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: POD, namespace: NS, labels: { app: "bgjob-boot" } },
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
            ],
          },
        ],
        volumes: [
          { name: "run", emptyDir: { medium: "Memory" } },
          { name: "tmp", emptyDir: { medium: "Memory" } },
        ],
      },
    });
    await cluster.waitFor<{ status: { phase: string } }>("Pod", POD, (p) => p.status?.phase === "Running", 180_000, NS);
  }, 240_000);

  afterAll(async () => {
    await cluster?.deletePod(POD, NS).catch(() => {});
  });

  it("has setsid available (util-linux) in the image", async () => {
    const r = await cluster.exec(SELECTOR, ["sh", "-c", "command -v setsid && echo OK"], NS);
    expect(r.stdout).toContain("OK");
  });

  it("launches a job DETACHED (the exec returns while the job keeps running)", async () => {
    // A 5s sleep: the launcher must return promptly, and the job must still be
    // running right after (no status file yet).
    const t0 = Date.now();
    const r = await cluster.exec(SELECTOR, ["sh", "-c", launch("job-a", "sleep 5; echo done-a")], NS);
    expect(r.exitCode).toBe(0);
    expect(Date.now() - t0, "launcher returned without waiting the 5s sleep").toBeLessThan(4000);

    // No status file yet -> still running.
    const st = await cluster.exec(SELECTOR, ["sh", "-c", `[ -f ${JOBS}/job-a/status ] && echo EXITED || echo RUNNING`], NS);
    expect(st.stdout.trim()).toBe("RUNNING");
  });

  it("captures the exit code + stdout once the job finishes", async () => {
    await cluster.exec(SELECTOR, ["sh", "-c", launch("job-b", "echo hello-b; exit 0")], NS);
    // Poll for the status file (it appears once the detached job exits).
    let status = "";
    for (let i = 0; i < 30; i++) {
      const s = await cluster.exec(SELECTOR, ["sh", "-c", `cat ${JOBS}/job-b/status 2>/dev/null`], NS);
      if (s.stdout.trim() !== "") { status = s.stdout.trim(); break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(status).toBe("0");
    const log = await cluster.exec(SELECTOR, ["sh", "-c", `cat ${JOBS}/job-b/log`], NS);
    expect(log.stdout).toContain("hello-b");
  });

  it("captures a NON-ZERO exit code", async () => {
    await cluster.exec(SELECTOR, ["sh", "-c", launch("job-c", "echo boom-c >&2; exit 7")], NS);
    let status = "";
    for (let i = 0; i < 30; i++) {
      const s = await cluster.exec(SELECTOR, ["sh", "-c", `cat ${JOBS}/job-c/status 2>/dev/null`], NS);
      if (s.stdout.trim() !== "") { status = s.stdout.trim(); break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(status).toBe("7");
    // stderr is captured too (2>&1 in the launcher's redirect).
    const log = await cluster.exec(SELECTOR, ["sh", "-c", `cat ${JOBS}/job-c/log`], NS);
    expect(log.stdout).toContain("boom-c");
  });

  it("kill -- -PGID reaps the whole process GROUP (the job AND its children)", async () => {
    // A job that spawns a child (a background sleep) and writes both pids, so we can
    // verify BOTH die when we signal the group — not just the leader.
    const cmd =
      `sleep 300 & echo $! > ${JOBS}/job-k/child_pid; ` +
      `echo started; sleep 300`;
    await cluster.exec(SELECTOR, ["sh", "-c", launch("job-k", cmd)], NS);
    // Wait until the child pid file exists (the job is up + spawned its child).
    let childPid = "";
    for (let i = 0; i < 30; i++) {
      const c = await cluster.exec(SELECTOR, ["sh", "-c", `cat ${JOBS}/job-k/child_pid 2>/dev/null`], NS);
      if (c.stdout.trim() !== "") { childPid = c.stdout.trim(); break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(childPid).not.toBe("");
    const leaderPid = (await cluster.exec(SELECTOR, ["sh", "-c", `cat ${JOBS}/job-k/pid`], NS)).stdout.trim();

    // Both processes are alive before the kill.
    const alive = async (pid: string) =>
      (await cluster.exec(SELECTOR, ["sh", "-c", `kill -0 ${pid} 2>/dev/null && echo yes || echo no`], NS)).stdout.trim();
    expect(await alive(leaderPid)).toBe("yes");
    expect(await alive(childPid)).toBe("yes");

    // Kill the process GROUP (the same command jobManager.kill emits).
    await cluster.exec(SELECTOR, ["sh", "-c", `kill -TERM -- -${leaderPid} 2>/dev/null; sleep 2; kill -KILL -- -${leaderPid} 2>/dev/null; true`], NS);
    await new Promise((r) => setTimeout(r, 1000));

    // BOTH the leader and its child are gone — the group reap worked.
    expect(await alive(leaderPid)).toBe("no");
    expect(await alive(childPid)).toBe("no");
  });
});
