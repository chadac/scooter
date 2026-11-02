/** Accounts in one system each, keyed by that system's stable id; see lib/sql/agent_host/schema.sql. */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { agent_host } from "@scooter/schema";

import { createPgPool } from "../db/pgPool.js";

const { identities } = agent_host;

export interface IdentityRef {
  provider: string;
  externalId: string;
  handle: string;
  displayName?: string;
}

export interface IdentityRegistry {
  /** The identity id for `ref`, creating it on first sight and refreshing its handle and display name. */
  upsert(ref: IdentityRef): Promise<string>;
  close(): Promise<void>;
}

export function createPgIdentityRegistry(config: { dsn?: string; db?: NodePgDatabase; now?: () => number }): IdentityRegistry {
  const ownPool = config.db ? undefined : createPgPool("identityRegistry", { connectionString: config.dsn!, max: 2 });
  const db: NodePgDatabase = config.db ?? drizzle(ownPool!);
  const now = config.now ?? (() => Date.now());
  return {
    async upsert(ref) {
      // Conflicting writers keep the original id; display fields update.
      const rows = await db
        .insert(identities)
        .values({
          id: randomUUID(),
          provider: ref.provider,
          externalId: ref.externalId,
          handle: ref.handle,
          displayName: ref.displayName ?? null,
          updatedAt: now(),
        })
        .onConflictDoUpdate({
          target: [identities.provider, identities.externalId],
          set: {
            handle: sql`excluded.handle`,
            displayName: sql`excluded.display_name`,
            updatedAt: sql`excluded.updated_at`,
          },
        })
        .returning({ id: identities.id });
      return rows[0]!.id;
    },
    async close() {
      await ownPool?.end();
    },
  };
}

/** In-memory, for tests and database-less runs. */
export function createMemoryIdentityRegistry(): IdentityRegistry & { rows: Map<string, IdentityRef & { id: string }> } {
  const rows = new Map<string, IdentityRef & { id: string }>();
  return {
    rows,
    async upsert(ref) {
      const key = `${ref.provider}\0${ref.externalId}`;
      const id = rows.get(key)?.id ?? randomUUID();
      rows.set(key, { ...ref, id });
      return id;
    },
    async close() {},
  };
}
