/** Reads a conversation's folder for hook input. */

import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { agent_host } from "@scooter/schema";

import { createPgPool } from "../db/pgPool.js";
import type { HookFolder } from "./types.js";

const { conversationFolders, userConversationMetadata } = agent_host;

export interface FolderReader {
  /** The owner's user folder for the conversation; Starred and unfiled are null. */
  folderOf(owner: string, conversationId: string): Promise<HookFolder | null>;
  close(): Promise<void>;
}

export function createPgFolderReader(config: { dsn?: string; db?: NodePgDatabase }): FolderReader {
  const ownPool = config.db ? undefined : createPgPool("folderReader", { connectionString: config.dsn!, max: 2 });
  const db: NodePgDatabase = config.db ?? drizzle(ownPool!);
  return {
    async folderOf(owner, conversationId) {
      const rows = await db
        .select({ id: conversationFolders.id, name: conversationFolders.name })
        .from(userConversationMetadata)
        .innerJoin(conversationFolders, eq(conversationFolders.id, userConversationMetadata.folderId))
        .where(
          and(
            eq(userConversationMetadata.owner, owner),
            eq(userConversationMetadata.conversationId, conversationId),
            eq(conversationFolders.kind, "user"),
          ),
        )
        .limit(1);
      const r = rows[0];
      return r ? { id: r.id, name: r.name } : null;
    },
    async close() {
      await ownPool?.end();
    },
  };
}
