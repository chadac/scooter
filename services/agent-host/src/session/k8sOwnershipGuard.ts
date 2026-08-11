/**
 * k8sOwnershipGuard — wires an OwnershipTracker to a live WATCH of the Conversation CRD,
 * so the fencing decision (ownershipGuard.canWrite) reflects the current status.hostPod /
 * generation with no per-append k8s call. Used only in multi-replica mode (POD_NAME set);
 * single-replica agent-host uses allowAllGuard and never constructs this.
 */

import { KubeConfig, Watch } from "@kubernetes/client-node";

import { OwnershipTracker } from "./ownershipGuard.js";

const GROUP = "scooter.chadac.dev";
const VERSION = "v1alpha1";
const PLURAL = "conversations";

interface ConversationCR {
  metadata?: { name?: string };
  status?: { hostPod?: string; generation?: number };
}

/**
 * Build the tracker for `selfPod` and start watching Conversations in `namespace`. The
 * watch reconnects on close. Returns the tracker (an OwnershipGuard) + a stop() to end
 * the watch on shutdown. `kc` defaults to the in-cluster config.
 */
export function createK8sOwnershipGuard(
  selfPod: string,
  namespace: string,
  kc?: KubeConfig,
): { guard: OwnershipTracker; stop: () => void } {
  const config = kc ?? loadKubeConfig();
  const tracker = new OwnershipTracker(selfPod);
  const watch = new Watch(config);
  let aborted = false;
  let req: { abort: () => void } | undefined;

  const onEvent = (type: string, obj: ConversationCR) => {
    const name = obj.metadata?.name;
    if (!name) return;
    if (type === "DELETED") {
      tracker.observe(name, null);
      return;
    }
    const hostPod = obj.status?.hostPod;
    const generation = obj.status?.generation;
    // Only record a real assignment; an un-assigned CR (no hostPod) leaves it unobserved
    // (fail-open) until the controller assigns one.
    if (hostPod && typeof generation === "number") {
      tracker.observe(name, { hostPod, generation });
    } else {
      tracker.observe(name, null);
    }
  };

  const start = () => {
    if (aborted) return;
    watch
      .watch(
        `/apis/${GROUP}/${VERSION}/namespaces/${namespace}/${PLURAL}`,
        {},
        onEvent as (type: string, obj: unknown) => void,
        // Reconnect on any close/error (watches expire); back off a touch.
        () => { if (!aborted) setTimeout(start, 1000); },
      )
      .then((r) => { req = r as { abort: () => void }; })
      .catch(() => { if (!aborted) setTimeout(start, 2000); });
  };
  start();

  return {
    guard: tracker,
    stop: () => { aborted = true; req?.abort?.(); },
  };
}

function loadKubeConfig(): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromCluster();
  return kc;
}
