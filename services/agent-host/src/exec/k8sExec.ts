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
import { existsSync } from "node:fs";

import { KubeConfig, Exec, CoreV1Api, type V1Status } from "@kubernetes/client-node";

import type { ExecRequest, ExecResult, SandboxRef } from "../types.js";
import type { SandboxApiClient } from "./sandboxExec.js";

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
  const podName = opts.podName ?? (await resolvePodName(kc, ref));
  return createK8sSandboxApiClient(ref, { ...opts, kubeConfig: kc, podName });
}

async function resolvePodName(kc: KubeConfig, ref: SandboxRef): Promise<string> {
  const core = kc.makeApiClient(CoreV1Api);
  // Wait for a RUNNING + Ready pod. A freshly-provisioned sandbox may still be
  // ContainerCreating when the agent's first tool call arrives; exec'ing a
  // not-ready pod fails (an empty-object WS rejection that surfaces as goose's
  // "terminal Internal error"). Poll briefly until the pod is execable.
  const deadline = Date.now() + 90_000;
  let lastName: string | undefined;
  for (;;) {
    const pods = await core.listNamespacedPod({
      namespace: ref.namespace,
      labelSelector: `${SANDBOX_LABEL}=${ref.name}`,
    });
    const ready = pods.items.find(
      (p) =>
        p.status?.phase === "Running" &&
        (p.status?.containerStatuses ?? []).every((c) => c.ready),
    );
    if (ready?.metadata?.name) return ready.metadata.name;
    lastName = pods.items.find((p) => p.status?.phase === "Running")?.metadata?.name ?? lastName;
    if (Date.now() > deadline) {
      // Fall back to any Running pod (or fail) rather than hang forever.
      if (lastName) return lastName;
      throw new Error(`no ready pod for sandbox ${ref.namespace}/${ref.name}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
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
  ): Promise<ExecResult> =>
    new Promise((resolve, reject) => {
      const out = sink();
      const err = sink();
      let status: V1Status | undefined;
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
          ws.on("close", () =>
            resolve({
              stdout: out.text(),
              stderr: err.text(),
              exitCode: exitCodeFromStatus(status),
            }),
          );
          ws.on("error", (e: unknown) => {
                        debugError(
              "[k8sExec] ws error:",
              e instanceof Error ? e.message : JSON.stringify(e, Object.getOwnPropertyNames(e ?? {})),
            );
            reject(e);
          });
        })
        .catch((e: unknown) => {
                    debugError(
            "[k8sExec] exec() rejected:",
            e instanceof Error ? `${e.message}\n${e.stack}` : JSON.stringify(e, Object.getOwnPropertyNames(e ?? {})),
          );
          reject(e);
        });
    });

  return {
    mode: "k8s-exec",

    execute(req: ExecRequest): Promise<ExecResult> {
      const cmd = wrapCommand(req);
      return execRaw(cmd);
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
