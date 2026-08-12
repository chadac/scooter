/**
 * k8sConversationRegistry — the CR-writing ConversationRegistry for multi-replica mode.
 *
 * On register() it creates a `Conversation` CR (scooter.chadac.dev/v1alpha1) named by the
 * conversation id, with the spec fields the controller/router key on. Idempotent (409
 * AlreadyExists => no-op) and swallowing: any other k8s error is logged, not thrown, so a
 * conversation still starts locally. Only constructed when POD_NAME is set; single-replica
 * agent-host uses noopRegistry.
 *
 * We create the CR without status — the controller owns status (it patches hostPod /
 * generation via the status subresource). We do NOT set status.hostPod to self here: the
 * controller is the single assigner, and self-assigning would race its load accounting.
 */

import { KubeConfig, CustomObjectsApi, setHeaderOptions, PatchStrategy } from "@kubernetes/client-node";

import type { ConversationRegistry, ConversationSpec, ConversationPhase } from "./conversationRegistry.js";

const GROUP = "scooter.chadac.dev";
const VERSION = "v1alpha1";
const PLURAL = "conversations";

/**
 * Build a registry that creates Conversation CRs in `namespace`. `kc` defaults to the
 * in-cluster config. The CR name is the conversation id (a DNS-safe UUID/threadId).
 */
export function createK8sConversationRegistry(
  namespace: string,
  kc?: KubeConfig,
): ConversationRegistry {
  const config = kc ?? loadKubeConfig();
  const custom = config.makeApiClient(CustomObjectsApi);

  return {
    async register(id: string, spec: ConversationSpec): Promise<void> {
      // Drop undefined fields — the CRD schema tolerates a partial spec, and an explicit
      // `undefined` value serializes to nothing useful.
      const cleanSpec: Record<string, string> = {};
      if (spec.model) cleanSpec.model = spec.model;
      if (spec.owner) cleanSpec.owner = spec.owner;
      if (spec.parentId) cleanSpec.parentId = spec.parentId;
      if (spec.sandboxRef) cleanSpec.sandboxRef = spec.sandboxRef;

      await custom
        .createNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace,
          plural: PLURAL,
          body: {
            apiVersion: `${GROUP}/${VERSION}`,
            kind: "Conversation",
            metadata: { name: id, namespace },
            spec: cleanSpec,
          },
        })
        .catch((e: { code?: number }) => {
          // 409 AlreadyExists = the CR is already registered (a re-start() after revive,
          // or another pod raced us). That's the idempotent happy path — swallow it. Any
          // OTHER error must not fail the conversation: log it and continue. The guard
          // fails open for an unregistered conversation, so the only cost is that it pins
          // to the default pod until a later register() (or the controller) creates the CR.
          if (e?.code === 409) return;
          console.error(`[conversationRegistry] failed to create Conversation CR ${id}:`, e);
        });
    },

    async setPhase(id: string, phase: ConversationPhase): Promise<void> {
      // Publish the liveness transition to status.phase (the status SUBRESOURCE — same as the
      // controller patches). A merge patch of just {phase} leaves hostPod/hostIP/generation
      // untouched. Never throws: a 404 (CR gone / not created yet) or any error is logged and
      // swallowed — a failed publish only means the kubectl view lags, never blocks suspend.
      await custom
        .patchNamespacedCustomObjectStatus(
          { group: GROUP, version: VERSION, namespace, plural: PLURAL, name: id, body: { status: { phase } } },
          setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
        )
        .catch((e: { code?: number }) => {
          if (e?.code === 404) return; // CR not there (yet) — nothing to update.
          console.error(`[conversationRegistry] failed to set phase=${phase} on ${id}:`, e);
        });
    },
  };
}

function loadKubeConfig(): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromCluster();
  return kc;
}
