/** Held forge comments and per-conversation allowed authors. */

import type { Pool } from "pg";

import { createPgPool } from "../db/pgPool.js";

export interface HeldMessage {
  id: string;
  conversationId: string;
  /** The forge, also the delivered message's source. */
  source: string;
  author: string;
  url: string;
  prompt: string;
  /** What the agent receives if allowed. */
  text: string;
  createdAt: number;
}

export interface HeldMessageStore {
  hold(msg: HeldMessage): Promise<void>;
  /** Oldest first. */
  list(conversationId: string): Promise<HeldMessage[]>;
  /** Delete and return it; undefined if already taken. */
  take(id: string): Promise<HeldMessage | undefined>;
  isTrusted(conversationId: string, source: string, author: string): Promise<boolean>;
  trust(conversationId: string, source: string, author: string, allowedBy: string): Promise<void>;
  removeConversation(conversationId: string): Promise<void>;
  close(): Promise<void>;
}

type Row = {
  id: string;
  conversation_id: string;
  source: string;
  author: string;
  url: string;
  prompt: string;
  text: string;
  created_at: string | number;
};

const fromRow = (r: Row): HeldMessage => ({
  id: r.id,
  conversationId: r.conversation_id,
  source: r.source,
  author: r.author,
  url: r.url,
  prompt: r.prompt,
  text: r.text,
  createdAt: Number(r.created_at),
});

export function createPgHeldMessageStore(cfg: { dsn?: string; pool?: Pool; now?: () => number }): HeldMessageStore {
  const pool = cfg.pool ?? createPgPool("heldMessages", { connectionString: cfg.dsn ?? "", max: 2 });
  const now = cfg.now ?? (() => Date.now());
  return {
    async hold(m) {
      await pool.query(
        `INSERT INTO held_messages (id, conversation_id, source, author, url, prompt, text, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
        [m.id, m.conversationId, m.source, m.author, m.url, m.prompt, m.text, m.createdAt],
      );
    },
    async list(conversationId) {
      const { rows } = await pool.query<Row>(
        `SELECT * FROM held_messages WHERE conversation_id = $1 ORDER BY created_at, id`,
        [conversationId],
      );
      return rows.map(fromRow);
    },
    async take(id) {
      // RETURNING: concurrent answers deliver it only once.
      const { rows } = await pool.query<Row>(`DELETE FROM held_messages WHERE id = $1 RETURNING *`, [id]);
      return rows[0] ? fromRow(rows[0]) : undefined;
    },
    async isTrusted(conversationId, source, author) {
      const { rowCount } = await pool.query(
        `SELECT 1 FROM conversation_trusted_authors WHERE conversation_id = $1 AND source = $2 AND author = $3`,
        [conversationId, source, author.toLowerCase()],
      );
      return (rowCount ?? 0) > 0;
    },
    async trust(conversationId, source, author, allowedBy) {
      await pool.query(
        `INSERT INTO conversation_trusted_authors (conversation_id, source, author, allowed_by, created_at)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [conversationId, source, author.toLowerCase(), allowedBy, now()],
      );
    },
    async removeConversation(conversationId) {
      await pool.query(`DELETE FROM held_messages WHERE conversation_id = $1`, [conversationId]);
      await pool.query(`DELETE FROM conversation_trusted_authors WHERE conversation_id = $1`, [conversationId]);
    },
    async close() {
      if (!cfg.pool) await pool.end();
    },
  };
}

export function createMemoryHeldMessageStore(): HeldMessageStore {
  const held = new Map<string, HeldMessage>();
  const trusted = new Set<string>();
  const key = (c: string, s: string, a: string) => JSON.stringify([c, s, a.toLowerCase()]);
  return {
    async hold(m) {
      if (!held.has(m.id)) held.set(m.id, { ...m });
    },
    async list(conversationId) {
      return [...held.values()]
        .filter((m) => m.conversationId === conversationId)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    },
    async take(id) {
      const m = held.get(id);
      held.delete(id);
      return m;
    },
    async isTrusted(c, s, a) {
      return trusted.has(key(c, s, a));
    },
    async trust(c, s, a) {
      trusted.add(key(c, s, a));
    },
    async removeConversation(conversationId) {
      for (const [id, m] of held) if (m.conversationId === conversationId) held.delete(id);
      for (const k of trusted) if ((JSON.parse(k) as string[])[0] === conversationId) trusted.delete(k);
    },
    async close() {},
  };
}
