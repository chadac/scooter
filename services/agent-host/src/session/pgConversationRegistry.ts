/**
 * The conversation registry on the `conversations` row, the single source of truth for a
 * conversation's existence, placement (host_pod / host_generation, written by the router and
 * the controller) and phase. The router inserts the row at create time, so every write here
 * is an UPDATE (or DELETE) of a row that already exists. Writes are best-effort, while reads
 * throw so a pod that cannot read the truth does not serve a stale view.
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
} from "./conversationRegistry.js";

const log = logger("pgConversationRegistry");

const { conversations } = agent_host;

export interface PgConversationRegistryConfig {
  /** Postgres connection string (the agent_host database). Ignored when `db` is supplied. */
  dsn?: string;
  /** Override the database handle (tests). Defaults to a small pool over `dsn`. */
  db?: NodePgDatabase;
}

const PHASES: ReadonlySet<string> = new Set<ConversationPhase>(["Assigned", "Suspended"]);

type RecordRow = {
  id: string;
  model: string | null;
  owner: string | null;
  parentId: string | null;
  kind: string | null;
  origin: string | null;
  sandboxRef: string | null;
  creatorPod: string | null;
  phase: string | null;
  hostPod: string | null;
  hostGeneration: number | string | null;
  visibility: string | null;
};

const columns = {
  id: conversations.id,
  model: conversations.model,
  owner: conversations.owner,
  parentId: conversations.parentId,
  kind: conversations.kind,
  origin: conversations.origin,
  sandboxRef: conversations.sandboxRef,
  creatorPod: conversations.creatorPod,
  phase: conversations.phase,
  hostPod: conversations.hostPod,
  hostGeneration: conversations.hostGeneration,
  visibility: conversations.visibility,
};

function toRecord(r: RecordRow): ConversationRecord {
  return {
    id: r.id,
    spec: {
      ...(r.model ? { model: r.model } : {}),
      ...(r.owner ? { owner: r.owner } : {}),
      ...(r.parentId ? { parentId: r.parentId } : {}),
      ...(r.kind === "subagent" || r.kind === "session" ? { kind: r.kind } : {}),
      ...(r.origin ? { origin: r.origin } : {}),
      ...(r.sandboxRef ? { sandboxRef: r.sandboxRef } : {}),
      ...(r.creatorPod ? { creatorPod: r.creatorPod } : {}),
      ...(r.visibility === "private" ? { visibility: "private" as const } : {}),
    },
    // Only the phases agent-host acts on; Pending/Failed read as "not reconciled to a host".
    ...(r.phase && PHASES.has(r.phase) ? { phase: r.phase as ConversationPhase } : {}),
    ...(r.hostPod ? { hostPod: r.hostPod } : {}),
    ...(r.hostGeneration != null ? { generation: Number(r.hostGeneration) } : {}),
  };
}

export function createPgConversationRegistry(config: PgConversationRegistryConfig): ConversationRegistry {
  const pool = config.db ? undefined : createPgPool("conversationRegistry", { connectionString: config.dsn!, max: 2 });
  const db: NodePgDatabase = config.db ?? drizzle(pool!);

  /** Writes are best-effort by contract; a failure is loud but never propagates. */
  const bestEffort = async (op: string, id: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (err) {
      log.warn("conversations row write failed", { op, conversation_id: id, error: formatError(err) });
    }
  };

  return {
    async register(id, spec) {
      // Only sandbox_ref and creator_pod, since the router's insert and saveMeta own
      // model/owner/parent_id; absent fields are omitted rather than nulled so an adoption
      // without a sandboxRef cannot erase the ref the router routes by.
      const set: Partial<{ sandboxRef: string; creatorPod: string }> = {};
      if (spec.sandboxRef) set.sandboxRef = spec.sandboxRef;
      if (spec.creatorPod) set.creatorPod = spec.creatorPod;
      if (Object.keys(set).length === 0) return;
      await bestEffort("register", id, () =>
        db.update(conversations).set(set).where(eq(conversations.id, id)),
      );
    },

    async setPhase(id, phase) {
      await bestEffort("setPhase", id, () =>
        db.update(conversations).set({ phase }).where(eq(conversations.id, id)),
      );
    },

    async remove(id) {
      // Normally a no-op after metaStore.removeConversation; idempotent.
      await bestEffort("remove", id, () => db.delete(conversations).where(eq(conversations.id, id)));
    },

    async list() {
      const rows = (await db.select(columns).from(conversations)) as RecordRow[];
      return rows.map(toRecord);
    },

    async get(id) {
      const rows = (await db.select(columns).from(conversations).where(eq(conversations.id, id)).limit(1)) as RecordRow[];
      return rows.length ? toRecord(rows[0]) : undefined;
    },
  };
}
