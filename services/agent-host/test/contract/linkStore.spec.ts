/**
 * Tier 1 contract — linked resources live in Postgres and survive a rollout.
 *
 * THE OUTAGE THIS PREVENTS: the linked GitHub/GitLab/Slack items in the sidebar
 * disappeared and stayed gone. `listLinks` read LOCAL_STATE_PATH — an emptyDir every
 * rollout wipes — so five conversations' PR links became permanently invisible while the
 * durable copy still held them. Writes were already correct; only the read was wrong.
 *
 * Every test here runs in that shape: the file store is EMPTY (wiped) and the data is
 * only in the database.
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
 * A tiny in-memory Postgres under a REAL drizzle client, so the store's generated-model
 * queries are exercised rather than a hand-rolled SQL shim. Drizzle builds the SQL; this
 * only executes it.
 *
 * It honours UNIQUE (source, resource_type, resource_id) — the GLOBAL key webhooks
 * declares, not a per-conversation one — because the dedupe and the single-valued
 * reverse lookup both rest on it.
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
        // The fake dedupes on the GLOBAL key, so it can only be a faithful stand-in if
        // the statement actually TARGETS that key. Without this, pointing the conflict
        // target at (conversation_id, ...) still passed every test — verified.
        if (/ON CONFLICT/i.test(text) && /CONVERSATION_ID/i.test(text.split(/ON CONFLICT/i)[1].split(/DO /i)[0])) {
          throw new Error(
            `ON CONFLICT must target the GLOBAL unique (source, resource_type, resource_id), ` +
              `not the conversation. Got: ${text.split(/ON CONFLICT/i)[1].split(/DO /i)[0].trim()}`,
          );
        }
        const [conv, source, type, resourceId, url, title, ref] = values as [
          string, string, string, string, string | null, string | null, string | null,
        ];
        // GLOBAL key: conversation_id is deliberately NOT part of the match.
        const existing = rows.find(
          (r) => r.source === source && r.resource_type === type && r.resource_id === resourceId,
        );
        if (existing) {
          if (!/DO UPDATE/i.test(text)) return { rows: [], rowCount: 0 }; // DO NOTHING
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

      // drizzle asks for rowMode:"array" — positional values in SELECT order.
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
    // Exactly the rollout the customer hit — the local emptyDir answers [], and the
    // panel must still show the PR.
    const { db, rows } = fakeDb();
    const legacy = legacyWith({}); // wiped
    const store = createPgLinkStore({ db, legacy });

    await store.addLink(CONV, pr());
    expect(await store.listLinks(CONV)).toEqual([pr()]);
  });

  it("round-trips the full ConversationLink shape, ref included", async () => {
    // `ref` carries the structured reply targets the response tools use; losing it
    // downgrades every tool to "target unknown".
    const { db, rows } = fakeDb();
    const store = createPgLinkStore({ db });
    const link = pr({ ref: { owner: "example-org", repo: "example-app", number: 203 } });

    await store.addLink(CONV, link);
    expect((await store.listLinks(CONV))[0]).toEqual(link);
  });

  it("parses a ref delivered as raw jsonb text", async () => {
    // A driver returning jsonb as a string must not hand the tools a string where they
    // expect an object.
    const { db, rows } = fakeDb();
    const store = createPgLinkStore({ db });
    await store.addLink(CONV, pr({ ref: { channel: "C123", threadTs: "1.2" } }));
    (rows[0] as { ref: unknown }).ref = JSON.stringify({ channel: "C123", threadTs: "1.2" });

    expect((await store.listLinks(CONV))[0].ref).toEqual({ channel: "C123", threadTs: "1.2" });
  });

  it("dedupes: the same resource posted twice is ONE link", async () => {
    const { db, rows } = fakeDb();
    const store = createPgLinkStore({ db });
    await store.addLink(CONV, pr());
    await store.addLink(CONV, pr());

    expect(await store.listLinks(CONV)).toHaveLength(1);
  });

  it("ENRICHES an existing link when a later post adds a ref", async () => {
    // The webhooks service posts a bare link first, then fills in structured targets.
    const { db, rows } = fakeDb();
    const store = createPgLinkStore({ db });
    await store.addLink(CONV, pr({ ref: undefined }));
    await store.addLink(CONV, pr({ ref: { owner: "example-org", repo: "example-app", number: 203 } }));

    const listed = await store.listLinks(CONV);
    expect(listed).toHaveLength(1);
    expect(listed[0].ref).toEqual({ owner: "example-org", repo: "example-app", number: 203 });
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
    // The table's unique key is GLOBAL — (source, resource_type, resource_id) — because
    // webhooks routes an incoming event to THE conversation for a resource and reads
    // with scalar_one_or_none(), which RAISES on a second row. So linking the same PR
    // from another conversation is a no-op here, not a second row.
    //
    // The cost is real and deliberate: two agents working one PR cannot both show it.
    // Supporting that needs fan-out routing on the webhooks side first — see the
    // discussion on #381 — so it is NOT silently enabled by widening this key.
    const { db, rows } = fakeDb();
    const store = createPgLinkStore({ db });
    await store.addLink("conv-a" as SessionId, pr());
    await store.addLink("conv-b" as SessionId, pr());

    expect(rows).toHaveLength(1);
    expect(await store.listLinks("conv-a" as SessionId)).toHaveLength(1);
    expect(await store.listLinks("conv-b" as SessionId)).toHaveLength(0);
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

    await store.listLinks(CONV); // reads through + backfills
    legacy.listLinks.mockClear();

    expect(await store.listLinks(CONV)).toEqual([pr()]);
    expect(legacy.listLinks).not.toHaveBeenCalled();
  });

  it("a backfilled link is reachable by the reverse lookup", async () => {
    // The backfill has to write real rows, not just serve a passthrough.
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
    // An empty panel during an outage beats a permanently wrong one.
    const store = createPgLinkStore({ db: brokenDb() });
    await expect(store.listLinks(CONV)).resolves.toEqual([]);
  });
});

describe("resourceIdOf — the dedupe identity", () => {
  it("prefers the url", () => {
    expect(resourceIdOf(pr())).toBe("https://github.com/example-org/example-app/pull/203");
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
