/** Each user's theme choice; no row means none picked. */

import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { agent_host } from "@scooter/schema";

import { createPgPool } from "../db/pgPool.js";

const { userUiSettings } = agent_host;

export type ThemeMode = "light" | "dark" | "system";

export interface UserTheme {
  themeId: string;
  mode: ThemeMode;
}

export interface UserThemeStore {
  get(owner: string): Promise<UserTheme | undefined>;
  set(owner: string, theme: UserTheme): Promise<void>;
  close(): Promise<void>;
}

export function isThemeMode(v: unknown): v is ThemeMode {
  return v === "light" || v === "dark" || v === "system";
}

export function createPgUserThemeStore(config: { dsn?: string; db?: NodePgDatabase; now?: () => number }): UserThemeStore {
  const ownPool = config.db ? undefined : createPgPool("userThemeStore", { connectionString: config.dsn!, max: 2 });
  const db: NodePgDatabase = config.db ?? drizzle(ownPool!);
  const now = config.now ?? (() => Date.now());
  return {
    async get(owner) {
      const [row] = await db
        .select({ themeId: userUiSettings.themeId, mode: userUiSettings.themeMode })
        .from(userUiSettings)
        .where(eq(userUiSettings.owner, owner));
      return row && isThemeMode(row.mode) ? { themeId: row.themeId, mode: row.mode } : undefined;
    },
    async set(owner, { themeId, mode }) {
      await db
        .insert(userUiSettings)
        .values({ owner, themeId, themeMode: mode, updatedAt: now() })
        .onConflictDoUpdate({
          target: userUiSettings.owner,
          set: { themeId: sql`excluded.theme_id`, themeMode: sql`excluded.theme_mode`, updatedAt: sql`excluded.updated_at` },
        });
    },
    async close() {
      await ownPool?.end();
    },
  };
}

/** In-memory, for tests. */
export function createMemoryUserThemeStore(): UserThemeStore {
  const rows = new Map<string, UserTheme>();
  return {
    async get(owner) {
      const row = rows.get(owner);
      return row && { ...row };
    },
    async set(owner, theme) {
      rows.set(owner, { ...theme });
    },
    async close() {},
  };
}
