/**
 * Tier 1 contract test — jobManager (run_background job-core).
 *
 * Drives the manager against a FAKE exec client that records execs + serves
 * canned file reads, and a fake registry. Proves:
 *   - start() launches the command DETACHED (nohup/setsid, redirect to the job's
 *     log, status written on exit) under the workspace-PVC jobs dir, records it in
 *     the registry, and returns a jobId WITHOUT waiting for the command;
 *   - check() reports "running" (no status file) vs "exited" (+ exitCode) and
 *     returns the captured log;
 *   - list() returns the registry's jobs (durable across restart).
 */

import { describe, it, expect, vi } from "vitest";

import { createJobManager, JOBS_DIR, type JobRecord } from "../../src/session/jobManager.js";
import type { SandboxApiClient } from "../../src/exec/sandboxExec.js";
import type { ExecRequest, ExecResult } from "../../src/types.js";

/** A fake exec client: records every execute(), and lets a test script the
 *  ExecResult per call (by matching on the joined command). uploads/downloads
 *  are recorded too. */
function fakeClient(script?: (cmd: string) => Partial<ExecResult> | undefined) {
  const execs: string[] = [];
  const uploads: Array<{ path: string; content: string }> = [];
  const client: SandboxApiClient = {
    mode: "direct",
    async execute(req: ExecRequest): Promise<ExecResult> {
      const cmd = [req.command, ...(req.args ?? [])].join(" ");
      execs.push(cmd);
      const scripted = script?.(cmd);
      return { stdout: "", stderr: "", exitCode: 0, ...scripted };
    },
    async upload(path, content) {
      uploads.push({ path, content });
    },
    async download() {
      return "";
    },
  };
  return { client, execs, uploads };
}

/** Build the marker-delimited stdout that check()'s single probe expects:
 *  __STATUS__\n<status>\n__SIZE__\n<bytes>\n__LOG__\n<log>. An empty status =
 *  running (no status file yet). */
function probeOut(status: string, sizeBytes: number, log: string): string {
  return `__STATUS__\n${status}\n__SIZE__\n${sizeBytes}\n__LOG__\n${log}`;
}

function fakeRegistry() {
  const jobs = new Map<string, JobRecord[]>();
  return {
    registry: {
      async saveJob(id: string, job: JobRecord) {
        jobs.set(id, [job, ...(jobs.get(id) ?? [])]);
      },
      async listJobs(id: string) {
        return jobs.get(id) ?? [];
      },
      async updateJob(id: string, job: JobRecord) {
        const list = jobs.get(id) ?? [];
        const i = list.findIndex((j) => j.jobId === job.jobId);
        if (i >= 0) list[i] = job;
      },
    },
    jobs,
  };
}

const mgr = (client: SandboxApiClient, registry: ReturnType<typeof fakeRegistry>["registry"], newJobId = () => "job-1") =>
  createJobManager({ client: () => client, registry, newJobId });

describe("jobManager.start", () => {
  it("launches the command DETACHED under the workspace jobs dir and returns a jobId", async () => {
    const { client, execs } = fakeClient();
    const { registry, jobs } = fakeRegistry();
    const res = await mgr(client, registry).start("conv-1", "npm run build");

    expect(res.jobId).toBe("job-1");
    // Some exec launched the job detached: it must reference the job's log +
    // status under JOBS_DIR/<jobId>, and detach (nohup or setsid + trailing &).
    const launch = execs.find((c) => c.includes(`${JOBS_DIR}/job-1`));
    expect(launch, "a launch exec referencing the job dir").toBeTruthy();
    expect(launch).toMatch(/nohup|setsid/); // detached from the exec's lifetime
    expect(launch).toContain("npm run build"); // the actual command
    // Recorded in the durable registry so list() sees it across a restart.
    expect(jobs.get("conv-1")?.[0]).toMatchObject({ jobId: "job-1", command: "npm run build" });
  });

  it("creates the job dir BEFORE the backgrounded job (mkdir not racing the pid write)", async () => {
    // Regression: `mkdir -p $d && … & printf … > $d/pid` backgrounds the WHOLE chain,
    // so the trailing pid-write races the not-yet-run mkdir and fails "No such file
    // or directory" (the reported run_background launch failure). The mkdir must run
    // in the FOREGROUND — before the `&` — so $d exists when pid is written.
    const { client, execs } = fakeClient();
    const { registry } = fakeRegistry();
    await mgr(client, registry).start("conv-1", "sleep 1");

    const launch = execs.find((c) => c.includes(`${JOBS_DIR}/job-1`))!;
    // The mkdir must be FOREGROUND — separated from the backgrounded setsid by a
    // statement terminator `;` (not chained into it with `&&`, which the trailing
    // `&` would then background wholesale). So: the mkdir/cmd segment ends with `;`
    // BEFORE `setsid`, and the pid write comes AFTER the detach `&`.
    const setsidAt = launch.indexOf("setsid");
    const mkdirAt = launch.indexOf("mkdir -p");
    const bgAt = launch.indexOf("&");
    const pidAt = launch.indexOf("/pid");
    expect(mkdirAt).toBeGreaterThanOrEqual(0);
    expect(mkdirAt).toBeLessThan(setsidAt);
    // A `;` sits between the foreground setup and the backgrounded setsid — this is
    // exactly what stops the `&` from backgrounding the mkdir (the bug).
    expect(launch.slice(mkdirAt, setsidAt)).toContain(";");
    expect(pidAt).toBeGreaterThan(bgAt); // pid write happens after the detach
  });

  it("does NOT block on the command (start returns before it would finish)", async () => {
    // If start() awaited the command, this scripted long-runner would hang the test.
    const { client } = fakeClient((cmd) =>
      cmd.includes("sleep") ? { stdout: "", exitCode: 0 } : undefined,
    );
    const { registry } = fakeRegistry();
    const res = await mgr(client, registry).start("conv-1", "sleep 999");
    expect(res.jobId).toBeTruthy(); // returned promptly, no await on the command
  });
});

describe("jobManager.check", () => {
  it("reports RUNNING when the status file does not exist yet", async () => {
    // The status read exits non-zero (file absent) -> running; the log read returns
    // partial output.
    const { client } = fakeClient((cmd) => {
      // check() reads status+size+log in ONE probe; the fake returns the combined,
      // marker-delimited output the impl parses. No status marker content = running.
      if (cmd.includes("__STATUS__")) return { stdout: probeOut("", 12, "building...\n") };
      return undefined;
    });
    const { registry } = fakeRegistry();
    await registry.saveJob("conv-1", { jobId: "job-1", command: "npm run build", startedAt: 1 });

    const st = await mgr(client, registry).check("conv-1", "job-1");
    expect(st.state).toBe("running");
    expect(st.exitCode).toBeUndefined();
    expect(st.output).toContain("building...");
  });

  it("reports EXITED with the exit code once the status file is written", async () => {
    const { client } = fakeClient((cmd) => {
      if (cmd.includes("__STATUS__")) return { stdout: probeOut("0", 5, "done\n") };
      return undefined;
    });
    const { registry } = fakeRegistry();
    await registry.saveJob("conv-1", { jobId: "job-1", command: "npm run build", startedAt: 1 });

    const st = await mgr(client, registry).check("conv-1", "job-1");
    expect(st.state).toBe("exited");
    expect(st.exitCode).toBe(0);
    expect(st.output).toContain("done");
  });

  it("surfaces a NON-ZERO exit code", async () => {
    const { client } = fakeClient((cmd) => {
      if (cmd.includes("__STATUS__")) return { stdout: probeOut("17", 5, "boom\n") };
      return undefined;
    });
    const { registry } = fakeRegistry();
    await registry.saveJob("conv-1", { jobId: "job-1", command: "x", startedAt: 1 });
    const st = await mgr(client, registry).check("conv-1", "job-1");
    expect(st.state).toBe("exited");
    expect(st.exitCode).toBe(17);
  });

  it("reports UNKNOWN when the job dir is gone (cleaned up / pod recreated)", async () => {
    const { client } = fakeClient((cmd) =>
      cmd.includes("__STATUS__") ? { stdout: "__MISSING__\n" } : undefined,
    );
    const { registry } = fakeRegistry();
    await registry.saveJob("conv-1", { jobId: "job-1", command: "x", startedAt: 1 });
    const st = await mgr(client, registry).check("conv-1", "job-1");
    expect(st.state).toBe("unknown");
  });

  it("flags truncation when the log is larger than the tail cap", async () => {
    const { client } = fakeClient((cmd) =>
      // size (2 MiB) far exceeds the default 64 KiB tail cap.
      cmd.includes("__STATUS__") ? { stdout: probeOut("0", 2 * 1024 * 1024, "…tail…") } : undefined,
    );
    const { registry } = fakeRegistry();
    await registry.saveJob("conv-1", { jobId: "job-1", command: "x", startedAt: 1 });
    const st = await mgr(client, registry).check("conv-1", "job-1");
    expect(st.truncated).toBe(true);
    expect(st.logPath).toContain("job-1/log");
  });
});

describe("jobManager.cleanup", () => {
  it("removes EXITED jobs' dirs older than the TTL (find on old status files)", async () => {
    const { client, execs } = fakeClient();
    const { registry } = fakeRegistry();
    // 10-min default TTL -> find -mmin +10; running jobs (no status file) untouched.
    await createJobManager({ client: () => client, registry }).cleanup("conv-1");
    const sweep = execs.find((c) => c.includes("find") && c.includes("status"));
    expect(sweep, "a find sweep over old status files").toBeTruthy();
    expect(sweep).toMatch(/-mmin \+10/); // 10-min default TTL
    expect(sweep).toContain(JOBS_DIR);
  });

  it("honors a custom cleanupTtlMs", async () => {
    const { client, execs } = fakeClient();
    const { registry } = fakeRegistry();
    await createJobManager({ client: () => client, registry, cleanupTtlMs: 5 * 60000 }).cleanup("conv-1");
    expect(execs.find((c) => c.includes("find"))).toMatch(/-mmin \+5/);
  });
});

describe("jobManager.kill", () => {
  it("SIGTERM+SIGKILLs the job's PROCESS GROUP (kill -- -PGID) when running", async () => {
    const { client, execs } = fakeClient((cmd) =>
      // The kill probe: no status file (running), a pid present → it kills.
      cmd.includes("__KILLED__") ? { stdout: "__KILLED__\n" } : undefined,
    );
    const { registry } = fakeRegistry();
    await registry.saveJob("conv-1", { jobId: "job-1", command: "npm run build", startedAt: 1 });

    const res = await mgr(client, registry).kill("conv-1", "job-1");
    expect(res.outcome).toBe("killed");
    const killExec = execs.find((c) => c.includes("kill -TERM"));
    expect(killExec, "a kill exec").toBeTruthy();
    expect(killExec).toMatch(/kill -TERM -- -/); // negative PGID = the process GROUP
    expect(killExec).toMatch(/kill -KILL -- -/); // escalates to SIGKILL after a grace
  });

  it("reports already-exited when the job has finished (no kill)", async () => {
    const { client } = fakeClient((cmd) => (cmd.includes("__KILLED__") ? { stdout: "__EXITED__\n" } : undefined));
    const { registry } = fakeRegistry();
    await registry.saveJob("conv-1", { jobId: "job-1", command: "x", startedAt: 1 });
    const res = await mgr(client, registry).kill("conv-1", "job-1");
    expect(res.outcome).toBe("already-exited");
  });

  it("reports unknown when the job dir is gone", async () => {
    const { client } = fakeClient((cmd) => (cmd.includes("__KILLED__") ? { stdout: "__UNKNOWN__\n" } : undefined));
    const { registry } = fakeRegistry();
    const res = await mgr(client, registry).kill("conv-1", "nope");
    expect(res.outcome).toBe("unknown");
  });
});

describe("jobManager.list", () => {
  it("returns the conversation's registered jobs (durable registry)", async () => {
    const { client } = fakeClient();
    const { registry } = fakeRegistry();
    const m = mgr(client, registry, () => "job-A");
    await m.start("conv-1", "cmd A");
    const list = await m.list("conv-1");
    expect(list.map((j) => j.command)).toContain("cmd A");
  });
});

describe("jobManager.pollCompletions (the completion-watcher)", () => {
  const exitedProbe = () => probeOut("0", 5, "all done\n");
  const runningProbe = () => probeOut("", 3, "working\n");

  it("returns a job that has EXITED and marks it notified (once)", async () => {
    const { client } = fakeClient((cmd) => (cmd.includes("__STATUS__") ? { stdout: exitedProbe() } : undefined));
    const { registry, jobs } = fakeRegistry();
    await registry.saveJob("conv-1", { jobId: "job-1", command: "npm test", startedAt: 1 });

    const first = await mgr(client, registry).pollCompletions("conv-1");
    expect(first.map((s) => s.jobId)).toEqual(["job-1"]);
    expect(first[0].state).toBe("exited");
    expect(first[0].output).toContain("all done");
    // The registry record is now marked notified.
    expect(jobs.get("conv-1")?.[0].notifiedAt).toBeTruthy();

    // A SECOND poll does NOT re-announce it (announce-at-most-once).
    const second = await mgr(client, registry).pollCompletions("conv-1");
    expect(second).toEqual([]);
  });

  it("does NOT return a still-RUNNING job (and doesn't mark it)", async () => {
    const { client } = fakeClient((cmd) => (cmd.includes("__STATUS__") ? { stdout: runningProbe() } : undefined));
    const { registry, jobs } = fakeRegistry();
    await registry.saveJob("conv-1", { jobId: "job-1", command: "sleep 999", startedAt: 1 });

    const done = await mgr(client, registry).pollCompletions("conv-1");
    expect(done).toEqual([]);
    expect(jobs.get("conv-1")?.[0].notifiedAt).toBeUndefined(); // not marked — still running
  });

  it("skips jobs already marked notified", async () => {
    const { client } = fakeClient((cmd) => (cmd.includes("__STATUS__") ? { stdout: exitedProbe() } : undefined));
    const { registry } = fakeRegistry();
    await registry.saveJob("conv-1", { jobId: "job-1", command: "x", startedAt: 1, notifiedAt: 999 });

    const done = await mgr(client, registry).pollCompletions("conv-1");
    expect(done).toEqual([]); // already announced
  });
});
