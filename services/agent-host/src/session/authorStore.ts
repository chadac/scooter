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

/** An author row as shown; clearing vouches up to `lastAt`. */
export interface ShownAuthor {
  conversationId: string;
  kind: Author["kind"];
  author: string;
  lastAt: number;
}

/** A recorded author and its Scooter user, if known. */
export interface ResolvedAuthor extends ShownAuthor {
  user: string | null;
  /** An identity's forge or chat system and account name. */
  provider?: string;
  handle?: string;
}

/** Who vouched for a clear, and from where. */
export interface ClearedBy {
  user: string;
  via: "ui" | "agent";
  /** The agent's explanation, for a clear it asked for. */
  reason?: string;
}

export interface AuthorStore {
  /** Record that `author` wrote text in `conversationId`; idempotent. */
  record(conversationId: string, author: Author): Promise<void>;
  /** Every author row across the conversation's whole tree. */
  listTree(conversationId: string): Promise<ResolvedAuthor[]>;
  /** Moves unchanged shown rows to history; returns the count. */
  clear(shown: ShownAuthor[], by: ClearedBy): Promise<number>;
  close(): Promise<void>;
}

/** The owner's own text taints nothing, so it gets no row. */
export const isOwnText = (author: Author, owner: string | undefined): boolean =>
  author.kind === "user" && owner !== undefined && author.id === owner;

/** A steering caller's author; undefined for the conversation's owner. */
export function steeringAuthor(caller: { anonymous: boolean; id: string } | undefined, owner: string | undefined): Author | undefined {
  const author: Author = caller && !caller.anonymous ? { kind: "user", id: caller.id } : { kind: "unknown" };
  return isOwnText(author, owner) ? undefined : author;
}

const authorKey = (a: Author): string => (a.kind === "unknown" ? "" : a.id);

export function createPgAuthorStore(config: { dsn?: string; db?: NodePgDatabase; now?: () => number }): AuthorStore {
  const ownPool = config.db ? undefined : createPgPool("authorStore", { connectionString: config.dsn!, max: 2 });
  const db: NodePgDatabase = config.db ?? drizzle(ownPool!);
  const now = config.now ?? (() => Date.now());
  return {
    async record(conversationId, author) {
      const at = now();
      await db
        .insert(conversationAuthors)
        .values({ conversationId, kind: author.kind, author: authorKey(author), firstAt: at, lastAt: at })
        .onConflictDoUpdate({
          target: [conversationAuthors.conversationId, conversationAuthors.kind, conversationAuthors.author],
          // Stays past what was shown despite replica clock lag.
          set: { lastAt: sql`GREATEST(${conversationAuthors.lastAt} + 1, excluded.last_at)` },
        });
    },
    async listTree(conversationId) {
      // Seeding `down` with every ancestor reaches the whole tree from its root.
      const res = await db.execute<{
        conversation_id: string;
        kind: Author["kind"];
        author: string;
        last_at: string | number;
        user: string | null;
        provider: string | null;
        handle: string | null;
      }>(sql`
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
        SELECT a.conversation_id, a.kind, a.author, a.last_at,
          CASE a.kind WHEN 'user' THEN a.author WHEN 'identity' THEN i.scooter_user END AS "user",
          i.provider, i.handle
        FROM conversation_authors a
        LEFT JOIN identities i ON a.kind = 'identity' AND i.id = a.author
        WHERE a.conversation_id IN (SELECT id FROM down)
        ORDER BY a.first_at`);
      return res.rows.map((r) => ({
        conversationId: r.conversation_id,
        kind: r.kind,
        author: r.author,
        lastAt: Number(r.last_at),
        user: r.user ?? null,
        ...(r.provider ? { provider: r.provider } : {}),
        ...(r.handle ? { handle: r.handle } : {}),
      }));
    },
    async clear(shown, by) {
      if (shown.length === 0) return 0;
      const rows = sql.join(
        shown.map((s) => sql`(${s.conversationId}::text, ${s.kind}::text, ${s.author}::text, ${s.lastAt}::bigint)`),
        sql`, `,
      );
      const res = await db.execute(sql`
        WITH shown (conversation_id, kind, author, last_at) AS (VALUES ${rows}),
        gone AS (
          DELETE FROM conversation_authors a USING shown s
          WHERE a.conversation_id = s.conversation_id AND a.kind = s.kind AND a.author = s.author
            AND a.last_at <= s.last_at
          RETURNING a.*
        )
        INSERT INTO conversation_author_clears
          (conversation_id, kind, author, first_at, last_at, cleared_at, cleared_by, via, reason)
        SELECT conversation_id, kind, author, first_at, last_at, ${now()}, ${by.user}, ${by.via}, ${by.reason ?? null}
        FROM gone`);
      return res.rowCount ?? 0;
    },
    async close() {
      await ownPool?.end();
    },
  };
}

/** In-memory, for tests and database-less runs, where no identity is linked; `family` names a conversation's tree. */
export function createMemoryAuthorStore(
  opts: { family?: (conversationId: string) => string[] } = {},
): AuthorStore & { rows: Map<string, Array<Author & { lastAt: number }>>; clears: Array<ShownAuthor & ClearedBy> } {
  const rows = new Map<string, Array<Author & { lastAt: number }>>();
  const clears: Array<ShownAuthor & ClearedBy> = [];
  const family = opts.family ?? ((id: string) => [id]);
  let clock = 0;
  const same = (a: Author, kind: Author["kind"], key: string) => a.kind === kind && authorKey(a) === key;
  return {
    rows,
    clears,
    async record(conversationId, author) {
      const list = rows.get(conversationId) ?? [];
      const row = list.find((a) => same(a, author.kind, authorKey(author)));
      if (row) row.lastAt = ++clock;
      else list.push({ ...author, lastAt: ++clock });
      rows.set(conversationId, list);
    },
    async listTree(conversationId) {
      const out: ResolvedAuthor[] = [];
      for (const id of new Set([conversationId, ...family(conversationId)])) {
        for (const a of rows.get(id) ?? []) {
          out.push({ conversationId: id, kind: a.kind, author: authorKey(a), lastAt: a.lastAt, user: a.kind === "user" ? a.id : null });
        }
      }
      return out;
    },
    async clear(shown, by) {
      let moved = 0;
      for (const s of shown) {
        const list = rows.get(s.conversationId) ?? [];
        const i = list.findIndex((a) => same(a, s.kind, s.author) && a.lastAt <= s.lastAt);
        if (i < 0) continue;
        list.splice(i, 1);
        clears.push({ ...s, ...by });
        moved++;
      }
      return moved;
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
