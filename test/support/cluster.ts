/**
 * Cluster fixture — provider-agnostic local/remote Kubernetes for Tier 2.
 *
 * Design stage: spec only. Targets the current kubectl context by default; can
 * bootstrap a local cluster. Cluster-agnostic by design (we don't lock to
 * minikube), but a local provider is provided first.
 *
 *   CLUSTER_PROVIDER = existing | k3s | kind | minikube | k3d   (default: k3s)
 *   RUN_CLUSTER_TESTS = 1  to enable Tier 2 at all
 *
 * k3s is the project default for local testing.
 */

export type ClusterProvider = "existing" | "k3s" | "kind" | "minikube" | "k3d";

export interface Cluster {
  readonly provider: ClusterProvider;
  readonly kubeconfig: string;
  /** Apply a manifest (YAML or structured) to the cluster. */
  apply(manifest: unknown): Promise<void>;
  /** kubectl get, typed. */
  get<T = unknown>(kind: string, name: string, namespace?: string): Promise<T>;
  /** Wait until predicate(resource) is true or timeout. */
  waitFor<T = unknown>(kind: string, name: string, predicate: (r: T) => boolean, timeoutMs?: number): Promise<T>;
  /** Port-forward a pod/svc port; returns a localhost URL. */
  portForward(target: string, port: number, namespace?: string): Promise<{ url: string; close: () => void }>;
  exec(podSelector: string, command: string[], namespace?: string): Promise<{ stdout: string; exitCode: number }>;
}

export interface ClusterFixtureOptions {
  /** Install the agent-sandbox controller before tests if absent. */
  installController?: boolean;
  /** Namespace to create/use. */
  namespace?: string;
  /** Sandbox image to use (default: the fake-acp-agent variant for determinism). */
  sandboxImage?: string;
}

/** Acquire a cluster per the env/provider; skips the suite if disabled. */
export declare function withCluster(opts?: ClusterFixtureOptions): Promise<Cluster>;

/** True when Tier 2 is enabled (RUN_CLUSTER_TESTS=1). */
export declare function clusterTestsEnabled(): boolean;
