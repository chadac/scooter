/**
 * Production SandboxApiClient over the Kubernetes exec API (pods/exec). There is no
 * in-pod server: commands run via the exec subresource and file ops use cat.
 * Requires `get,create pods/exec` (plus get pods) RBAC on the agent-host SA.
 */

import { Writable, Readable, PassThrough } from "node:stream";
import { debugError } from "../debug.js";
import { logger } from "../log.js";
import { existsSync } from "node:fs";

import { KubeConfig, Exec, CoreV1Api, type V1Pod, type V1Status } from "@kubernetes/client-node";

import type { ExecRequest, ExecResult, SandboxRef } from "../types.js";
import type { SandboxApiClient } from "./sandboxExec.js";
import { describeSandboxDisruption } from "./podDisruption.js";
import { podWaitStatus, setPodWaitStatus } from "./podReadiness.js";
import { diagnosePodWait } from "./podDiagnosis.js";

const log = logger("k8sExec");

const SANDBOX_LABEL = "agents.x-k8s.io/sandbox-name";

const DEFAULT_CONTAINER = "sandbox";

/** Thrown when ensureRunning declines on purpose, e.g. a suspended conversation. */
export class ResumeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeRefusedError";
  }
}

/** Collects a Writable's chunks into a string. */
function sink(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

function exitCodeFromStatus(status: V1Status | undefined): number {
  if (!status) return 0;
  if (status.status === "Success") return 0;
  // Non-zero exit is reported in causes as { reason: "ExitCode", message: "N" }.
  const cause = status.details?.causes?.find((c) => c.reason === "ExitCode");
  if (cause?.message) return Number.parseInt(cause.message, 10) || 1;
  return 1;
}

/** A k8s exec failure as an Error whose message carries the Status, so no caller prints `[object Object]`. */
export class K8sExecError extends Error {
  constructor(
    message: string,
    readonly status?: V1Status,
    readonly wsClose?: { code: number; reason: string },
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "K8sExecError";
  }
}

const isStatus = (v: unknown): v is V1Status =>
  !!v && typeof v === "object" && ((v as V1Status).kind === "Status" || ("status" in v && "reason" in v));

/** One line for a k8s Status: `reason: message (code N) [cause; cause]`. */
export function describeStatus(s: V1Status): string {
  const causes = (s.details?.causes ?? [])
    .map((c) => [c.reason, c.field, c.message].filter(Boolean).join(" "))
    .filter(Boolean);
  return [
    [s.reason, s.message].filter(Boolean).join(": ") || s.status || "Failure",
    s.code !== undefined ? `(code ${s.code})` : "",
    causes.length ? `[${causes.join("; ")}]` : "",
  ].filter(Boolean).join(" ");
}

/** Normalize whatever exec() / the WebSocket rejected with into a K8sExecError. */
export function toExecError(e: unknown, wsClose?: { code: number; reason: string }): K8sExecError {
  if (e instanceof K8sExecError) return e;
  const closeNote = wsClose ? ` (ws close ${wsClose.code}${wsClose.reason ? ` ${wsClose.reason}` : ""})` : "";
  // ApiException-style errors carry the Status as `body` (possibly as JSON text).
  let body: unknown = (e as { body?: unknown } | undefined)?.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      /* not JSON */
    }
  }
  const status = isStatus(e) ? e : isStatus(body) ? body : undefined;
  if (status) return new K8sExecError(`k8s exec failed: ${describeStatus(status)}${closeNote}`, status, wsClose, { cause: e });
  // A ws ErrorEvent wraps the real error.
  const inner = (e as { error?: unknown } | undefined)?.error;
  if (inner instanceof Error) return new K8sExecError(`k8s exec failed: ${inner.message}${closeNote}`, undefined, wsClose, { cause: inner });
  if (e instanceof Error) return new K8sExecError(`k8s exec failed: ${e.message}${closeNote}`, undefined, wsClose, { cause: e });
  const msg = (e as { message?: unknown } | undefined)?.message;
  let text: string;
  if (typeof msg === "string" && msg) text = msg;
  else {
    try {
      text = JSON.stringify(e) ?? String(e);
    } catch {
      text = String(e);
    }
  }
  if (!text || text === "{}") text = "no error detail";
  return new K8sExecError(`k8s exec failed: ${text}${closeNote}`, undefined, wsClose, { cause: e });
}

export interface K8sExecOptions {
  kubeConfig?: KubeConfig;
  container?: string;
  /** Explicit pod name; otherwise resolved from the Sandbox's labelled pod. */
  podName?: string;
  /** Called once when the pod-readiness poll finds no pod at all, to resume a sandbox suspended out from under a live bridge; absent means no self-heal. */
  ensureRunning?: () => Promise<void>;
}

/** Resolves a SandboxRef to a connected pod-exec client. */
export async function connectSandbox(
  ref: SandboxRef,
  opts: K8sExecOptions = {},
): Promise<SandboxApiClient> {
  const kc = opts.kubeConfig ?? defaultKubeConfig();
  // Prefer a pod name the caller already knows (the controller names the pod after the
  // Sandbox, so ref.name is the pod name), which needs no `get/list pods` RBAC.
  const podName = opts.podName ?? (ref.podIP ? ref.name : await resolvePodName(kc, ref, opts.ensureRunning));
  return createK8sSandboxApiClient(ref, { ...opts, kubeConfig: kc, podName });
}

/** The conversation pod's address for direct in-cluster HTTP/WS; `podIP` changes across suspend/resume, so re-resolve rather than cache it. */
export interface PodTarget {
  name: string;
  podIP: string;
}

type Pod = Awaited<ReturnType<CoreV1Api["readNamespacedPod"]>>;

/** Injectable options for the ready-pod poll, so a test can collapse it without a real k8s client. */
export interface ResolveReadyPodDeps {
  listCandidates: () => Promise<Pod[]>;
  ensureRunning?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  deadlineMs?: number;
  /** Why the candidates aren't Ready; absent means the wait carries no reason. */
  diagnose?: (pods: Pod[]) => Promise<string>;
}

/** How often a wait re-reads the pod's events for its reason. */
const DIAGNOSE_EVERY_MS = 15_000;

/** Running, every container ready, and not terminating (those still report ready). */
export function isReadyPod(p: Pod): boolean {
  return (
    !p.metadata?.deletionTimestamp &&
    p.status?.phase === "Running" &&
    (p.status?.containerStatuses ?? []).every((c) => c.ready)
  );
}

/** Poll until a Running and Ready pod backs the sandbox, firing `ensureRunning` once if the first lookup finds no pod at all. */
export async function pollForReadyPod(ref: SandboxRef, deps: ResolveReadyPodDeps): Promise<Pod> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const started = Date.now();
  const deadline = started + (deps.deadlineMs ?? 90_000);
  let lastRunning: Pod | undefined;
  let healed = false; // ensureRunning is fired at most once
  let waitLogged = false; // one "waiting" line per call, not one per poll
  let reason: string | undefined;
  let diagnosedAt = -Infinity;
  for (;;) {
    const candidates = await deps.listCandidates();
    // No pod at all: resume once so the controller recreates it, then keep polling.
    if (candidates.length === 0 && deps.ensureRunning && !healed) {
      healed = true;
      // Logged loudly because a resume fired against a just-suspended sandbox leaves a
      // pod running with no conversation attached.
      log.warn("resume-on-missing-pod: no pod for this sandbox; resuming it", {
        namespace: ref.namespace,
        pod_name: ref.name,
      });
      try {
        await deps.ensureRunning();
      } catch (err) {
        // Expected refusal: stop polling and report why.
        if (err instanceof ResumeRefusedError) {
          log.info("resume-on-missing-pod refused", { namespace: ref.namespace, pod_name: ref.name, reason: err.message });
          throw err;
        }
        log.errorWith("resume-on-missing-pod failed", err, {
          namespace: ref.namespace,
          pod_name: ref.name,
        });
        // A 404 means the Sandbox CR itself is gone, so fail now rather than poll to the deadline.
        if ((err as { code?: number }).code === 404) {
          throw new Error(`sandbox ${ref.namespace}/${ref.name} is gone (404 on resume)`);
        }
      }
      await sleep(1500);
      continue; // re-poll: the pod is now being recreated
    }
    const ready = candidates.find(isReadyPod);
    if (ready?.metadata?.name) {
      // Cleared only on success: after a failed wait it stays (for a while) for conversation_status.
      setPodWaitStatus(ref, undefined);
      const waitedMs = Date.now() - started;
      // A wait that spanned more than one poll is latency the caller's turn is eating, so record it.
      if (waitedMs > 2_000) {
        log.info("ready-pod wait ended", {
          namespace: ref.namespace,
          pod_name: ready.metadata.name,
          waited_ms: waitedMs,
          healed,
        });
      }
      return ready;
    }
    const expired = Date.now() > deadline;
    if (deps.diagnose && (expired || Date.now() - diagnosedAt >= DIAGNOSE_EVERY_MS)) {
      diagnosedAt = Date.now();
      reason = await deps.diagnose(candidates).catch(() => reason);
    }
    // Lets a command that times out here say it never started, and conversation_status say why.
    // An earlier failure stands until a Ready pod clears it.
    setPodWaitStatus(ref, { since: started, checkedAt: Date.now(), reason, failedAt: expired ? Date.now() : podWaitStatus(ref)?.failedAt });
    if (!waitLogged) {
      waitLogged = true;
      log.info("waiting for a ready pod", {
        namespace: ref.namespace,
        sandbox: ref.name,
        candidates: candidates.map((p) => ({
          name: p.metadata?.name,
          phase: p.status?.phase,
          ready: (p.status?.containerStatuses ?? []).map((c) => c.ready),
        })),
      });
    }
    lastRunning = candidates.find((p) => p.status?.phase === "Running") ?? lastRunning;
    if (expired) {
      // Fall back to any Running pod (or fail) rather than hang forever, warning once per sandbox.
      log.warnOnce(`ready-pod:${ref.namespace}/${ref.name}`, "ready-pod deadline expired", {
        namespace: ref.namespace,
        sandbox: ref.name,
        waited_ms: Date.now() - started,
        falling_back_to: lastRunning?.metadata?.name ?? null,
        reason,
      });
      if (lastRunning) return lastRunning;
      throw new Error(`no ready pod for sandbox ${ref.namespace}/${ref.name}${reason ? `: ${reason}` : ""}`);
    }
    await sleep(1500);
  }
}

/** The sandbox's pods, by label selector or else direct pod name. */
async function listSandboxPods(core: CoreV1Api, ref: SandboxRef): Promise<Pod[]> {
  const pods = await core.listNamespacedPod({
    namespace: ref.namespace,
    labelSelector: `${SANDBOX_LABEL}=${ref.name}`,
  });
  if (pods.items.length > 0) return pods.items;
  try {
    const pod = await core.readNamespacedPod({ namespace: ref.namespace, name: ref.name });
    return pod ? [pod] : [];
  } catch {
    return []; // pod not yet created
  }
}

/** Poll until a Running and Ready pod backs the sandbox, since exec against a ContainerCreating pod fails. */
async function resolveReadyPod(
  kc: KubeConfig,
  ref: SandboxRef,
  ensureRunning?: () => Promise<void>,
  deadlineMs?: number,
): Promise<Pod> {
  const core = kc.makeApiClient(CoreV1Api);
  return pollForReadyPod(ref, {
    ensureRunning,
    deadlineMs,
    diagnose: (pods) => diagnosePodWait(core, ref.namespace, pods),
    listCandidates: () => listSandboxPods(core, ref),
  });
}

/** Whether a Ready pod backs the sandbox now: one lookup, no waiting. */
export async function sandboxPodReady(ref: SandboxRef, opts: { kubeConfig?: KubeConfig } = {}): Promise<boolean> {
  const core = (opts.kubeConfig ?? defaultKubeConfig()).makeApiClient(CoreV1Api);
  return (await listSandboxPods(core, ref)).some(isReadyPod);
}

/** Wait up to `timeoutMs` for a Ready pod; undefined when Ready, else why not. */
export async function waitForSandboxPod(
  ref: SandboxRef,
  opts: { timeoutMs: number; ensureRunning?: () => Promise<void>; kubeConfig?: KubeConfig },
): Promise<string | undefined> {
  try {
    const pod = await resolveReadyPod(opts.kubeConfig ?? defaultKubeConfig(), ref, opts.ensureRunning, opts.timeoutMs);
    // A timed-out poll returns a Running, unready pod.
    if (isReadyPod(pod)) return undefined;
    return podWaitStatus(ref)?.reason ?? "pod Running but not Ready";
  } catch (e) {
    return (e as Error).message;
  }
}

async function resolvePodName(
  kc: KubeConfig,
  ref: SandboxRef,
  ensureRunning?: () => Promise<void>,
): Promise<string> {
  const pod = await resolveReadyPod(kc, ref, ensureRunning);
  const name = pod.metadata?.name;
  if (!name) throw new Error(`ready pod for sandbox ${ref.namespace}/${ref.name} has no name`);
  return name;
}

/** Resolve a sandbox to its pod name and routable pod IP for the web-service reverse proxy; throws if no ready pod has an IP. */
export async function resolvePodTarget(
  ref: SandboxRef,
  opts: { kubeConfig?: KubeConfig } = {},
): Promise<PodTarget> {
  // A pod IP the caller already knows needs no `get pods`.
  if (ref.podIP) return { name: ref.name, podIP: ref.podIP };
  const kc = opts.kubeConfig ?? defaultKubeConfig();
  const pod = await resolveReadyPod(kc, ref);
  const name = pod.metadata?.name;
  const podIP = pod.status?.podIP;
  if (!name || !podIP) {
    throw new Error(`ready pod for sandbox ${ref.namespace}/${ref.name} has no name/podIP`);
  }
  return { name, podIP };
}

export function createK8sSandboxApiClient(
  ref: SandboxRef,
  opts: K8sExecOptions = {},
): SandboxApiClient {
  const container = opts.container ?? DEFAULT_CONTAINER;
  const podName = opts.podName ?? ref.name;

  // A fresh Exec per call picks up the rotating projected SA token, which the client-node
  // Exec caches at construction.
  const freshExec = (): Exec => new Exec(opts.kubeConfig ?? defaultKubeConfig());

  const execRaw = (
    command: string[],
    stdin?: Readable,
    signal?: AbortSignal,
  ): Promise<ExecResult> =>
    new Promise((resolve, reject) => {
      const out = sink();
      const err = sink();
      let status: V1Status | undefined;
      // Stall watchdog: names the stage a still-running exec is stuck in (an unanswered
      // upgrade or a WS with no close frame) without ever killing it.
      const startedAt = Date.now();
      let stage = "upgrade-pending"; // -> "ws-open" -> settled
      let settled = false;
      const cmdSummary = command.join(" ").slice(0, 120);
      const watchdog = setInterval(() => {
        if (settled) return;
        log.warn("exec still running", {
          namespace: ref.namespace,
          pod_name: podName,
          stage,
          elapsed_ms: Date.now() - startedAt,
          cmd: cmdSummary,
        });
      }, 30_000);
      watchdog.unref?.();
      const settle = () => {
        settled = true;
        clearInterval(watchdog);
      };
      log.debug("exec dispatch", { namespace: ref.namespace, pod_name: podName, cmd: cmdSummary });
      /** The WebSocket close frame, kept so a property-less failure event still has something diagnosable attached. */
      let lastClose: { code: number; reason: string } | undefined;
      if (signal?.aborted) {
        // Already cancelled before we even opened the stream.
        settle();
        resolve({ stdout: out.text(), stderr: "aborted", exitCode: 130 });
        return;
      }
      freshExec()
        .exec(
          ref.namespace,
          podName,
          container,
          command,
          out.stream,
          err.stream,
          stdin ?? null,
          false,
          (s: V1Status) => {
            status = s;
          },
        )
        .then((ws) => {
          stage = "ws-open";
          log.debug("exec ws open", {
            namespace: ref.namespace,
            pod_name: podName,
            upgrade_ms: Date.now() - startedAt,
          });
          // Closing the pods/exec WebSocket tears down the remote exec, so a cancel ends
          // a long-running command mid-flight.
          const onAbort = () => {
            try {
              (ws as { close?: () => void }).close?.();
            } catch {
              /* already closing */
            }
            // Do not wait for the close handshake, which kubelet may not ack until the
            // exec'd process exits: resolve now and force the socket down.
            try {
              (ws as { terminate?: () => void }).terminate?.();
            } catch {
              /* already down */
            }
            settle();
            resolve({
              stdout: out.text(),
              stderr: err.text(),
              exitCode: 130,
            });
          };
          if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          }
          // Capture the close code/reason, since the error paths below may receive an
          // event with no own properties.
          ws.on("close", (code?: number, reason?: Buffer) => {
            if (code !== undefined) lastClose = { code, reason: reason?.toString() || "" };
            settle();
            const exit_code = signal?.aborted ? 130 : exitCodeFromStatus(status);
            log.debug("exec closed", {
              namespace: ref.namespace,
              pod_name: podName,
              exit_code,
              duration_ms: Date.now() - startedAt,
              ws_close: lastClose ?? null,
            });
            const result = { stdout: out.text(), stderr: err.text(), exitCode: exit_code };
            // Only a kill, or a close with no status, can mean the sandbox died.
            if (signal?.aborted || (status && exit_code !== 137 && exit_code !== 143)) {
              resolve(result);
              return;
            }
            void explainDisruption(new Date(startedAt)).then((note) => {
              if (!note) return resolve(result);
              const sep = result.stderr && !result.stderr.endsWith("\n") ? "\n" : "";
              resolve({
                stdout: result.stdout,
                stderr: `${result.stderr}${sep}${note}\n`,
                exitCode: exit_code === 0 ? 137 : exit_code,
              });
            });
          });
          ws.on("error", (e: unknown) => {
            settle();
            const err = toExecError(e, lastClose);
            log.errorWith("ws error", err, { status: err.status ?? null, ws_close: lastClose ?? null });
            void withDisruptionNote(err, new Date(startedAt)).then(reject);
          });
        })
        .catch((e: unknown) => {
          settle();
          const err = toExecError(e, lastClose);
          log.errorWith("exec() rejected", err, { status: err.status ?? null, ws_close: lastClose ?? null });
          void withDisruptionNote(err, new Date(startedAt)).then(reject);
        });
    });

  /** Why the sandbox died under a command started at `since`, if it did. */
  const explainDisruption = async (since: Date): Promise<string | undefined> => {
    const core = (opts.kubeConfig ?? defaultKubeConfig()).makeApiClient(CoreV1Api);
    // Kubelet records the termination a moment after the stream drops.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1_000));
      let pod: V1Pod | undefined;
      try {
        pod = await core.readNamespacedPod({ namespace: ref.namespace, name: podName });
      } catch (e) {
        if ((e as { code?: number }).code !== 404) {
          log.warn("disruption check: pod read failed", { pod_name: podName, error: String(e) });
          return undefined;
        }
      }
      const note = describeSandboxDisruption(pod, container, since);
      if (note) {
        log.info("sandbox disrupted under a command", { namespace: ref.namespace, pod_name: podName, note });
        return note;
      }
    }
    return undefined;
  };

  const withDisruptionNote = async (err: K8sExecError, since: Date): Promise<K8sExecError> => {
    const note = await explainDisruption(since);
    return note ? new K8sExecError(`${err.message}. ${note}`, err.status, err.wsClose, { cause: err.cause }) : err;
  };

  return {
    mode: "k8s-exec",

    execute(req: ExecRequest, signal?: AbortSignal): Promise<ExecResult> {
      const cmd = wrapCommand(req);
      return execRaw(cmd, req.stdin === undefined ? undefined : Readable.from([req.stdin]), signal);
    },

    async download(path: string): Promise<string> {
      const res = await execRaw(["cat", path]);
      if (res.exitCode !== 0) throw new Error(`download ${path}: ${res.stderr}`);
      return res.stdout;
    },

    async upload(path: string, content: string): Promise<void> {
      const res = await execRaw(writeStdinCommand(path), Readable.from([content]));
      if (res.exitCode !== 0) throw new Error(`upload ${path}: ${res.stderr}`);
    },

    async uploadBinary(path: string, base64: string): Promise<void> {
      // Stream the base64 over stdin, since a single argv string is capped at MAX_ARG_STRLEN.
      const res = await execRaw(writeStdinCommand(path, "base64 -d"), Readable.from([base64]));
      if (res.exitCode !== 0) throw new Error(`uploadBinary ${path}: ${res.stderr}`);
    },
  };
}

/** argv piping stdin through `filter` into `path`, creating missing parent directories. */
export function writeStdinCommand(path: string, filter = "cat"): string[] {
  const dir = posixDirname(path);
  return ["sh", "-c", `mkdir -p ${shellQuote(dir)} && ${filter} > ${shellQuote(path)}`];
}

/** POSIX dirname for sandbox-absolute paths. */
function posixDirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? (i === 0 ? "/" : ".") : p.slice(0, i);
}

/** Build the argv for an ExecRequest as a `sh -c` invocation: argv form (command + args) is shell-quoted per token, while a bare command with no args is already a shell line and passes through verbatim. */
function wrapCommand(req: ExecRequest): string[] {
  const envPrefix = req.env
    ? Object.entries(req.env).map(([k, v]) => `${k}=${shellQuote(v)}`)
    : [];
  const inner =
    req.args.length === 0
      ? req.command // already a shell line
      : [req.command, ...req.args].map(shellQuote).join(" ");
  const cd = req.cwd ? `cd ${shellQuote(req.cwd)} && ` : "";
  const assigns = envPrefix.length ? `${envPrefix.join(" ")} ` : "";
  return ["sh", "-c", `${cd}${assigns}${inner}`];
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function defaultKubeConfig(): KubeConfig {
  const kc = new KubeConfig();
  if (existsSync("/var/run/secrets/kubernetes.io/serviceaccount/token")) {
    kc.loadFromCluster();
  } else {
    kc.loadFromDefault();
  }
  return kc;
}

// Re-export for symmetry with the fake.
export type { SandboxApiClient };
export { PassThrough };
