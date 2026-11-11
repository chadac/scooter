/**
 * Contract tests for linked resources living in Postgres. Every test runs with an
 * empty (wiped) file store so that the data is only in the database, the shape a
 * rollout leaves behind.
 */

import { describe, it, expect, vi } from "vitest";

import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { createPgLinkStore, resourceIdOf } from "../../src/session/linkStore.js";
import type { ConversationLink } from "../../src/session/manager.js";
import type { SessionId } from "../../src/types.js";

const CONV = "conv-1" as SessionId;

const pr = (over: Partial<ConversationLink> = {}): ConversationLink => ({
  source: "github",
  resourceType: "pull_request",
  url: "https://github.com/example-org/example-app/pull/203",
  title: "example-org/example-app #203",
  ...over,
});

/**
 * A tiny in-memory Postgres under a real drizzle client, so the store's generated-model
 * queries are exercised. It honours the global UNIQUE (source, resource_type, resource_id)
 * key, which the dedupe and the single-valued reverse lookup both rest on.
 */
function fakeDb(): { db: NodePgDatabase; rows: Array<Record<string, unknown>> } {
  const rows: Array<Record<string, unknown>> = [];
  let seq = 0;

  const client = {
    async query(cfg: { text: string; values?: unknown[] } | string, params: unknown[] = []) {
      const text = typeof cfg === "string" ? cfg : cfg.text;
      const values = (typeof cfg === "string" ? params : (cfg.values ?? params)) as unknown[];
      const head = text.trim().toUpperCase();

      if (head.startsWith("INSERT")) {
        // The fake dedupes on the global key, so the statement must target that key too.
        if (/ON CONFLICT/i.test(text) && /CONVERSATION_ID/i.test(text.split(/ON CONFLICT/i)[1].split(/DO /i)[0])) {
          throw new Error(
            `ON CONFLICT must target the GLOBAL unique (source, resource_type, resource_id), ` +
              `not the conversation. Got: ${text.split(/ON CONFLICT/i)[1].split(/DO /i)[0].trim()}`,
          );
        }
        const [conv, source, type, resourceId, url, title, ref] = values as [
          string, string, string, string, string | null, string | null, string | null,
        ];
        // conversation_id is not part of the global key.
        const existing = rows.find(
          (r) => r.source === source && r.resource_type === type && r.resource_id === resourceId,
        );
        if (existing) {
          if (!/DO UPDATE/i.test(text)) return { rows: [], rowCount: 0 };
          // The upsert's WHERE leaves another conversation's row alone.
          const guarded = /DO UPDATE[\s\S]*\bWHERE\b[\s\S]*conversation_id/i.test(text);
          if (guarded && existing.conversation_id !== conv) return { rows: [], rowCount: 0 };
          // coalesce(excluded.x, existing.x): a sparser write must not blank a column.
          existing.url = url ?? existing.url;
          existing.title = title ?? existing.title;
          existing.ref = ref ?? existing.ref;
          return { rows: [], rowCount: 1 };
        }
        rows.push({
          id: ++seq,
          conversation_id: conv,
          source,
          resource_type: type,
          resource_id: resourceId,
          url,
          title,
          ref,
        });
        return { rows: [], rowCount: 1 };
      }

      // drizzle asks for rowMode:"array", positional values in SELECT order.
      if (head.startsWith("SELECT")) {
        // The reverse lookup selects conversation_id alone; the panel read selects five.
        const reverse = /SELECT\s+"?RESOURCE_LINKS"?\."?CONVERSATION_ID/i.test(text)
          || /^SELECT\s+"?CONVERSATION_ID/i.test(head);
        if (reverse) {
          const [source, type, resourceId] = values as [string, string, string];
          const hits = rows
            .filter((r) => r.source === source && r.resource_type === type && r.resource_id === resourceId)
            .sort((a, b) => (b.id as number) - (a.id as number))
            .slice(0, 1)
            .map((r) => [r.conversation_id]);
          return { rows: hits, rowCount: hits.length };
        }
        const [conv] = values as [string];
        const out = rows
          .filter((r) => r.conversation_id === conv)
          .sort((a, b) => (a.id as number) - (b.id as number))
          .map((r) => [r.source, r.resource_type, r.url, r.title, r.ref]);
        return { rows: out, rowCount: out.length };
      }

      if (head.startsWith("DELETE")) {
        const [conv] = values as [string];
        let removed = 0;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].conversation_id === conv) {
            rows.splice(i, 1);
            removed++;
          }
        }
        return { rows: [], rowCount: removed };
      }
      throw new Error(`unexpected sql: ${text}`);
    },
  };
  return { db: drizzle(client as never), rows };
}

/** A file-backed link store standing in for one a deployment still carries on disk. */
const legacyWith = (links: Record<string, ConversationLink[]>) => ({
  listLinks: vi.fn(async (id: string) => links[id] ?? []),
});

describe("linked resources in Postgres", () => {
  it("THE OUTAGE: links survive when the file store is wiped", async () => {
    // The local emptyDir answers [] and the panel must still show the PR.
    const { db, rows } = fakeDb();
    const legacy = legacyWith({});
    const store = createPgLinkStore({ db, legacy });

    await store.addLink(CONV, pr());
    expect(await store.listLinks(CONV)).toEqual([pr()]);
  });

  it("round-trips the full ConversationLink shape, ref included", async () => {
    // `ref` carries the structured reply targets the response tools use.
    const { db, rows } = fakeDb();
    const store = createPgLinkStore({ db });
    const link = pr({ ref: { owner: "example-org", repo: "example-app", number: 203 } });

    await store.addLink(CONV, link);
    expect((await store.listLinks(CONV))[0]).toEqual(link);
  });

  it("parses a ref delivered as raw jsonb text", async () => {
    // A driver may return jsonb as a string.
    const { db, rows } = fakeDb();
    const store = createPgLinkStore({ db });
    await store.addLink(CONV, pr({ ref: { channel: "C123", threadTs: "1.2" } }));
    (rows[0] as { ref: unknown }).ref = JSON.stringify({ channel: "C123", threadTs: "1.2" });

    expect((await store.listLinks(CONV))[0].ref).toEqual({ channel: "C123", threadTs: "1.2" });
  });

  it("deleteByConversation drops the links so the SAME resource can re-link to a fresh conversation", async () => {
    // The unique key is global, so a leftover row from a deleted conversation would keep the stale conversation_id on conflict.
    const { db } = fakeDb();
    const store = createPgLinkStore({ db });
    await store.addLink("conv-old" as SessionId, pr());
    await store.deleteByConversation("conv-old" as SessionId);
    expect(await store.listLinks("conv-old" as SessionId)).toHaveLength(0);

    await store.addLink("conv-new" as SessionId, pr());
    const listed = await store.listLinks("conv-new" as SessionId);
    expect(listed).toHaveLength(1);
    expect(listed[0].url).toBe(pr().url);
  });

  it("deleteByConversation also drops the conversation's hidden vars, even when the links delete fails", async () => {
    const deletes: Array<{ text: string; values: unknown[] }> = [];
    const client = {
      async query(cfg: { text: string; values?: unknown[] }, params: unknown[] = []) {
        deletes.push({ text: cfg.text, values: cfg.values ?? params });
        if (/resource_links/.test(cfg.text)) throw new Error("links table unavailable");
        return { rows: [], rowCount: 0 };
      },
    };
    const store = createPgLinkStore({ db: drizzle(client as never) });
    await store.deleteByConversation(CONV);

    const vars = deletes.find((d) => /delete from "conversation_vars"/i.test(d.text));
    expect(vars?.values).toEqual([CONV]);
  });

  it("dedupes: the same resource posted twice is ONE link", async () => {
    const { db, rows } = fakeDb();
    const store = createPgLinkStore({ db });
    await store.addLink(CONV, pr());
    await store.addLink(CONV, pr());

    expect(await store.listLinks(CONV)).toHaveLength(1);
  });

  it("ENRICHES an existing link when a later post adds a title", async () => {
    // A Slack thread has no url, so this exercises the enrich path alone.
    const { db } = fakeDb();
    const store = createPgLinkStore({ db });
    const ref = { channel: "C123", threadTs: "1700.5" };
    await store.addLink(CONV, { source: "slack", resourceType: "thread", ref });
    await store.addLink(CONV, { source: "slack", resourceType: "thread", title: "C123 thread", ref });

    const listed = await store.listLinks(CONV);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ title: "C123 thread", ref });
  });

  it("two Slack threads in ONE channel are two links, one per conversation", async () => {
    // Both carry the same channel-wide title, which must not be their identity.
    const { db } = fakeDb();
    const store = createPgLinkStore({ db });
    const thread = (threadTs: string): ConversationLink => ({
      source: "slack", resourceType: "thread", title: "C123 thread", ref: { channel: "C123", threadTs },
    });
    expect(await store.addLink("conv-a" as SessionId, thread("1700.1"))).toBeUndefined();
    expect(await store.addLink("conv-b" as SessionId, thread("1700.2"))).toBeUndefined();

    expect(await store.listLinks("conv-a" as SessionId)).toEqual([thread("1700.1")]);
    expect(await store.listLinks("conv-b" as SessionId)).toEqual([thread("1700.2")]);
    expect(await store.conversationForResource("slack", "thread", "C123:1700.2")).toBe("conv-b");
  });

  it("CANONICALISES resource_type, so the two spellings are ONE row", async () => {
    // The broker's auto-link says "pr" and the webhooks handler says "pull_request"; the table holds the long form.
    const { db, rows } = fakeDb();
    const store = createPgLinkStore({ db, typeAliases: { github: { pr: "pull_request" } } });
    await store.addLink(CONV, pr({ resourceType: "pull_request" }));
    await store.addLink(CONV, pr({ resourceType: "pr", title: "same PR, other writer" }));

    expect(rows).toHaveLength(1);
    expect(rows[0].resource_type).toBe("pull_request");
  });

  it("a sparser re-post never blanks a column we already have", async () => {
    const { db, rows } = fakeDb();
    const store = createPgLinkStore({ db });
    await store.addLink(CONV, pr({ ref: { owner: "example-org", repo: "example-app", number: 203 } }));
    await store.addLink(CONV, { source: "github", resourceType: "pull_request", url: pr().url });

    const [got] = await store.listLinks(CONV);
    expect(got.title).toBe("example-org/example-app #203");
    expect(got.ref).toEqual({ owner: "example-org", repo: "example-app", number: 203 });
  });

  it("keeps two different resources as two links, ordered by insertion", async () => {
    const { db, rows } = fakeDb();
    const store = createPgLinkStore({ db });
    await store.addLink(CONV, pr({ url: "https://example.com/pr/1", title: "one" }));
    await store.addLink(CONV, pr({ url: "https://example.com/pr/2", title: "two" }));

    expect((await store.listLinks(CONV)).map((l) => l.title)).toEqual(["one", "two"]);
  });

  it("scopes links to their own conversation", async () => {
    const { db, rows } = fakeDb();
    const store = createPgLinkStore({ db });
    await store.addLink("conv-a" as SessionId, pr({ url: "https://example.com/a" }));
    await store.addLink("conv-b" as SessionId, pr({ url: "https://example.com/b" }));

    expect((await store.listLinks("conv-a" as SessionId)).map((l) => l.url)).toEqual([
      "https://example.com/a",
    ]);
  });

  it("ONE resource is ONE row: a second conversation does not get its own copy", async () => {
    // The unique key is global because webhooks routes an incoming event to the one conversation for a resource.
    const { db, rows } = fakeDb();
    const store = createPgLinkStore({ db });
    await store.addLink("conv-a" as SessionId, pr());
    await store.addLink("conv-b" as SessionId, pr());

    expect(rows).toHaveLength(1);
    expect(await store.listLinks("conv-a" as SessionId)).toHaveLength(1);
    expect(await store.listLinks("conv-b" as SessionId)).toHaveLength(0);
  });

  it("REPORTS the clash, naming the owner, and leaves the owner's row as it was", async () => {
    const { db, rows } = fakeDb();
    const store = createPgLinkStore({ db });
    await store.addLink("conv-a" as SessionId, pr());

    const clash = await store.addLink("conv-b" as SessionId, pr({ title: "other writer" }));
    expect(clash).toEqual({ ownerConversationId: "conv-a" });
    expect(rows[0]).toMatchObject({ conversation_id: "conv-a", title: pr().title });
  });

  it("a re-post by the owner is not a clash", async () => {
    const { db } = fakeDb();
    const store = createPgLinkStore({ db });
    await store.addLink(CONV, pr());
    expect(await store.addLink(CONV, pr())).toBeUndefined();
  });
});

describe("reverse lookup: which conversation owns this resource", () => {
  it("answers with the owning conversation", async () => {
    const { db, rows } = fakeDb();
    const store = createPgLinkStore({ db });
    await store.addLink(CONV, pr());

    const owner = await store.conversationForResource(
      "github",
      "pull_request",
      resourceIdOf(pr()),
    );
    expect(owner).toBe(CONV);
  });

  it("returns undefined for an unknown resource", async () => {
    const { db, rows } = fakeDb();
    const store = createPgLinkStore({ db });
    expect(await store.conversationForResource("github", "pull_request", "nope")).toBeUndefined();
  });
});

describe("read-through to file-backed links", () => {
  it("serves links that exist only on disk", async () => {
    const { db, rows } = fakeDb();
    const legacy = legacyWith({ [CONV]: [pr()] });
    const store = createPgLinkStore({ db, legacy });

    expect(await store.listLinks(CONV)).toEqual([pr()]);
  });

  it("BACKFILLS them, so the next read is served from the database", async () => {
    const { db, rows } = fakeDb();
    const legacy = legacyWith({ [CONV]: [pr()] });
    const store = createPgLinkStore({ db, legacy });

    await store.listLinks(CONV);
    legacy.listLinks.mockClear();

    expect(await store.listLinks(CONV)).toEqual([pr()]);
    expect(legacy.listLinks).not.toHaveBeenCalled();
  });

  it("a backfilled link is reachable by the reverse lookup", async () => {
    // The backfill has to write real rows.
    const { db, rows } = fakeDb();
    const legacy = legacyWith({ [CONV]: [pr()] });
    const store = createPgLinkStore({ db, legacy });

    await store.listLinks(CONV);
    expect(await store.conversationForResource("github", "pull_request", resourceIdOf(pr()))).toBe(
      CONV,
    );
  });

  it("never lets a backfill overwrite a row the database already has", async () => {
    const { db, rows } = fakeDb();
    const legacy = legacyWith({ [CONV]: [pr({ title: "stale title" })] });
    const store = createPgLinkStore({ db, legacy });

    await store.addLink(CONV, pr({ title: "fresh title" }));
    expect((await store.listLinks(CONV))[0].title).toBe("fresh title");
  });

  it("does not read through once the conversation has rows in the database", async () => {
    const { db, rows } = fakeDb();
    const legacy = legacyWith({ [CONV]: [pr({ url: "https://example.com/old" })] });
    const store = createPgLinkStore({ db, legacy });

    await store.addLink(CONV, pr({ url: "https://example.com/new" }));
    expect((await store.listLinks(CONV)).map((l) => l.url)).toEqual(["https://example.com/new"]);
    expect(legacy.listLinks).not.toHaveBeenCalled();
  });
});

describe("database failures degrade, never throw into a request", () => {
  const brokenDb = (): LinkStoreDb => ({
    query: async () => {
      throw new Error("connection terminated");
    },
    end: async () => {},
  });

  it("addLink swallows a write failure", async () => {
    const store = createPgLinkStore({ db: brokenDb() });
    await expect(store.addLink(CONV, pr())).resolves.toBeUndefined();
  });

  it("listLinks degrades to the file store when the query fails", async () => {
    const legacy = legacyWith({ [CONV]: [pr()] });
    const store = createPgLinkStore({ db: brokenDb(), legacy });

    expect(await store.listLinks(CONV)).toEqual([pr()]);
  });

  it("listLinks returns [] rather than throwing when everything is down", async () => {
    const store = createPgLinkStore({ db: brokenDb() });
    await expect(store.listLinks(CONV)).resolves.toEqual([]);
  });
});

describe("resourceIdOf — the dedupe identity", () => {
  it("prefers the url", () => {
    expect(resourceIdOf(pr())).toBe("https://github.com/example-org/example-app/pull/203");
  });
  it("names a url-less Slack thread by channel:threadTs, as conversation_map does", () => {
    expect(
      resourceIdOf({
        source: "slack", resourceType: "thread", title: "C123 thread", ref: { channel: "C123", threadTs: "1700.5" },
      }),
    ).toBe("C123:1700.5");
  });
  it("still prefers a Slack permalink over the ref", () => {
    const url = "https://example.slack.com/archives/C123/p17005";
    expect(
      resourceIdOf({ source: "slack", resourceType: "thread", url, ref: { channel: "C123", threadTs: "1700.5" } }),
    ).toBe(url);
  });
  it("falls back to the title", () => {
    expect(resourceIdOf({ source: "slack", resourceType: "thread", title: "#eng-help" })).toBe(
      "#eng-help",
    );
  });
  it("is empty when a link carries neither", () => {
    expect(resourceIdOf({ source: "slack", resourceType: "thread" })).toBe("");
  });
});
