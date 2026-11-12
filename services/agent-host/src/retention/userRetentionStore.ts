/** Each user's idle lifetime for unfiled conversations; no row means the deployment default. */

import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { agent_host } from "@scooter/schema";

import { createPgPool } from "../db/pgPool.js";

const { userRetentionSettings } = agent_host;

/** Ten years, as the router and the table check allow. */
export const MAX_LIFETIME_HOURS = 87600;

export function isLifetimeHours(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_LIFETIME_HOURS;
}

export interface UserRetentionStore {
  /** Hours, 0 forever; undefined when unset. */
  get(owner: string): Promise<number | undefined>;
  /** null clears it, back to the deployment default. */
  set(owner: string, hours: number | null): Promise<void>;
  close(): Promise<void>;
}

export function createPgUserRetentionStore(config: { dsn?: string; db?: NodePgDatabase; now?: () => number }): UserRetentionStore {
  const ownPool = config.db ? undefined : createPgPool("userRetentionStore", { connectionString: config.dsn!, max: 2 });
  const db: NodePgDatabase = config.db ?? drizzle(ownPool!);
  const now = config.now ?? (() => Date.now());
  return {
    async get(owner) {
      const [row] = await db
        .select({ hours: userRetentionSettings.defaultLifetimeHours })
        .from(userRetentionSettings)
        .where(eq(userRetentionSettings.owner, owner));
      return row?.hours;
    },
    async set(owner, hours) {
      if (hours === null) {
        await db.delete(userRetentionSettings).where(eq(userRetentionSettings.owner, owner));
        return;
      }
      await db
        .insert(userRetentionSettings)
        .values({ owner, defaultLifetimeHours: hours, updatedAt: now() })
        .onConflictDoUpdate({
          target: userRetentionSettings.owner,
          set: { defaultLifetimeHours: sql`excluded.default_lifetime_hours`, updatedAt: sql`excluded.updated_at` },
        });
    },
    async close() {
      await ownPool?.end();
    },
  };
}

/** In-memory, for tests. */
export function createMemoryUserRetentionStore(): UserRetentionStore {
  const rows = new Map<string, number>();
  return {
    async get(owner) {
      return rows.get(owner);
    },
    async set(owner, hours) {
      if (hours === null) rows.delete(owner);
      else rows.set(owner, hours);
    },
    async close() {},
  };
}
