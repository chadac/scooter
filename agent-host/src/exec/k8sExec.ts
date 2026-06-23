/**
 * Production SandboxApiClient over the Kubernetes exec API (pods/exec).
 *
 * No in-pod server: commands run via the exec subresource, like upstream
 * examples/sandboxed-tools. `run`/`spawn` exec directly; file ops use cat / tee.
 *
 * Requires `create pods/exec` (+ get pods) RBAC on the agent-host SA.
 */

import { Writable, Readable, PassThrough } from "node:stream";

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
  const pods = await core.listNamespacedPod({
    namespace: ref.namespace,
    labelSelector: `${SANDBOX_LABEL}=${ref.name}`,
  });
  const running = pods.items.find((p) => p.status?.phase === "Running");
  const pod = running ?? pods.items[0];
  if (!pod?.metadata?.name) {
    throw new Error(`no pod found for sandbox ${ref.namespace}/${ref.name}`);
  }
  return pod.metadata.name;
}

export function createK8sSandboxApiClient(
  ref: SandboxRef,
  opts: K8sExecOptions = {},
): SandboxApiClient {
  const kc = opts.kubeConfig ?? defaultKubeConfig();
  const exec = new Exec(kc);
  const container = opts.container ?? DEFAULT_CONTAINER;
  const podName = opts.podName ?? ref.name;

  const execRaw = (
    command: string[],
    stdin?: Readable,
  ): Promise<ExecResult> =>
    new Promise((resolve, reject) => {
      const out = sink();
      const err = sink();
      let status: V1Status | undefined;
      exec
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
          ws.on("error", reject);
        })
        .catch(reject);
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

/** Build the argv for an ExecRequest, honoring cwd/env without a shell when possible. */
function wrapCommand(req: ExecRequest): string[] {
  const envPrefix = req.env
    ? Object.entries(req.env).map(([k, v]) => `${k}=${shellQuote(v)}`)
    : [];
  const inner = [req.command, ...req.args].map(shellQuote).join(" ");
  const cd = req.cwd ? `cd ${shellQuote(req.cwd)} && ` : "";
  const assigns = envPrefix.length ? `${envPrefix.join(" ")} ` : "";
  return ["sh", "-c", `${cd}${assigns}${inner}`];
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function defaultKubeConfig(): KubeConfig {
  const kc = new KubeConfig();
  // In-cluster when running as the agent-host pod; falls back to local kubeconfig.
  try {
    kc.loadFromCluster();
  } catch {
    kc.loadFromDefault();
  }
  return kc;
}

// Re-export for symmetry with the fake.
export type { SandboxApiClient };
export { PassThrough };
