/**
 * The sidebar's "!" state in the awaiting-input database: set upserts, null deletes, and
 * a failing database is logged and rethrown for the caller to retry into the event append that triggered it.
 */

import { describe, it, expect } from "vitest";
import type { Pool } from "pg";

import { createPgAwaitingInputStore } from "../../src/session/awaitingInputStore.js";
import type { SessionId } from "../../src/types.js";

function fakePool(fail = false) {
  const rows = new Map<string, number>();
  const pool = {
    async query(text: string, values: unknown[]) {
      if (fail) throw new Error("connection refused");
      if (/^\s*DELETE/i.test(text)) rows.delete(values[0] as string);
      else rows.set(values[0] as string, values[1] as number);
      return { rows: [] };
    },
  };
  return { pool: pool as unknown as Pool, rows };
}

const id = "c-1" as SessionId;

describe("createPgAwaitingInputStore", () => {
  it("sets, moves and clears a conversation's wait", async () => {
    const { pool, rows } = fakePool();
    const store = createPgAwaitingInputStore({ pool });
    await store.set(id, 5);
    await store.set(id, 7);
    expect(rows.get(id)).toBe(7);
    await store.set(id, null);
    expect(rows.has(id)).toBe(false);
  });

  it("logs and rethrows a database error", async () => {
    const store = createPgAwaitingInputStore({ pool: fakePool(true).pool });
    await expect(store.set(id, 5)).rejects.toThrow("connection refused");
  });
});
