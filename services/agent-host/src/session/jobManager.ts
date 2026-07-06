/**
 * jobManager — background-job orchestrator (runs in the agent-host, outside the pod).
 *
 * The agent starts a long-running command (a big build, a test suite) and wants to
 * keep working instead of blocking the whole turn on it. Since the sandbox exec is
 * request/response (no live PTY) and the agent-host must not hold a long-lived
 * process, a "background job" is a process DETACHED inside the sandbox pod, with
 * its stdout + exit code captured to files on the WORKSPACE PVC (so they survive
 * the agent-host and the pod's suspend/resume PVC retention). The agent-host reads
 * those files on demand via one-shot exec.
 *
 * In-pod layout (JOBS_DIR on the workspace PVC):
 *   <JOBS_DIR>/<jobId>/cmd      the command line (for list/inspect)
 *   <JOBS_DIR>/<jobId>/log      combined stdout+stderr, appended live
 *   <JOBS_DIR>/<jobId>/status   the exit code, written ONCE the process exits
 *   <JOBS_DIR>/<jobId>/pid      the detached process pid (for a future kill)
 *
 * A small per-conversation registry lives on the agent-host STATE PVC (via the
 * ConversationStore) so `list` knows a conversation's jobs across a restart.
 *
 * v1 is POLL-ON-DEMAND: the agent calls check()/list(). A completion-watcher that
 * PUSHES a "job finished" turn (preempting thinking via the interrupt queue) is a
 * tracked follow-up (see the graduated-interrupt-levels TODO).
 */

import type { SandboxApiClient } from "../exec/sandboxExec.js";
import type { SessionId } from "../types.js";

/** A background job's persisted registry entry (agent-host state PVC). */
export interface JobRecord {
  jobId: string;
  command: string;
  /** ms epoch when start() launched it. */
  startedAt: number;
}

/** The live state of a job, read from its in-pod files. */
export interface JobStatus {
  jobId: string;
  command: string;
  /** "running" until the status file exists; then "exited". "unknown" when the
   *  job dir is gone (pod recreated without the workspace, or GC'd). */
  state: "running" | "exited" | "unknown";
  /** Present only when state === "exited". */
  exitCode?: number;
  /** The captured log TAIL (bounded, see maxOutputBytes). */
  output: string;
  /** True when `output` was truncated to the tail. */
  truncated: boolean;
  /** The in-pod path to the FULL log on disk, so the agent can grep/tail more of
   *  it via the shell tool when the bounded `output` isn't enough. Removed by the
   *  cleanup sweep `cleanupTtlMs` after the job exits. */
  logPath: string;
}

export interface StartResult {
  jobId: string;
}

export interface JobManager {
  /** Launch `command` detached in the conversation's sandbox; returns its jobId
   *  immediately (does NOT wait for it to finish). */
  start(id: SessionId, command: string): Promise<StartResult>;
  /** Read a job's current state (running / exited + output) from its in-pod files. */
  check(id: SessionId, jobId: string): Promise<JobStatus>;
  /** List the conversation's known jobs (from the registry), newest first. */
  list(id: SessionId): Promise<JobRecord[]>;
  /** Remove the on-disk files of jobs that EXITED more than cleanupTtlMs ago (a
   *  `status` file older than the TTL). Running jobs are never touched. Called
   *  periodically by the agent-host. Best-effort; a missing jobs dir is a no-op. */
  cleanup(id: SessionId): Promise<void>;
}

/** Persist/read the per-conversation job registry (agent-host state PVC in prod;
 *  a fake in tests). Optional methods so an in-memory store can omit them. */
export interface JobRegistry {
  saveJob(id: SessionId, job: JobRecord): Promise<void>;
  listJobs(id: SessionId): Promise<JobRecord[]>;
}

export interface JobManagerDeps {
  /** Resolve a conversation's exec client (the same seam moduleManager uses). */
  client: (id: SessionId) => SandboxApiClient | Promise<SandboxApiClient>;
  /** Durable per-conversation job registry (state PVC). */
  registry: JobRegistry;
  /** The in-pod jobs dir (on the workspace PVC). Default JOBS_DIR. */
  jobsDir?: string;
  /** Cap the output returned by check() (tail). Default 64 KiB. */
  maxOutputBytes?: number;
  /** How long after a job EXITS its on-disk files are kept before the cleanup
   *  sweep removes them. Default 10 min. The check()/list() reads still work until
   *  then; afterwards check() reports "unknown". */
  cleanupTtlMs?: number;
  /** Wall-clock ms — injectable for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /** Mint a unique job id. Injectable for deterministic tests. */
  newJobId?: () => string;
}

/** Default in-pod jobs dir — under /workspace so it lives on the workspace PVC and
 *  survives suspend/resume. NOT /run or /tmp (tmpfs; lost on pod recreate). */
export const JOBS_DIR = "/workspace/.scooter/jobs";

const DEFAULT_MAX_OUTPUT = 64 * 1024;
const DEFAULT_CLEANUP_TTL = 10 * 60 * 1000;

/** POSIX-quote a string for embedding inside a single-quoted sh word. */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function createJobManager(deps: JobManagerDeps): JobManager {
  const jobsDir = deps.jobsDir ?? JOBS_DIR;
  const maxOutput = deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const cleanupTtlMs = deps.cleanupTtlMs ?? DEFAULT_CLEANUP_TTL;
  const now = deps.now ?? Date.now;
  const newJobId = deps.newJobId ?? (() => `job-${now().toString(36)}-${Math.floor(now() % 1e6)}`);

  const dir = (jobId: string) => `${jobsDir}/${jobId}`;
  const clientFor = (id: SessionId) => Promise.resolve(deps.client(id));

  return {
    async start(id, command): Promise<StartResult> {
      const jobId = newJobId();
      const d = dir(jobId);
      const client = await clientFor(id);
      // Detached launcher: setsid puts the command in its OWN session/process-group
      // (survives the exec shell, reapable as a group later). We record the command,
      // capture combined stdout+stderr to `log`, and write the exit code to `status`
      // ONLY when the command finishes — check() keys "running" vs "exited" on that
      // file's existence. `startedAt`/mtime drives the cleanup TTL. The whole thing
      // is backgrounded (`&`) so the exec returns immediately, not after the command.
      const script =
        `mkdir -p ${d} && ` +
        `printf %s ${shSingleQuote(command)} > ${d}/cmd && ` +
        `setsid sh -c ${shSingleQuote(`${command}; printf %s "$?" > ${d}/status`)} ` +
        `> ${d}/log 2>&1 < /dev/null & ` +
        `printf %s "$!" > ${d}/pid`;
      const res = await client.execute({ command: "sh", args: ["-c", script] });
      if (res.exitCode !== 0) {
        throw new Error(`run_background: failed to launch job (${(res.stderr || res.stdout || "").trim()})`);
      }
      await deps.registry.saveJob(id, { jobId, command, startedAt: now() });
      return { jobId };
    },

    async check(id, jobId): Promise<JobStatus> {
      const d = dir(jobId);
      const client = await clientFor(id);
      const command = (await deps.registry.listJobs(id)).find((j) => j.jobId === jobId)?.command ?? "";
      // One exec reads everything: the status file (empty if absent), the tail of
      // the log, and its byte size (to set `truncated`). Absent job dir -> "unknown".
      const probe =
        `if [ ! -d ${d} ]; then echo __MISSING__; exit 0; fi; ` +
        `echo __STATUS__; [ -f ${d}/status ] && cat ${d}/status; echo; ` +
        `echo __SIZE__; wc -c < ${d}/log 2>/dev/null || echo 0; ` +
        `echo __LOG__; tail -c ${maxOutput} ${d}/log 2>/dev/null || true`;
      const res = await client.execute({ command: "sh", args: ["-c", probe] });
      const out = res.stdout ?? "";
      if (out.includes("__MISSING__")) {
        return { jobId, command, state: "unknown", output: "", truncated: false, logPath: `${d}/log` };
      }
      const statusRaw = section(out, "__STATUS__", "__SIZE__").trim();
      const sizeRaw = section(out, "__SIZE__", "__LOG__").trim();
      const log = section(out, "__LOG__", null);
      const size = Number.parseInt(sizeRaw, 10) || 0;
      const exited = statusRaw !== "";
      return {
        jobId,
        command,
        state: exited ? "exited" : "running",
        exitCode: exited ? Number.parseInt(statusRaw, 10) : undefined,
        output: log,
        truncated: size > maxOutput,
        logPath: `${d}/log`,
      };
    },

    async list(id): Promise<JobRecord[]> {
      return deps.registry.listJobs(id);
    },

    async cleanup(id): Promise<void> {
      const client = await clientFor(id);
      const ttlMin = Math.max(1, Math.ceil(cleanupTtlMs / 60000));
      // A job is DONE when its `status` file exists; remove that job's dir when the
      // status file is older than the TTL. `-mmin +N` finds status files last
      // modified more than N minutes ago; a RUNNING job has no status file, so it's
      // never matched. Best-effort: no jobs dir -> nothing to do.
      const script =
        `[ -d ${jobsDir} ] || exit 0; ` +
        `find ${jobsDir} -mindepth 2 -maxdepth 2 -name status -mmin +${ttlMin} ` +
        `-exec sh -c 'rm -rf "$(dirname "$1")"' _ {} \\; 2>/dev/null || true`;
      await client.execute({ command: "sh", args: ["-c", script] }).catch(() => {
        /* best-effort cleanup — a failure just retries next sweep */
      });
    },
  };

  // Extract the text between two markers (exclusive of the start marker's line).
  function section(text: string, start: string, end: string | null): string {
    const i = text.indexOf(start);
    if (i < 0) return "";
    const from = i + start.length;
    const rest = text.slice(from).replace(/^\n/, "");
    if (end == null) return rest;
    const j = rest.indexOf(end);
    return j < 0 ? rest : rest.slice(0, j);
  }
}

