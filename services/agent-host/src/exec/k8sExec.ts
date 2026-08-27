/**
 * Production SandboxApiClient over the Kubernetes exec API (pods/exec).
 *
 * No in-pod server: commands run via the exec subresource, like upstream
 * examples/sandboxed-tools. `run`/`spawn` exec directly; file ops use cat / tee.
 *
 * Requires `get,create pods/exec` (+ get pods) RBAC — the WS exec upgrade is an HTTP GET on the agent-host SA.
 */

import { Writable, Readable, PassThrough } from "node:stream";
import { debugError } from "../debug.js";
import { logger } from "../log.js";
import { existsSync } from "node:fs";

import { KubeConfig, Exec, CoreV1Api, type V1Status } from "@kubernetes/client-node";

import type { ExecRequest, ExecResult, SandboxRef } from "../types.js";
import type { SandboxApiClient } from "./sandboxExec.js";

const log = logger("k8sExec");

const SANDBOX_LABEL = "agents.x-k8s.io/sandbox-name";

const DEFAULT_CONTAINER = "sandbox";

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

export interface K8sExecOptions {
  kubeConfig?: KubeConfig;
  container?: string;
  /** Explicit pod name; otherwise resolved from the Sandbox's labelled pod. */
  podName?: string;
  /** Self-heal a suspended sandbox: if the pod-readiness poll finds NO pod at all, the sandbox may
   *  have been idle-SUSPENDED (operatingMode=Suspended, pod deleted) out from under a still-live
   *  bridge — the mid-run-reassign case where bridge-liveness and pod-liveness diverge. Called ONCE
   *  when the first lookup is empty to resume it (idempotent `provisioner.resume`), then the poll
   *  picks up the recreated pod instead of timing out with "no ready pod". Absent = no self-heal. */
  ensureRunning?: () => Promise<void>;
}

/**
 * Resolves a SandboxRef to a connected pod-exec client. Looks up the Sandbox's
 * backing pod (the controller labels it with the sandbox name).
 */
export async function connectSandbox(
  ref: SandboxRef,
  opts: K8sExecOptions = {},
): Promise<SandboxApiClient> {
  const kc = opts.kubeConfig ?? defaultKubeConfig();
  // Prefer a pod name the CALLER already knows (the broker provisioner returns the
  // ready pod name on ensure/resume — the agent-sandbox controller names the pod
  // after the Sandbox, so ref.name IS the pod name). That lets the agent-host exec
  // WITHOUT `get/list pods` RBAC. Fall back to the k8s label lookup (legacy k8s
  // provisioner path, whose ref carries no podIP).
  const podName = opts.podName ?? (ref.podIP ? ref.name : await resolvePodName(kc, ref, opts.ensureRunning));
  return createK8sSandboxApiClient(ref, { ...opts, kubeConfig: kc, podName });
}

/** The conversation pod's address for direct in-cluster HTTP/WS (the web-service
 *  reverse proxy targets this). `podIP` changes across suspend/resume — never
 *  cache it across a suspend; re-resolve. */
export interface PodTarget {
  name: string;
  podIP: string;
}

type Pod = Awaited<ReturnType<CoreV1Api["readNamespacedPod"]>>;

/** Options for the ready-pod poll — injectable so the self-heal logic is unit-testable without a
 *  real k8s client. `listCandidates` returns the current pods for the ref; `sleep` + `deadlineMs`
 *  let a test collapse the poll. */
export interface ResolveReadyPodDeps {
  listCandidates: () => Promise<Pod[]>;
  ensureRunning?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  deadlineMs?: number;
}

/** Poll until a RUNNING + Ready pod backs the sandbox (the pure/injectable core). Fires
 *  `ensureRunning` ONCE if the first lookup finds no pod at all — the idle-suspend self-heal. */
export async function pollForReadyPod(ref: SandboxRef, deps: ResolveReadyPodDeps): Promise<Pod> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const started = Date.now();
  const deadline = started + (deps.deadlineMs ?? 90_000);
  let lastRunning: Pod | undefined;
  let healed = false; // ensureRunning is fired at most once
  let waitLogged = false; // one "waiting" line per call, not one per poll
  for (;;) {
    const candidates = await deps.listCandidates();
    // SELF-HEAL: no pod at all → the sandbox may be idle-SUSPENDED (mode=Suspended, pod deleted) out
    // from under a live bridge. Resume it ONCE (idempotent) so the controller recreates the pod, then
    // keep polling for it instead of timing out with "no ready pod". Without this, a mid-run-reassign +
    // idle-suspend leaves the pod gone while the bridge issues tool calls that all fail.
    if (candidates.length === 0 && deps.ensureRunning && !healed) {
      healed = true;
      // LOUD. This resume is load-bearing for a live bridge — but fired against a
      // just-suspended sandbox (a racing sweeper's probe) it is the destructive half
      // of the zombie-sandbox bug: the resume lands last, the conversation is evicted
      // everywhere, and the pod runs forever. Success was previously silent, which is
      // why 9-12h zombies had no trace of WHO woke them.
      log.warn("resume-on-missing-pod: resuming the sandbox (idle-suspend self-heal)", {
        namespace: ref.namespace,
        pod_name: ref.name,
      });
      try {
        await deps.ensureRunning();
      } catch (err) {
        log.errorWith("resume-on-missing-pod failed", err, {
          namespace: ref.namespace,
          pod_name: ref.name,
        });
        // 404 = the Sandbox CR itself is GONE (the conversation was deleted or its
        // sandbox reaped). No amount of polling brings it back — fail NOW instead of
        // spinning to the deadline, so callers (job sweeps, tool calls) see a fast,
        // classifiable failure rather than a 90s hang per attempt.
        if ((err as { code?: number }).code === 404) {
          throw new Error(`sandbox ${ref.namespace}/${ref.name} is gone (404 on resume)`);
        }
      }
      await sleep(1500);
      continue; // re-poll: the pod is now being recreated
    }
    const ready = candidates.find(
      (p) =>
        p.status?.phase === "Running" &&
        (p.status?.containerStatuses ?? []).every((c) => c.ready),
    );
    if (ready?.metadata?.name) {
      const waitedMs = Date.now() - started;
      // A wait that spanned more than one poll is the latency the caller's turn is
      // eating — record it (this was invisible: a 60s boot-wait looked identical to
      // an instant hit, and CI hangs died with no trace of WHICH stage ate the time).
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
    if (Date.now() > deadline) {
      // Fall back to any Running pod (or fail) rather than hang forever.
      log.warn("ready-pod deadline expired", {
        namespace: ref.namespace,
        sandbox: ref.name,
        waited_ms: Date.now() - started,
        falling_back_to: lastRunning?.metadata?.name ?? null,
      });
      if (lastRunning) return lastRunning;
      throw new Error(`no ready pod for sandbox ${ref.namespace}/${ref.name}`);
    }
    await sleep(1500);
  }
}

/** Poll until a RUNNING + Ready pod backs the sandbox, returning the pod object.
 *  A freshly-provisioned sandbox may still be ContainerCreating when the first
 *  request arrives; exec'ing / proxying to a not-ready pod fails, so we wait. */
async function resolveReadyPod(
  kc: KubeConfig,
  ref: SandboxRef,
  ensureRunning?: () => Promise<void>,
): Promise<Pod> {
  const core = kc.makeApiClient(CoreV1Api);
  return pollForReadyPod(ref, {
    ensureRunning,
    // Try both the label selector (v0.4.x) and direct pod name lookup (v0.5.0+ where the controller
    // names the pod after the Sandbox but may not propagate podTemplate labels).
    listCandidates: async () => {
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
    },
  });
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

/** Resolve a sandbox to its pod name + routable pod IP, for the web-service
 *  reverse proxy (which HTTPs directly to podIP:port). Same 90s ready-poll as
 *  exec. Throws if no ready pod, or a ready pod with no assigned IP. */
export async function resolvePodTarget(
  ref: SandboxRef,
  opts: { kubeConfig?: KubeConfig } = {},
): Promise<PodTarget> {
  // When the caller already knows the pod IP (the broker provisioner returned it on
  // ensure/resume), use it directly — no `get pods` needed. The legacy k8s path has
  // no podIP on the ref, so it falls through to the label lookup.
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

  // Build a fresh Exec per call. In-cluster the projected SA token ROTATES
  // (~1h on EKS); the client-node Exec WebSocket caches user.token from the
  // KubeConfig at construction, so a long-lived, reused Exec starts 403-ing on
  // the pods/exec upgrade once the cached token expires. Re-reading the config
  // (cheap — it just reads the token file) picks up the current token each time.
  // An explicitly-injected kubeConfig (tests) is reused as-is.
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
      // ── STALL WATCHDOG. The two silent-forever failure modes here are (a) the
      // pods/exec UPGRADE request that a starved kubelet never answers (exec()'s
      // promise never settles) and (b) a WS that opens but never receives a close
      // frame. Without a timeout or log line, a hung tool call would produce nothing.
      // The watchdog names the stage a still-running exec is stuck in; it never kills
      // anything (a legitimately long command must stay legal), it just refuses to be silent.
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
      /** The WebSocket close frame, kept so a failure that surfaces as a property-less
       *  event still has something diagnosable attached to its log line. */
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
          // Honor a cancel: closing the pods/exec WebSocket tears down the remote
          // exec (SIGTERM/HUP to its process). Retained so kill()/abort can end a
          // long-running command mid-flight (the whole point of cancel).
          const onAbort = () => {
            try {
              (ws as { close?: () => void }).close?.();
            } catch {
              /* already closing */
            }
            // Do NOT wait for the close handshake. kubelet keeps the exec'd process
            // running after a client disconnect and may not ack the close until that
            // process exits — so a kill() of `sh -c sleep 20` left waitForExit hanging
            // ~20s on a real cluster while the fake stack (local subprocess, instant
            // SIGTERM) resolved immediately. The agent then never finished its turn and
            // Stop looked dead — the last two Tier-2 failures. The caller asked for the
            // command to END; from its point of view it has: resolve now (130), and
            // force the socket down so nothing leaks.
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
          // Capture the close code/reason on the way past. When the socket dies, the value
          // reaching the error/catch paths below can be an event with NO own properties —
          // which is why this logged a bare `{}` in production even though it ALREADY used
          // getOwnPropertyNames. Serialization was never the problem; there was nothing to
          // serialize. The close frame is the detail that was being thrown away here.
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
            resolve({
              stdout: out.text(),
              stderr: err.text(),
              exitCode: exit_code,
            });
          });
          ws.on("error", (e: unknown) => {
            settle();
            log.errorWith("ws error", e, lastClose ? { ws_close: lastClose } : {});
            reject(e);
          });
        })
        .catch((e: unknown) => {
          settle();
          log.errorWith("exec() rejected", e, lastClose ? { ws_close: lastClose } : {});
          reject(e);
        });
    });

  return {
    mode: "k8s-exec",

    execute(req: ExecRequest, signal?: AbortSignal): Promise<ExecResult> {
      const cmd = wrapCommand(req);
      return execRaw(cmd, undefined, signal);
    },

    async download(path: string): Promise<string> {
      const res = await execRaw(["cat", path]);
      if (res.exitCode !== 0) throw new Error(`download ${path}: ${res.stderr}`);
      return res.stdout;
    },

    async upload(path: string, content: string): Promise<void> {
      const stdin = Readable.from([content]);
      // `tee <path> >/dev/null` writes stdin to the file.
      const res = await execRaw(["sh", "-c", `tee ${shellQuote(path)} >/dev/null`], stdin);
      if (res.exitCode !== 0) throw new Error(`upload ${path}: ${res.stderr}`);
    },
  };
}

/**
 * Build the argv for an ExecRequest as a `sh -c` invocation.
 *
 * Two input shapes:
 *  - argv form: command + args[] are separate tokens -> shell-quote each so they
 *    pass through literally.
 *  - shell-string form: command is a whole shell line (pipes, redirects, &&) and
 *    args is empty -> it is ALREADY shell syntax, so DON'T requote it (quoting
 *    the whole line makes the shell try to run one program literally named
 *    "echo X > f && cat f"). goose's ACP terminal sends this form.
 */
function wrapCommand(req: ExecRequest): string[] {
  const envPrefix = req.env
    ? Object.entries(req.env).map(([k, v]) => `${k}=${shellQuote(v)}`)
    : [];
  const inner =
    req.args.length === 0
      ? req.command // already a shell line — pass through verbatim
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
