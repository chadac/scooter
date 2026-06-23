/**
 * Cluster fixture — provider-agnostic local/remote Kubernetes for Tier 2.
 *
 * Targets whatever the current kubeconfig points at (cluster-up.sh brings up the
 * cluster; this just connects). Cluster-agnostic; k3s is the default provider.
 *
 *   CLUSTER_PROVIDER  = existing | k3s | kind | minikube | k3d   (default: k3s)
 *   RUN_CLUSTER_TESTS = 1  to enable Tier 2 at all
 */

import { setTimeout as sleep } from "node:timers/promises";

import {
  KubeConfig,
  CoreV1Api,
  CustomObjectsApi,
  KubernetesObjectApi,
  Exec,
  type V1Status,
} from "@kubernetes/client-node";
import { Writable } from "node:stream";

export type ClusterProvider = "existing" | "k3s" | "kind" | "minikube" | "k3d";

export interface Cluster {
  readonly provider: ClusterProvider;
  apply(manifest: object): Promise<void>;
  get<T = unknown>(kind: string, name: string, namespace?: string): Promise<T>;
  waitFor<T = unknown>(
    kind: string,
    name: string,
    predicate: (r: T) => boolean,
    timeoutMs?: number,
    namespace?: string,
  ): Promise<T>;
  exec(
    podSelector: string,
    command: string[],
    namespace?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface ClusterFixtureOptions {
  namespace?: string;
  installController?: boolean;
  sandboxImage?: string;
}

export function clusterTestsEnabled(): boolean {
  return process.env.RUN_CLUSTER_TESTS === "1";
}

const provider = (): ClusterProvider =>
  (process.env.CLUSTER_PROVIDER as ClusterProvider) ?? "k3s";

// Map a CRD/core "kind" to its REST coordinates. Extend as tests need.
const RESOURCES: Record<string, { group: string; version: string; plural: string; core?: boolean }> = {
  Sandbox: { group: "agents.x-k8s.io", version: "v1beta1", plural: "sandboxes" },
  SandboxWarmPool: { group: "extensions.agents.x-k8s.io", version: "v1beta1", plural: "sandboxwarmpools" },
  SandboxClaim: { group: "extensions.agents.x-k8s.io", version: "v1beta1", plural: "sandboxclaims" },
  ServiceAccount: { group: "", version: "v1", plural: "serviceaccounts", core: true },
  PersistentVolumeClaim: { group: "", version: "v1", plural: "persistentvolumeclaims", core: true },
};

export async function withCluster(opts: ClusterFixtureOptions = {}): Promise<Cluster> {
  const namespace = opts.namespace ?? "agent-sandbox-test";
  const kc = new KubeConfig();
  kc.loadFromDefault();

  const core = kc.makeApiClient(CoreV1Api);
  const custom = kc.makeApiClient(CustomObjectsApi);
  const objects = KubernetesObjectApi.makeApiClient(kc);
  const execClient = new Exec(kc);

  const getResource = async <T>(kind: string, name: string, ns: string): Promise<T> => {
    const r = RESOURCES[kind];
    if (!r) throw new Error(`unknown kind: ${kind}`);
    if (r.core) {
      const fn =
        kind === "ServiceAccount"
          ? core.readNamespacedServiceAccount({ name, namespace: ns })
          : core.readNamespacedPersistentVolumeClaim({ name, namespace: ns });
      return (await fn) as T;
    }
    return (await custom.getNamespacedCustomObject({
      group: r.group,
      version: r.version,
      namespace: ns,
      plural: r.plural,
      name,
    })) as T;
  };

  const podNameForSelector = async (selector: string, ns: string): Promise<string> => {
    const pods = await core.listNamespacedPod({ namespace: ns, labelSelector: selector });
    const running = pods.items.find((p) => p.status?.phase === "Running") ?? pods.items[0];
    if (!running?.metadata?.name) throw new Error(`no pod for selector ${selector}`);
    return running.metadata.name;
  };

  return {
    provider: provider(),

    async apply(manifest: object) {
      // Server-side apply for any object (CRDs included).
      await objects.patch(manifest as never, undefined, undefined, "agent-sandbox-tests", true, {
        headers: { "Content-Type": "application/apply-patch+yaml" },
      } as never).catch(async () => {
        // Fall back to create if the object doesn't exist yet.
        await objects.create(manifest as never);
      });
    },

    get(kind, name, ns = namespace) {
      return getResource(kind, name, ns);
    },

    async waitFor(kind, name, predicate, timeoutMs = 120_000, ns = namespace) {
      const deadline = Date.now() + timeoutMs;
      let last: unknown;
      while (Date.now() < deadline) {
        try {
          last = await getResource(kind, name, ns);
          if (predicate(last as never)) return last as never;
        } catch {
          /* not found yet */
        }
        await sleep(2000);
      }
      throw new Error(`waitFor ${kind}/${name} timed out after ${timeoutMs}ms`);
    },

    async exec(podSelector, command, ns = namespace) {
      const pod = await podNameForSelector(podSelector, ns);
      let stdout = "";
      let stderr = "";
      let exitCode = 0;
      const outS = new Writable({ write(c, _e, cb) { stdout += c.toString(); cb(); } });
      const errS = new Writable({ write(c, _e, cb) { stderr += c.toString(); cb(); } });
      await new Promise<void>((resolve, reject) => {
        execClient
          .exec(ns, pod, "sandbox", command, outS, errS, null, false, (s: V1Status) => {
            if (s.status !== "Success") {
              const cause = s.details?.causes?.find((c) => c.reason === "ExitCode");
              exitCode = cause?.message ? Number(cause.message) : 1;
            }
          })
          .then((ws) => {
            ws.on("close", () => resolve());
            ws.on("error", reject);
          })
          .catch(reject);
      });
      return { stdout, stderr, exitCode };
    },
  };
}
