import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";

import { DATABASES } from "./guard.js";

// lib/ts/scooter-schema/src/ -> repo lib/sql/
const sqlDir = (p: string) => fileURLToPath(new URL(`../../../sql/${p}`, import.meta.url));

interface Manifest {
  [db: string]: { owner: string; tables: Record<string, { writers: string[]; readers: string[] }> };
}

const manifest = parse(readFileSync(sqlDir("owners.toml"), "utf8")) as unknown as Manifest;

/** Table names a schema.sql declares (CREATE TABLE "<name>"). */
function tablesInSchema(db: string): string[] {
  const sql = readFileSync(sqlDir(`${db}/schema.sql`), "utf8");
  return [...sql.matchAll(/CREATE TABLE "([^"]+)"/g)].map((m) => m[1]).sort();
}

describe("ownership manifest (lib/sql/owners.toml)", () => {
  it("lists exactly the databases that have a schema", () => {
    expect(Object.keys(manifest).sort()).toEqual([...DATABASES].sort());
  });

  for (const db of DATABASES) {
    it(`[${db}] lists exactly the tables schema.sql defines`, () => {
      const declared = tablesInSchema(db);
      const owned = Object.keys(manifest[db].tables).sort();
      // Fails if a table is added to schema.sql without an owner (or removed).
      expect(owned).toEqual(declared);
    });

    it(`[${db}] every table names at least one writer`, () => {
      for (const [table, rule] of Object.entries(manifest[db].tables)) {
        // A LIST: a table with two legitimate writers is modelled as such rather than
        // duplicated across databases (the byoc.remote_agents failure).
        expect(Array.isArray(rule.writers), `${db}.${table} needs a writers list`).toBe(true);
        expect(rule.writers.length, `${db}.${table} needs at least one writer`).toBeGreaterThan(0);
        expect(Array.isArray(rule.readers), `${db}.${table} needs a readers list`).toBe(true);
      }
    });

    it(`[${db}] no service is both a writer and a reader of one table`, () => {
      // readers is the READ-ONLY set; a writer already implies read access, and listing
      // a service in both hides which way the dependency actually runs.
      for (const [table, rule] of Object.entries(manifest[db].tables)) {
        const both = rule.writers.filter((w) => rule.readers.includes(w));
        expect(both, `${db}.${table}: ${both.join(",")} is listed as writer AND reader`).toEqual([]);
      }
    });
  }
});

describe("remote_agents is ONE table, not two", () => {
  // It used to exist in BOTH the webhooks and byoc databases: same entity (owner /
  // status / last_seen), byoc's with an extra session_id, and nothing synchronising
  // them — so the agent-host badge and the byoc session mapping were separate truths
  // about one remote agent. See todo/draft/SHARED_DB_TABLE_OWNERSHIP.md.
  it("is declared in exactly one database", () => {
    const dbs = DATABASES.filter((db) => tablesInSchema(db).includes("remote_agents"));
    expect(dbs).toEqual(["byoc"]);
  });

  it("records BOTH writers, which is what removed the need for a second copy", () => {
    const writers = manifest.byoc.tables.remote_agents.writers;
    expect([...writers].sort()).toEqual(["agent-host", "byoc-controller"]);
  });
});
