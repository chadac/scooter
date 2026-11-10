/** Accounts in one system each, keyed by that system's stable id; see lib/sql/agent_host/schema.sql. */

import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
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
  /** Make `ref` the user's only account at that provider. */
  link(ref: IdentityRef, user: string): Promise<void>;
  /** Unlink the user's account, so its messages taint again. */
  unlink(provider: string, user: string): Promise<void>;
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
    async link(ref, user) {
      await db.transaction(async (tx) => {
        // A relink frees the user's previous account.
        await tx
          .update(identities)
          .set({ scooterUser: null, updatedAt: now() })
          .where(
            and(
              eq(identities.provider, ref.provider),
              eq(identities.scooterUser, user),
              ne(identities.externalId, ref.externalId),
            ),
          );
        await tx
          .insert(identities)
          .values({
            id: randomUUID(),
            provider: ref.provider,
            externalId: ref.externalId,
            handle: ref.handle,
            displayName: ref.displayName ?? null,
            scooterUser: user,
            updatedAt: now(),
          })
          .onConflictDoUpdate({
            target: [identities.provider, identities.externalId],
            set: {
              handle: sql`excluded.handle`,
              scooterUser: sql`excluded.scooter_user`,
              updatedAt: sql`excluded.updated_at`,
            },
          });
      });
    },
    async unlink(provider, user) {
      await db
        .update(identities)
        .set({ scooterUser: null, updatedAt: now() })
        .where(and(eq(identities.provider, provider), eq(identities.scooterUser, user)));
    },
    async close() {
      await ownPool?.end();
    },
  };
}

/** In-memory, for tests and database-less runs. */
type MemoryIdentity = IdentityRef & { id: string; scooterUser?: string };

export function createMemoryIdentityRegistry(): IdentityRegistry & { rows: Map<string, MemoryIdentity> } {
  const rows = new Map<string, MemoryIdentity>();
  const keyOf = (ref: IdentityRef) => `${ref.provider}\0${ref.externalId}`;
  const unlink = async (provider: string, user: string) => {
    for (const r of rows.values()) if (r.provider === provider && r.scooterUser === user) r.scooterUser = undefined;
  };
  return {
    rows,
    async upsert(ref) {
      const prev = rows.get(keyOf(ref));
      const id = prev?.id ?? randomUUID();
      rows.set(keyOf(ref), { ...ref, id, scooterUser: prev?.scooterUser });
      return id;
    },
    async link(ref, user) {
      await unlink(ref.provider, user);
      const prev = rows.get(keyOf(ref));
      rows.set(keyOf(ref), { ...ref, displayName: prev?.displayName, id: prev?.id ?? randomUUID(), scooterUser: user });
    },
    unlink,
    async close() {},
  };
}
