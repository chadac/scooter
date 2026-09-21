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
 *
 * THROTTLING. The apiserver answers 429 under priority-and-fairness, and a 429 that is
 * treated as a plain failure is a LOST write — the phase never lands, the CR goes stale,
 * and the ownership fence reads a view that disagrees with reality. So every call here
 * retries a 429 (honouring `Retry-After`, else exponential backoff with jitter), and
 * setPhase additionally coalesces: it skips a phase already published and folds a burst
 * into the write in flight plus one final write. Nothing else is retried — a 404/409/500
 * means something other than "later".
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

/** How the apiserver's priority-and-fairness layer says "slow down". */
const TOO_MANY_REQUESTS = 429;
/** Total tries per call (the first plus 4 retries) — ~4s of backoff at worst, well inside
 *  the caller's tolerance, and every write here is already fire-and-forget. */
const DEFAULT_MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 8000;

/** Test seam: how the registry waits and how hard it retries. Production uses the
 *  defaults; a test injects an instant `sleep` so backoff is asserted, not endured. */
export interface RegistryRetryOptions {
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // A pending backoff must never be the reason the process stays alive.
    (t as unknown as { unref?: () => void }).unref?.();
  });

/**
 * The server's own `Retry-After`, in ms, when it sent one.
 *
 * Honouring it is the difference between backing off and guessing: under
 * priority-and-fairness the apiserver knows when the queue will have room, and a client
 * that retries on its own schedule is what turns a throttle into a storm. Both wire forms
 * are accepted (delta-seconds and an HTTP-date).
 */
export function retryAfterMs(e: unknown, now: number = Date.now()): number | undefined {
  const headers = (e as { headers?: Record<string, string | string[] | undefined> })?.headers;
  if (!headers) return undefined;
  const raw =
    headers["retry-after"] ?? headers["Retry-After"] ?? headers["RETRY-AFTER"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Exponential backoff with full jitter — without jitter every conversation in the fleet
 *  retries in lockstep and re-creates the burst that caused the 429. */
function backoffMs(attempt: number): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  return Math.round(ceiling * (0.5 + Math.random() / 2));
}

/**
 * Build a registry that creates Conversation CRs in `namespace`. `kc` defaults to the
 * in-cluster config. The CR name is the conversation id (a DNS-safe UUID/threadId).
 */
export function createK8sConversationRegistry(
  namespace: string,
  kc?: KubeConfig,
  retry: RegistryRetryOptions = {},
): ConversationRegistry {
  const config = kc ?? loadKubeConfig();
  const custom = config.makeApiClient(CustomObjectsApi);
  const maxAttempts = retry.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const sleep = retry.sleep ?? realSleep;

  /**
   * Run a k8s call, retrying ONLY on 429.
   *
   * A 429 is the apiserver saying "later", not "no" — retrying it is the difference
   * between a write that lands a moment late and one that is lost. Every other error
   * (404, 409, 500) is returned to the caller unchanged, so the existing handling of
   * those is untouched.
   */
  async function throttled<T>(op: string, id: string, call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (e) {
        const code = (e as { code?: number })?.code;
        if (code !== TOO_MANY_REQUESTS || attempt >= maxAttempts - 1) throw e;
        const serverAsked = retryAfterMs(e);
        const wait = serverAsked ?? backoffMs(attempt);
        log.warn("apiserver throttled a Conversation write; backing off", {
          conversation_id: id,
          operation: op,
          attempt: attempt + 1,
          wait_ms: wait,
          honored_retry_after: serverAsked !== undefined,
        });
        await sleep(wait);
      }
    }
  }

  /** The phase last SUCCESSFULLY published, per conversation. Re-publishing a phase the CR
   *  already carries is a write that can only fail or be throttled. */
  const published = new Map<string, ConversationPhase>();
  /** The in-flight status write per conversation, with at most one phase queued behind it.
   *  A burst collapses to the write in flight plus ONE write of the final value. */
  const phaseWrites = new Map<string, { inflight: Promise<void>; queued?: ConversationPhase }>();

  async function patchPhase(id: string, phase: ConversationPhase): Promise<void> {
    await throttled("setPhase", id, () =>
      custom.patchNamespacedCustomObjectStatus(
        { group: GROUP, version: VERSION, namespace, plural: PLURAL, name: id, body: { status: { phase } } },
        setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
      ),
    )
      .then(() => {
        published.set(id, phase);
      })
      .catch((e: { code?: number }) => {
        // Not recording `published` on failure is deliberate: the next setPhase must retry
        // rather than believe a phase that never landed.
        if (e?.code === 404) return; // CR not there (yet) — nothing to update.
        log.errorWith("failed to set phase", e, { conversation_id: id, phase });
      });
  }

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

      await throttled("register", id, () =>
        custom.createNamespacedCustomObject({
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
        }),
      )
        .catch(async (e: { code?: number }) => {
          // 409 AlreadyExists = the CR is already there. That is now the COMMON case, not a
          // rare race: the router creates the CR (POST /conversations) with no sandboxRef,
          // because it does not provision. Swallowing the 409 meant the fields the host owns
          // — above all sandboxRef, which the router derives its routing short-id from —
          // could never be written, so a router-created conversation stayed unroutable.
          // Merge-patch the spec instead. Merge (not replace) so we only add our own fields
          // and leave owner/model/parentId as the creator set them.
          if (e?.code === 409) {
            await throttled("register.patchSpec", id, () =>
              custom.patchNamespacedCustomObject(
                { group: GROUP, version: VERSION, namespace, plural: PLURAL, name: id, body: { spec: cleanSpec } },
                setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
              ),
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
      //
      // COALESCED, because this is the call that storms: a phase already published is not
      // written at all, and while a write is in flight only the LAST phase asked for is
      // written after it. Liveness is a level, not an edge, so dropping the intermediate
      // values of a burst loses nothing — and a burst of N writes for one conversation is
      // exactly what the apiserver answers with 429.
      if (published.get(id) === phase) return;
      const inflight = phaseWrites.get(id);
      if (inflight) {
        inflight.queued = phase;
        return inflight.inflight;
      }
      const entry: { inflight: Promise<void>; queued?: ConversationPhase } = {
        inflight: Promise.resolve(),
        queued: phase,
      };
      phaseWrites.set(id, entry);
      entry.inflight = (async () => {
        for (;;) {
          const next = entry.queued;
          // Unregister SYNCHRONOUSLY at the moment we decide to stop — deferring it (to a
          // .finally) leaves a window where a caller queues onto an entry nobody will drain
          // and the write is silently lost.
          if (next === undefined) {
            phaseWrites.delete(id);
            return;
          }
          entry.queued = undefined;
          if (published.get(id) === next) continue;
          await patchPhase(id, next);
        }
      })();
      return entry.inflight;
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
      // Forget the coalescer's memory of this conversation: a CR that is recreated under the
      // same id must be published to afresh, and the maps must not outlive the conversations.
      published.delete(id);
      phaseWrites.delete(id);
      await throttled("remove", id, () =>
        custom.deleteNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace,
          plural: PLURAL,
          name: id,
        }),
      )
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
      const resp = await throttled("list", "*", () =>
        custom.listNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace,
          plural: PLURAL,
        }),
      );
      const items = (resp as { items?: unknown[] })?.items ?? [];
      return items.map((o) => toRecord(o)).filter((r): r is ConversationRecord => r !== undefined);
    },

    async get(id: string): Promise<ConversationRecord | undefined> {
      try {
        const obj = await throttled("get", id, () =>
          custom.getNamespacedCustomObject({
            group: GROUP,
            version: VERSION,
            namespace,
            plural: PLURAL,
            name: id,
          }),
        );
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
