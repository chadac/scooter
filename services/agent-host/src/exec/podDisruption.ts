/** Explains, from the sandbox pod's status, why a running command was cut off. */

import type { V1Pod } from "@kubernetes/client-node";

const KEPT = "Every running process was killed; files under /workspace were kept.";

// DisruptionTarget condition reasons, in words an agent can act on.
const DISRUPTION_REASONS: Record<string, string> = {
  EvictionByEvictionAPI: "it was evicted (a node drain or consolidation)",
  PreemptionByScheduler: "the scheduler preempted it for a higher-priority pod",
  DeletionByTaintManager: "its node became unreachable",
  TerminationByKubelet: "its node shut down or ran short of resources",
};

/** The sandbox disruption since `since`, as a note for the agent; undefined when there was none. */
export function describeSandboxDisruption(pod: V1Pod | undefined, container: string, since: Date): string | undefined {
  if (!pod) {
    return `The sandbox pod was deleted while this ran (its node was lost, or Scooter stopped the sandbox). ${KEPT}`;
  }
  const target = pod.status?.conditions?.find((c) => c.type === "DisruptionTarget" && c.status === "True");
  if (pod.metadata?.deletionTimestamp || target || pod.status?.reason === "Evicted") {
    const why =
      (target?.reason && DISRUPTION_REASONS[target.reason]) ??
      (pod.status?.reason === "Evicted" ? `it was evicted: ${pod.status.message ?? "no message"}` : undefined) ??
      "it is being deleted (Scooter stopped the sandbox, or a node drain)";
    return `The sandbox pod was shut down because ${why}. ${KEPT}`;
  }
  const status = pod.status?.containerStatuses?.find((c) => c.name === container);
  const term = status?.lastState?.terminated;
  // finishedAt has second precision, so allow a little clock skew.
  if (!term?.finishedAt || new Date(term.finishedAt).getTime() < since.getTime() - 2_000) return undefined;
  if (term.reason === "OOMKilled") {
    const limit = pod.spec?.containers?.find((c) => c.name === container)?.resources?.limits?.memory;
    return (
      `The sandbox ran out of memory${limit ? ` (limit ${limit})` : ""}: the kernel OOM-killed the whole sandbox ` +
      `container and it restarted. ${KEPT} Use less memory, or raise the limit with set_sandbox_resources.`
    );
  }
  return (
    `The sandbox container restarted (reason ${term.reason ?? "unknown"}, exit code ${term.exitCode}), ` +
    `most likely a node or container-runtime restart rather than your command. ${KEPT}`
  );
}
