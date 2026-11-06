import type { SandboxProvisioner, SessionManager } from "./manager.js";
import type { ConversationRegistry } from "./conversationRegistry.js";
import type { SandboxRef, SessionId } from "../types.js";
import { logger } from "../log.js";

const log = logger("resume-guard");

/**
 * Resume-on-missing-pod hook that refuses ended or suspended conversations.
 *
 * - Ended here (tombstone) or anywhere (no conversations row): resuming recreates a deleted Sandbox.
 * - Suspended: only revive() may resume, since it also claims the row.
 * - Unreadable row: resume anyway.
 *
 * The refusal carries code 404 so pollForReadyPod fails at once.
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
