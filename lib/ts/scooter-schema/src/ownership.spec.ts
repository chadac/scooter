import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";

import { DATABASES } from "./guard.js";

// lib/ts/scooter-schema/src/ -> repo lib/sql/
const sqlDir = (p: string) => fileURLToPath(new URL(`../../../sql/${p}`, import.meta.url));

interface Manifest {
  [db: string]: { owner: string; tables: Record<string, { writer: string; readers: string[] }> };
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

    it(`[${db}] every table names a writer`, () => {
      for (const [table, rule] of Object.entries(manifest[db].tables)) {
        expect(rule.writer, `${db}.${table} needs a writer`).toBeTruthy();
        expect(Array.isArray(rule.readers), `${db}.${table} needs a readers list`).toBe(true);
      }
    });
  }
});
