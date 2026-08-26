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

import { logger } from "../log.js";

const log = logger("conversationRegistry");

import type {
  ConversationRegistry,
  ConversationSpec,
  ConversationPhase,
  ConversationRecord,
} from "./conversationRegistry.js";

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
      if (spec.creatorPod) cleanSpec.creatorPod = spec.creatorPod;

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
        .catch(async (e: { code?: number }) => {
          // 409 AlreadyExists = the CR is already there. That is now the COMMON case, not a
          // rare race: the router creates the CR (POST /conversations) with no sandboxRef,
          // because it does not provision. Swallowing the 409 meant the fields the host owns
          // — above all sandboxRef, which the router derives its routing short-id from —
          // could never be written, so a router-created conversation stayed unroutable.
          // Merge-patch the spec instead. Merge (not replace) so we only add our own fields
          // and leave owner/model/parentId as the creator set them.
          if (e?.code === 409) {
            await custom
              .patchNamespacedCustomObject(
                { group: GROUP, version: VERSION, namespace, plural: PLURAL, name: id, body: { spec: cleanSpec } },
                setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
              )
              .catch((pe: { code?: number }) => {
                if (pe?.code === 404) return; // deleted between create and patch
                log.errorWith("failed to patch Conversation CR", pe, { conversation_id: id });
              });
            return;
          }
          // Any OTHER error must not fail the conversation: log it and continue. The guard
          // fails open for an unregistered conversation, so the only cost is that it pins
          // to the default pod until a later register() (or the controller) creates the CR.
          log.errorWith("failed to create Conversation CR", e, { conversation_id: id });
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
          log.errorWith("failed to set phase", e, { conversation_id: id, phase });
        });
    },

    async remove(id: string): Promise<void> {
      // DELETE the CR. Without this the conversation comes BACK: end() clears local state
      // and the store record, but hydrate() re-adopts any surviving CR, so a deleted
      // conversation reappears in GET /conversations forever (observed on a real cluster,
      // with DELETE answering 204 the whole time).
      //
      // Never throws, matching the other write methods — a k8s failure must not turn a
      // successful local delete into a 500. A 404 means someone else already removed it,
      // which is the desired end state, so it is not an error.
      await custom
        .deleteNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace,
          plural: PLURAL,
          name: id,
        })
        .catch((e: { code?: number }) => {
          if (e?.code === 404) return; // already gone — that is the outcome we wanted
          log.errorWith("failed to delete the Conversation CR (it will be re-adopted)", e, {
            conversation_id: id,
          });
        });
    },

    async list(): Promise<ConversationRecord[]> {
      // THROWS on failure, unlike the write methods. The CR list is the source of truth for
      // "which conversations exist?"; a caller that gets [] because the apiserver was briefly
      // unreachable would conclude this pod owns nothing and serve blind. Boot retries with
      // backoff and fails readiness instead (decision Q4, docs/CONVERSATION_STATE_MODEL.md).
      const resp = await custom.listNamespacedCustomObject({
        group: GROUP,
        version: VERSION,
        namespace,
        plural: PLURAL,
      });
      const items = (resp as { items?: unknown[] })?.items ?? [];
      return items.map((o) => toRecord(o)).filter((r): r is ConversationRecord => r !== undefined);
    },

    async get(id: string): Promise<ConversationRecord | undefined> {
      try {
        const obj = await custom.getNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace,
          plural: PLURAL,
          name: id,
        });
        return toRecord(obj);
      } catch (e) {
        // Absent is `undefined`, not an error — the caller asked whether it exists.
        if ((e as { code?: number })?.code === 404) return undefined;
        throw e;
      }
    },
  };
}

/** Map a raw CR to the host's view. Returns undefined for an object with no usable name. */
function toRecord(o: unknown): ConversationRecord | undefined {
  const cr = o as {
    metadata?: { name?: string };
    spec?: ConversationSpec;
    status?: { phase?: ConversationPhase; hostPod?: string; hostIP?: string; generation?: number };
  };
  const id = cr?.metadata?.name;
  if (!id) return undefined;
  return {
    id,
    spec: cr.spec ?? {},
    // status is absent entirely on a CR the controller has not reconciled yet.
    phase: cr.status?.phase,
    hostPod: cr.status?.hostPod,
    hostIP: cr.status?.hostIP,
    generation: cr.status?.generation,
  };
}

function loadKubeConfig(): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromCluster();
  return kc;
}
