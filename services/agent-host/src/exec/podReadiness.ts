/**
 * Tracks, per sandbox, a readiness poll that is waiting on a pod that isn't Ready,
 * so a command that times out before reaching the pod says it never started (rather
 * than "narrow your command"), and conversation_status doesn't report a bare "running".
 * Both also say why, from the pod's status and events (see podDiagnosis.ts).
 */

import type { SandboxRef } from "../types.js";

/** A readiness poll that hasn't found a Ready pod. */
export interface PodWaitStatus {
  /** When the poll started waiting (ms since epoch). */
  since: number;
  /** When the poll last saw the pod not Ready; a wait not seen for STALE_MS is dropped. */
  checkedAt: number;
  /** Why the pod isn't Ready, e.g. "pod Pending (ContainerCreating); FailedAttachVolume: …". */
  reason?: string;
}

/** A failed wait is kept this long for conversation_status, then forgotten. */
const STALE_MS = 5 * 60_000;

const waits = new Map<string, PodWaitStatus>();
const key = (ref: Pick<SandboxRef, "namespace" | "name">) => `${ref.namespace}/${ref.name}`;

/** The not-ready wait on `ref`, or undefined when its pod was last seen Ready (or not checked lately). */
export function podWaitStatus(
  ref: Pick<SandboxRef, "namespace" | "name">,
  now: number = Date.now(),
): PodWaitStatus | undefined {
  const w = waits.get(key(ref));
  if (w && now - w.checkedAt > STALE_MS) {
    waits.delete(key(ref));
    return undefined;
  }
  return w;
}

export function setPodWaitStatus(ref: Pick<SandboxRef, "namespace" | "name">, status: PodWaitStatus | undefined): void {
  if (status) waits.set(key(ref), status);
  else waits.delete(key(ref));
}

/** "12m", "45s". */
function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 120 ? `${Math.round(s / 60)}m` : `${s}s`;
}

/** The wait as one line for an agent: "the sandbox pod has not been Ready for 40s". */
export function formatPodWait(status: PodWaitStatus, now: number = Date.now()): string {
  const why = status.reason ? ` (${status.reason})` : "";
  return `the sandbox pod has not been Ready for ${age(now - status.since)}${why}`;
}
