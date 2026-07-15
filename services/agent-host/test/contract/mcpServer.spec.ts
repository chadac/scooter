/**
 * Tier 1 contract test — the in-process MCP tool handlers (background jobs).
 *
 * The agent (goose) calls these tools over MCP; each handler maps a JobManager
 * call back to an MCP tool response. The conversationId is bound per MCP server
 * instance (one server per conversation's newSession). We test the HANDLER logic
 * directly (not the HTTP transport).
 */

import { describe, it, expect } from "vitest";

import {
  handleRunBackground,
  handleCheckBackground,
  handleListBackground,
  handleKillBackground,
} from "../../src/agent/mcpServer.js";
import type { JobManager, JobStatus, JobRecord } from "../../src/session/jobManager.js";

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
