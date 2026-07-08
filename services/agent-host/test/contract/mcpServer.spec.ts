/**
 * Tier 1 contract test — the modify_environment MCP tool handler.
 *
 * The agent (goose) calls modify_environment(module_nix) over MCP; the handler
 * routes it to moduleManager.apply(conversationId, module) and maps the result
 * back to an MCP tool response. The conversationId is bound per MCP server
 * instance (one server per conversation's newSession). We test the HANDLER logic
 * directly (not the HTTP transport): success -> ok text; failure -> the build
 * error surfaced to the agent (isError) so it can fix its module.
 */

import { describe, it, expect } from "vitest";

import {
  handleModifyEnvironment,
  handleRunBackground,
  handleCheckBackground,
  handleListBackground,
  handleKillBackground,
} from "../../src/agent/mcpServer.js";
import type { ModuleManager } from "../../src/session/moduleManager.js";
import type { JobManager, JobStatus, JobRecord } from "../../src/session/jobManager.js";

function fakeManager(result: { ok: boolean; error?: string }): {
  mgr: ModuleManager;
  calls: Array<{ id: string; module: string }>;
} {
  const calls: Array<{ id: string; module: string }> = [];
  const mgr: ModuleManager = {
    async apply(id, module) {
      calls.push({ id, module });
      return { ...result, async: result.ok };
    },
    async status() {
      return { state: "idle" };
    },
    async pollNow() {},
    isApplying() {
      return false;
    },
  };
  return { mgr, calls };
}

const MODULE = `{ ... }: { environment.systemPackages = [ ]; }`;

describe("modify_environment MCP tool handler", () => {
  it("routes to moduleManager.apply + tells the agent it's LAUNCHED in the background", async () => {
    const { mgr, calls } = fakeManager({ ok: true });
    const res = await handleModifyEnvironment(mgr, "conv1", { module_nix: MODULE });

    expect(calls).toEqual([{ id: "conv1", module: MODULE }]);
    expect(res.isError).toBeFalsy();
    // async now — the switch runs in the background; the agent is pointed at the poll.
    const text = res.content[0].text.toLowerCase();
    expect(text).toContain("background");
    expect(text).toContain("scooter-env-status");
  });

  it("surfaces a LAUNCH failure to the agent (isError) — not a build error", async () => {
    const { mgr } = fakeManager({ ok: false, error: "a switch is already in progress" });
    const res = await handleModifyEnvironment(mgr, "conv1", { module_nix: MODULE });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("already in progress");
  });

  it("rejects an empty module without calling apply", async () => {
    const { mgr, calls } = fakeManager({ ok: true });
    const res = await handleModifyEnvironment(mgr, "conv1", { module_nix: "   " });

    expect(res.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

function fakeJobs(over: Partial<JobManager> = {}): { jobs: JobManager; calls: string[] } {
  const calls: string[] = [];
  const jobs: JobManager = {
    async start(id, command) { calls.push(`start:${id}:${command}`); return { jobId: "job-1" }; },
    async check(id, jobId) { calls.push(`check:${id}:${jobId}`); return { jobId, command: "npm run build", state: "running", output: "building...", truncated: false, logPath: "/workspace/.scooter/jobs/job-1/log" } as JobStatus; },
    async list() { return [] as JobRecord[]; },
    async cleanup() {},
    async pollCompletions() { return []; },
    async kill(_id, jobId) { calls.push(`kill:${jobId}`); return { jobId, outcome: "killed" as const }; },
    ...over,
  };
  return { jobs, calls };
}

describe("run_background MCP tool handler", () => {
  it("starts the job and returns the job id", async () => {
    const { jobs, calls } = fakeJobs();
    const res = await handleRunBackground(jobs, "conv1", { command: "npm run build" });
    expect(calls).toContain("start:conv1:npm run build");
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("job-1");
  });

  it("rejects an empty command without starting a job", async () => {
    const { jobs, calls } = fakeJobs();
    const res = await handleRunBackground(jobs, "conv1", { command: "   " });
    expect(res.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("check_background MCP tool handler", () => {
  it("reports a running job with its output", async () => {
    const { jobs } = fakeJobs();
    const res = await handleCheckBackground(jobs, "conv1", { job_id: "job-1" });
    expect(res.content[0].text).toMatch(/RUNNING/);
    expect(res.content[0].text).toContain("building...");
  });

  it("reports an exited job with its exit code", async () => {
    const { jobs } = fakeJobs({
      async check(_id, jobId) { return { jobId, command: "x", state: "exited", exitCode: 0, output: "done", truncated: false, logPath: "/p/log" }; },
    });
    const res = await handleCheckBackground(jobs, "conv1", { job_id: "job-1" });
    expect(res.content[0].text).toMatch(/EXITED with code 0/);
  });

  it("errors on an unknown job (cleaned up / pod recreated)", async () => {
    const { jobs } = fakeJobs({
      async check(_id, jobId) { return { jobId, command: "", state: "unknown", output: "", truncated: false, logPath: "/p/log" }; },
    });
    const res = await handleCheckBackground(jobs, "conv1", { job_id: "gone" });
    expect(res.isError).toBe(true);
  });

  it("points at the full on-disk log when the output is truncated", async () => {
    const { jobs } = fakeJobs({
      async check(_id, jobId) { return { jobId, command: "x", state: "exited", exitCode: 0, output: "…", truncated: true, logPath: "/workspace/.scooter/jobs/job-1/log" }; },
    });
    const res = await handleCheckBackground(jobs, "conv1", { job_id: "job-1" });
    expect(res.content[0].text).toContain("/workspace/.scooter/jobs/job-1/log");
  });
});

describe("list_background MCP tool handler", () => {
  it("lists the conversation's jobs", async () => {
    const { jobs } = fakeJobs({
      async list() { return [{ jobId: "job-1", command: "npm test", startedAt: 1 }]; },
    });
    const res = await handleListBackground(jobs, "conv1");
    expect(res.content[0].text).toContain("job-1");
    expect(res.content[0].text).toContain("npm test");
  });

  it("says so when there are no jobs", async () => {
    const { jobs } = fakeJobs({ async list() { return []; } });
    const res = await handleListBackground(jobs, "conv1");
    expect(res.content[0].text).toMatch(/no background jobs/i);
  });
});

describe("kill_background MCP tool handler", () => {
  it("kills the job and reports it", async () => {
    const { jobs, calls } = fakeJobs();
    const res = await handleKillBackground(jobs, "conv1", { job_id: "job-1" });
    expect(calls).toContain("kill:job-1");
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/killed/i);
  });

  it("reports already-exited (not an error) for a finished job", async () => {
    const { jobs } = fakeJobs({ async kill(_id, jobId) { return { jobId, outcome: "already-exited" }; } });
    const res = await handleKillBackground(jobs, "conv1", { job_id: "job-1" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/already finished/i);
  });

  it("errors on an unknown job", async () => {
    const { jobs } = fakeJobs({ async kill(_id, jobId) { return { jobId, outcome: "unknown" }; } });
    const res = await handleKillBackground(jobs, "conv1", { job_id: "gone" });
    expect(res.isError).toBe(true);
  });

  it("rejects an empty job_id", async () => {
    const { jobs } = fakeJobs();
    const res = await handleKillBackground(jobs, "conv1", { job_id: "  " });
    expect(res.isError).toBe(true);
  });
});
