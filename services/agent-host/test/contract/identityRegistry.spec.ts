/**
 * The identity registry keys an account by (provider, external_id), so a rename only
 * refreshes the handle and never mints a second identity for the same person.
 */

import { describe, it, expect } from "vitest";

import { drizzle } from "drizzle-orm/node-postgres";

import { createMemoryIdentityRegistry, createPgIdentityRegistry } from "../../src/session/identityRegistry.js";

type Call = { sql: string; params: unknown[] };

/** A pg client under Drizzle that records SQL and answers RETURNING with `id`. */
function recordingDb(id: string) {
  const calls: Call[] = [];
  const client = {
    async query(cfg: unknown, paramsIn: unknown[] = []) {
      const sql = typeof cfg === "string" ? cfg : ((cfg as { text: string }).text ?? "");
      const params = (typeof cfg === "object" && (cfg as { values?: unknown[] }).values) || paramsIn;
      calls.push({ sql, params: [...params] });
      return { rows: [[id]], rowCount: 1 };
    },
  };
  return { db: drizzle(client as never), calls };
}

describe("pg identity registry", () => {
  it("upserts on (provider, external_id), refreshes only display fields, and returns the stored id", async () => {
    const { db, calls } = recordingDb("ident-stored");
    const reg = createPgIdentityRegistry({ db, now: () => 7 });

    const id = await reg.upsert({ provider: "github", externalId: "29139614", handle: "renovate[bot]" });

    expect(id).toBe("ident-stored");
    const [call] = calls;
    expect(call.sql).toMatch(/insert into "identities"/i);
    expect(call.sql).toMatch(/on conflict \("provider","external_id"\) do update set "handle" = excluded\.handle, "display_name" = excluded\.display_name, "updated_at" = excluded\.updated_at/i);
    // A conflict never rewrites the id or the account link.
    expect(call.sql).not.toMatch(/set[^]*"id" =/i);
    expect(call.sql).not.toMatch(/"scooter_user" = excluded/i);
    expect(call.sql).toMatch(/returning "id"/i);
    expect(call.params).toContain("29139614");
  });
});

describe("memory identity registry", () => {
  it("returns the same id for the same account across a rename", async () => {
    const reg = createMemoryIdentityRegistry();
    const a = await reg.upsert({ provider: "github", externalId: "1", handle: "alice" });
    const b = await reg.upsert({ provider: "github", externalId: "1", handle: "alice-renamed" });
    const c = await reg.upsert({ provider: "gitlab", externalId: "1", handle: "alice" });
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect([...reg.rows.values()].find((r) => r.id === a)?.handle).toBe("alice-renamed");
  });
});

describe("identity links", () => {
  it("pg: link frees the user's other account of that provider, then upserts this one as theirs", async () => {
    const { db, calls } = recordingDb("ident-stored");
    await createPgIdentityRegistry({ db, now: () => 7 }).link({ provider: "github", externalId: "42", handle: "octo" }, "alice");

    const update = calls.find((c) => /^update "identities"/i.test(c.sql))!;
    expect(update.sql).toMatch(/set "scooter_user" = \$1/i);
    expect(update.sql).toMatch(/"provider" = \$\d+ and "identities"\."scooter_user" = \$\d+ and "identities"\."external_id" <> \$\d+/i);
    expect(update.params).toEqual(expect.arrayContaining(["github", "alice", "42"]));
    const insert = calls.find((c) => /^insert into "identities"/i.test(c.sql))!;
    expect(insert.sql).toMatch(/do update set "handle" = excluded\.handle, "scooter_user" = excluded\.scooter_user/i);
    expect(insert.params).toEqual(expect.arrayContaining(["github", "42", "octo", "alice"]));
    expect(calls.indexOf(update)).toBeLessThan(calls.indexOf(insert));
  });

  it("pg: unlink clears only the user's account of that provider", async () => {
    const { db, calls } = recordingDb("x");
    await createPgIdentityRegistry({ db, now: () => 7 }).unlink("gitlab", "alice");
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/^update "identities" set "scooter_user" = \$1, "updated_at" = \$2 where \("identities"\."provider" = \$3 and "identities"\."scooter_user" = \$4\)/i);
    expect(calls[0].params).toEqual([null, 7, "gitlab", "alice"]);
  });

  it("memory: a webhook upsert keeps the link, and relinking moves it", async () => {
    const reg = createMemoryIdentityRegistry();
    await reg.link({ provider: "github", externalId: "1", handle: "alice" }, "u-alice");
    await reg.upsert({ provider: "github", externalId: "1", handle: "alice-renamed" });
    const userOf = (id: string) => [...reg.rows.values()].find((r) => r.externalId === id)?.scooterUser;
    expect(userOf("1")).toBe("u-alice");
    await reg.link({ provider: "github", externalId: "2", handle: "alice2" }, "u-alice");
    expect(userOf("1")).toBeUndefined();
    expect(userOf("2")).toBe("u-alice");
    await reg.unlink("github", "u-alice");
    expect(userOf("2")).toBeUndefined();
  });
});
