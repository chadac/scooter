/**
 * Who other than the owner wrote text in each conversation; see lib/sql/agent_host/schema.sql.
 *
 * The broker vends personal credentials only while every author is the owner, so a
 * prompt whose author can't be recorded must not reach the agent.
 */

import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { agent_host } from "@scooter/schema";

import { createPgPool } from "../db/pgPool.js";
import type { SessionId } from "../types.js";

const { conversationAuthors } = agent_host;

/** A message's writer: a linked-or-not external account, a signed-in user, or nobody nameable. */
export type Author = { kind: "identity"; id: string } | { kind: "user"; id: string } | { kind: "unknown" };

/** One recorded author and the Scooter user it is, null when it is nobody known. */
export interface ResolvedAuthor {
  kind: Author["kind"];
  author: string;
  user: string | null;
}

export interface AuthorStore {
  /** Record that `author` wrote text in `conversationId`; idempotent. */
  record(conversationId: string, author: Author): Promise<void>;
  /** Every author across the conversation's tree: its ancestors and all their descendants. */
  listTree(conversationId: string): Promise<ResolvedAuthor[]>;
  close(): Promise<void>;
}

/** The owner's own text taints nothing, so it gets no row. */
export const isOwnText = (author: Author, owner: string | undefined): boolean =>
  author.kind === "user" && owner !== undefined && author.id === owner;

const authorKey = (a: Author): string => (a.kind === "unknown" ? "" : a.id);

export function createPgAuthorStore(config: { dsn?: string; db?: NodePgDatabase; now?: () => number }): AuthorStore {
  const ownPool = config.db ? undefined : createPgPool("authorStore", { connectionString: config.dsn!, max: 2 });
  const db: NodePgDatabase = config.db ?? drizzle(ownPool!);
  const now = config.now ?? (() => Date.now());
  return {
    async record(conversationId, author) {
      await db
        .insert(conversationAuthors)
        .values({ conversationId, kind: author.kind, author: authorKey(author), firstAt: now() })
        .onConflictDoNothing();
    },
    async listTree(conversationId) {
      // Seeding `down` with every ancestor reaches the whole tree from its root.
      const res = await db.execute<{ kind: Author["kind"]; author: string; user: string | null }>(sql`
        WITH RECURSIVE up AS (
          SELECT id, parent_id FROM conversations WHERE id = ${conversationId}
          UNION
          SELECT c.id, c.parent_id FROM conversations c JOIN up ON c.id = up.parent_id
        ), down AS (
          SELECT ${conversationId}::text AS id
          UNION
          SELECT id FROM up
          UNION
          SELECT c.id FROM conversations c JOIN down ON c.parent_id = down.id
        )
        SELECT DISTINCT a.kind, a.author,
          CASE a.kind WHEN 'user' THEN a.author WHEN 'identity' THEN i.scooter_user END AS "user"
        FROM conversation_authors a
        LEFT JOIN identities i ON a.kind = 'identity' AND i.id = a.author
        WHERE a.conversation_id IN (SELECT id FROM down)`);
      return res.rows.map((r) => ({ kind: r.kind, author: r.author, user: r.user ?? null }));
    },
    async close() {
      await ownPool?.end();
    },
  };
}

/** In-memory, for tests and database-less runs, where no identity is linked; `family` names a conversation's tree. */
export function createMemoryAuthorStore(
  opts: { family?: (conversationId: string) => string[] } = {},
): AuthorStore & { rows: Map<string, Author[]> } {
  const rows = new Map<string, Author[]>();
  const family = opts.family ?? ((id: string) => [id]);
  return {
    rows,
    async record(conversationId, author) {
      const list = rows.get(conversationId) ?? [];
      if (!list.some((a) => a.kind === author.kind && authorKey(a) === authorKey(author))) list.push(author);
      rows.set(conversationId, list);
    },
    async listTree(conversationId) {
      const seen = new Map<string, ResolvedAuthor>();
      for (const id of new Set([conversationId, ...family(conversationId)])) {
        for (const a of rows.get(id) ?? []) {
          seen.set(`${a.kind}\0${authorKey(a)}`, { kind: a.kind, author: authorKey(a), user: a.kind === "user" ? a.id : null });
        }
      }
      return [...seen.values()];
    },
    async close() {},
  };
}

/** The ids in `id`'s conversation tree, from the in-memory sessions. */
export function conversationTree(
  sessions: { get(id: SessionId): { parentId?: SessionId } | undefined; list(): Array<{ id: SessionId; parentId?: SessionId }> },
  id: string,
): string[] {
  const tree = new Set<string>([id]);
  for (let p = sessions.get(id as SessionId)?.parentId; p && !tree.has(p); p = sessions.get(p)?.parentId) tree.add(p);
  const all = sessions.list();
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of all) {
      if (c.parentId && tree.has(c.parentId) && !tree.has(c.id)) {
        tree.add(c.id);
        grew = true;
      }
    }
  }
  return [...tree];
}
