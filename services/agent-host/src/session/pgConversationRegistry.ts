/**
 * The `conversations` ROW half of the conversation registry.
 *
 * Step 2 of moving conversation ownership out of the Conversation CR and into Postgres
 * (see PR #654). This wraps the k8s registry rather than replacing it, because two things
 * make a straight swap wrong today:
 *
 *   1. register() is what creates the CR for SUBAGENTS. spawnChild() is internal, so the
 *      router never creates those CRs. Stop writing the CR and a subagent has none — the
 *      controller cannot co-locate it on its parent's pod and the router cannot route to
 *      it at all.
 *   2. host_pod / host_generation are written by the CONTROLLER, which still writes the CR.
 *      A registry that read assignment from the row would see NULL for every conversation,
 *      silently emptying hydrate()'s `hostPod === selfPod` filter (no boot adoption) and
 *      making streamOwnership answer "unknown" for everything.
 *
 * So the WRITES fan out to both stores and the assignment READS (list/get) stay on the CR
 * until the reconcile loop moves. Same additive shape as the router's dualCreator: the CR
 * write keeps its existing semantics exactly, and the row write can only add.
 */

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { agent_host } from "@scooter/schema";

import { formatError, logger } from "../log.js";
import { createPgPool } from "../db/pgPool.js";

import type {
  ConversationPhase,
  ConversationRecord,
  ConversationRegistry,
  ConversationSpec,
} from "./conversationRegistry.js";

const log = logger("pgConversationRegistry");

const { conversations } = agent_host;

export interface PgConversationRowsConfig {
  /** Postgres connection string (the agent_host database). Ignored when `db` is supplied. */
  dsn?: string;
  /** Override the database handle (tests). Defaults to a small pool over `dsn`. */
  db?: NodePgDatabase;
}

/**
 * Wrap `cr` so every write also lands on the conversations row.
 *
 * Ordering is CR-then-row throughout, so a row failure cannot change what the CR does. Row
 * failures are logged and swallowed, matching the write methods' "never throws" contract —
 * a Postgres blip must not stop a conversation starting, exactly as a k8s blip does not.
 */
export function withConversationRows(
  cr: ConversationRegistry,
  config: PgConversationRowsConfig,
): ConversationRegistry {
  const pool = config.db ? undefined : createPgPool("conversationRegistry", { connectionString: config.dsn!, max: 2 });
  const db: NodePgDatabase = config.db ?? drizzle(pool!);

  /** Row writes are best-effort by contract; a failure is loud but never propagates. */
  const bestEffort = async (op: string, id: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (err) {
      log.warn("conversations row write failed", { op, conversation_id: id, error: formatError(err) });
    }
  };

  return {
    async register(id: string, spec: ConversationSpec): Promise<void> {
      await cr.register(id, spec);
      // Only sandbox_ref and creator_pod: model/owner/parent_id are already on the row,
      // written by saveMeta, and the CR's spec was duplicating them. Unifying the two stores
      // means the duplicate stops being written, not that it gets written twice.
      //
      // Absent fields are OMITTED rather than set to NULL, mirroring cleanSpec + the CR's
      // merge-patch: revive() and hydrate() re-register with a sandboxRef, but an adoption
      // path may not have one yet, and that must not erase the ref the router routes by.
      const set: Partial<{ sandboxRef: string; creatorPod: string }> = {};
      if (spec.sandboxRef) set.sandboxRef = spec.sandboxRef;
      if (spec.creatorPod) set.creatorPod = spec.creatorPod;
      if (Object.keys(set).length === 0) return;
      await bestEffort("register", id, () =>
        db.update(conversations).set(set).where(eq(conversations.id, id)),
      );
    },

    async setPhase(id: string, phase: ConversationPhase): Promise<void> {
      await cr.setPhase(id, phase);
      // No 429 coalescing on this side: that machinery exists for apiserver rate limits, and
      // setPhase only fires at suspend/revive TRANSITIONS, not on a hot path.
      await bestEffort("setPhase", id, () =>
        db.update(conversations).set({ phase }).where(eq(conversations.id, id)),
      );
    },

    async remove(id: string): Promise<void> {
      await cr.remove(id);
      // Normally a no-op: end() already deleted the row via metaStore.removeConversation
      // before reaching here. The DELETE is kept anyway so that "the registry says this
      // conversation is gone" is true of the row on its own — once existence IS the row,
      // having that depend on a different component is the split ownership this migration is
      // removing. Idempotent, so the usual double-delete costs nothing.
      await bestEffort("remove", id, () => db.delete(conversations).where(eq(conversations.id, id)));
    },

    // ---- assignment READS stay on the CR ----
    // host_pod / host_generation are the controller's to write and it still writes the CR.
    // Reading them from the row would return NULL for every conversation and break boot
    // adoption silently. These move with the reconcile loop, not here.
    list(): Promise<ConversationRecord[]> {
      return cr.list();
    },
    get(id: string): Promise<ConversationRecord | undefined> {
      return cr.get(id);
    },
  };
}
