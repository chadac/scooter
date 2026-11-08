/**
 * Says why a sandbox pod isn't Ready: its phase, the container's waiting reason, and the
 * latest Warning events on it (a stalled volume attach, a failed mount, no node fits).
 */

import type { CoreV1Api, CoreV1Event, V1Pod } from "@kubernetes/client-node";

/** Events shown per diagnosis, newest first. */
const MAX_EVENTS = 2;
/** Event messages longer than this are cut. */
const MAX_MESSAGE = 240;

const when = (e: CoreV1Event): number =>
  new Date(e.series?.lastObservedTime ?? e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp ?? 0).getTime();

const clip = (s: string): string => (s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE - 1)}…` : s);

/** The pod a wait is on: the live one, else whichever is left. */
function waitedPod(pods: V1Pod[]): V1Pod | undefined {
  return pods.find((p) => !p.metadata?.deletionTimestamp) ?? pods[0];
}

/** "pod Pending (ContainerCreating); FailedAttachVolume x12: AttachVolume.Attach failed …". */
export function describePodWait(pod: V1Pod | undefined, events: CoreV1Event[] = []): string {
  if (!pod) return "no pod exists";
  const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
  const waiting = statuses.map((c) => c.state?.waiting?.reason).find(Boolean);
  const unschedulable = pod.status?.conditions?.find((c) => c.type === "PodScheduled" && c.status === "False")?.reason;
  const detail = waiting ?? unschedulable;
  const terminating = pod.metadata?.deletionTimestamp ? ", terminating" : "";
  const head = `pod ${pod.status?.phase ?? "Unknown"}${detail ? ` (${detail})` : ""}${terminating}`;
  // One line per reason: the controller repeats the same warning on every retry.
  const latest = new Map<string, CoreV1Event>();
  for (const e of events) {
    if (e.type !== "Warning" || !e.reason) continue;
    const seen = latest.get(e.reason);
    if (!seen || when(e) > when(seen)) latest.set(e.reason, e);
  }
  const lines = [...latest.values()]
    .sort((a, b) => when(b) - when(a))
    .slice(0, MAX_EVENTS)
    .map((e) => `${e.reason}${(e.series?.count ?? e.count ?? 1) > 1 ? ` x${e.series?.count ?? e.count}` : ""}: ${clip((e.message ?? "").trim())}`);
  return [head, ...lines].join("; ");
}

/** Lists the pod's events; empty when they can't be read (no RBAC on older installs). */
async function podEvents(
  core: Pick<CoreV1Api, "listNamespacedEvent">,
  namespace: string,
  pod: V1Pod,
): Promise<CoreV1Event[]> {
  const { name, uid } = pod.metadata ?? {};
  if (!name) return [];
  const fieldSelector = [`involvedObject.kind=Pod`, `involvedObject.name=${name}`, uid && `involvedObject.uid=${uid}`]
    .filter(Boolean)
    .join(",");
  try {
    return (await core.listNamespacedEvent({ namespace, fieldSelector })).items ?? [];
  } catch {
    return [];
  }
}

/** Why the sandbox's pods aren't Ready, events included. */
export async function diagnosePodWait(
  core: Pick<CoreV1Api, "listNamespacedEvent">,
  namespace: string,
  pods: V1Pod[],
): Promise<string> {
  const pod = waitedPod(pods);
  return describePodWait(pod, pod ? await podEvents(core, namespace, pod) : []);
}
