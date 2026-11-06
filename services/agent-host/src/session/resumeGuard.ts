import type { SandboxProvisioner, SessionManager } from "./manager.js";
import type { ConversationRegistry } from "./conversationRegistry.js";
import type { SandboxRef, SessionId } from "../types.js";
import { logger } from "../log.js";

const log = logger("resume-guard");

/**
 * The exec layer's resume-on-missing-pod hook, fenced by end().
 *
 * A conversation end() tore down must stay down. An exec still polling for its pod when the
 * DELETE lands finds no pod and fires ensureRunning; a bare provisioner.resume() then 404s on the
 * deleted Sandbox and recreates it, leaking a pod (and its CPU request) until the controller's
 * orphan reap ~10 min later.
 *
 * Two checks, because the DELETE and the polling exec are often on different replicas:
 * - this pod's own tombstone (end() ran here);
 * - the shared conversations row (end() ran anywhere). end() removes the row before it destroys
 *   the pod, so a poller that sees no pod and still finds the row is looking at a live
 *   conversation, not one mid-delete.
 * A registry read failure resumes anyway: a stuck turn on a live conversation is worse than a pod
 * the orphan reap collects.
 *
 * A suspended conversation is refused too: only revive() may resume it, because revive also claims
 * the row. A bare resume leaves the row Suspended with its Sandbox Running, which the controller
 * re-suspends as a zombie.
 *
 * The refusal carries code 404 so pollForReadyPod fails at once instead of polling to its deadline.
 */
export function resumeUnlessEnded(
  sessions: Pick<SessionManager, "isEnded" | "get">,
  provisioner: Pick<SandboxProvisioner, "resume">,
  id: SessionId,
  sandbox: SandboxRef,
  registry?: Pick<ConversationRegistry, "get">,
): () => Promise<void> {
  const refuse = (why: string) =>
    Object.assign(new Error(`conversation ${id} ${why}; not resuming its sandbox`), { code: 404 });
  return async () => {
    if (sessions.isEnded?.(id)) throw refuse("was ended on this pod");
    if (registry) {
      let exists = true;
      try {
        exists = (await registry.get(id)) !== undefined;
      } catch (err) {
        log.errorWith("conversations row unreadable; resuming anyway", err, { conversation_id: id });
      }
      if (!exists) throw refuse("has no conversations row");
    }
    if (sessions.get(id)?.status === "suspended") throw refuse("is suspended; only revive resumes it");
    await provisioner.resume(sandbox);
  };
}
