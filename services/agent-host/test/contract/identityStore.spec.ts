/**
 * Tier 1 contract — the generic sub->email identity store decorator.
 *
 * withIdentityStore wraps ANY resolver: it write-throughs learned (id,email)
 * pairs and fills in a missing email from the static map, then the store. Best-
 * effort: a store error never breaks resolution. Provider-agnostic.
 */

import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage } from "node:http";

import type { IdentityResolver, UserContext } from "../../src/auth/identity.js";
import { withIdentityStore, type IdentityStore } from "../../src/auth/identityStore.js";

const req = {} as IncomingMessage;

/** A resolver that returns a fixed UserContext. */
function fixedResolver(user: UserContext): IdentityResolver {
  return { resolve: () => user };
}

function fakeStore(seed: Record<string, { email?: string; name?: string }> = {}): IdentityStore & {
  puts: Array<{ id: string; email?: string }>;
} {
  const data = new Map(Object.entries(seed));
  const puts: Array<{ id: string; email?: string }> = [];
  return {
    puts,
    get: vi.fn(async (id: string) => data.get(id)),
    put: vi.fn(async (id: string, rec: { email?: string; name?: string }) => {
      puts.push({ id, email: rec.email });
      data.set(id, rec);
    }),
    close: vi.fn(async () => {}),
  };
}

describe("withIdentityStore", () => {
  it("passes anonymous through untouched (no lookup, no write)", async () => {
    const store = fakeStore();
    const r = withIdentityStore(fixedResolver({ id: "anonymous", anonymous: true }), { store });
    const u = await r.resolve(req);
    expect(u.anonymous).toBe(true);
    expect(store.get).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
  });

  it("WRITES THROUGH a resolved (id,email) so the mapping is learned", async () => {
    const store = fakeStore();
    const r = withIdentityStore(fixedResolver({ id: "sub-1", email: "a@x.io", anonymous: false }), { store });
    const u = await r.resolve(req);
    expect(u.email).toBe("a@x.io");
    // fire-and-forget put — let the microtask run.
    await Promise.resolve();
    expect(store.puts).toContainEqual({ id: "sub-1", email: "a@x.io" });
  });

  it("FILLS IN a missing email from the static map first", async () => {
    const store = fakeStore({ "sub-2": { email: "stale@x.io" } });
    const r = withIdentityStore(fixedResolver({ id: "sub-2", anonymous: false }), {
      store,
      staticMap: { "sub-2": "mapped@x.io" },
    });
    const u = await r.resolve(req);
    expect(u.email).toBe("mapped@x.io"); // static map wins over the store
  });

  it("FILLS IN a missing email from the store when not in the map", async () => {
    const store = fakeStore({ "sub-3": { email: "learned@x.io", name: "Cee" } });
    const r = withIdentityStore(fixedResolver({ id: "sub-3", anonymous: false }), { store });
    const u = await r.resolve(req);
    expect(u.email).toBe("learned@x.io");
    expect(u.name).toBe("Cee");
  });

  it("leaves email undefined when neither map nor store knows the id", async () => {
    const store = fakeStore();
    const r = withIdentityStore(fixedResolver({ id: "sub-4", anonymous: false }), { store });
    const u = await r.resolve(req);
    expect(u.id).toBe("sub-4");
    expect(u.email).toBeUndefined();
  });

  it("a store error never breaks resolution — degrades to no email", async () => {
    const store = fakeStore();
    store.get = vi.fn(async () => { throw new Error("db down"); });
    const r = withIdentityStore(fixedResolver({ id: "sub-5", anonymous: false }), { store });
    const u = await r.resolve(req); // must NOT throw
    expect(u).toMatchObject({ id: "sub-5", anonymous: false });
    expect(u.email).toBeUndefined();
  });
});
