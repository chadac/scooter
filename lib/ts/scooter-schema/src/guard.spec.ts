import { describe, expect, it } from "vitest";

import { assertDatabase, type Queryable } from "./guard.js";

function fakeDb(current: string): Queryable {
  return { query: async () => ({ rows: [{ db: current }] }) };
}

describe("assertDatabase", () => {
  it("passes when connected to the expected database", async () => {
    await expect(assertDatabase(fakeDb("webhooks"), "webhooks")).resolves.toBeUndefined();
  });

  it("throws when the connected database is not the expected one", async () => {
    await expect(assertDatabase(fakeDb("broker"), "webhooks")).rejects.toThrow(/refusing to run/);
  });
});
