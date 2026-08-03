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
import { normalizeEmail } from "../../src/auth/email.js";

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
      // Mirror the real Pg store: normalize the email on write so the fake stays a
      // faithful stand-in (else it diverges from prod on +tag/case matching).
      const stored = rec.email ? { ...rec, email: normalizeEmail(rec.email) || undefined } : rec;
      puts.push({ id, email: stored.email });
      data.set(id, stored);
    }),
    getByEmail: vi.fn(async (email: string) => {
      const target = normalizeEmail(email);
      if (!target) return undefined;
      for (const [id, rec] of data) if (rec.email && normalizeEmail(rec.email) === target) return { id };
      return undefined;
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

describe("IdentityStore.getByEmail (external-user reverse lookup)", () => {
  it("returns the Scooter user id for a known email (case-insensitive)", async () => {
    const store = fakeStore({ "sub-1": { email: "Alice@Example.com", name: "Alice" } });
    expect(await store.getByEmail("alice@example.com")).toEqual({ id: "sub-1" });
    expect(await store.getByEmail("ALICE@EXAMPLE.COM")).toEqual({ id: "sub-1" });
  });

  it("matches regardless of a +tag / case (the same mailbox → one user)", async () => {
    // Stored one way; a webhook resolves the invoking user's email a DIFFERENT
    // cosmetic way — they must still map to the same Scooter user.
    const store = fakeStore({ "sub-1": { email: "alice@example.com" } });
    expect(await store.getByEmail("Alice+slack@Example.com")).toEqual({ id: "sub-1" });
    expect(await store.getByEmail("alice+github@example.com")).toEqual({ id: "sub-1" });

    // And the reverse: stored WITH a tag, looked up plain.
    const store2 = fakeStore({ "sub-2": { email: "Bob+work@Corp.com" } });
    expect(await store2.getByEmail("bob@corp.com")).toEqual({ id: "sub-2" });
  });

  it("returns undefined when no user has that email", async () => {
    const store = fakeStore({ "sub-1": { email: "alice@example.com" } });
    expect(await store.getByEmail("bob@example.com")).toBeUndefined();
  });

  it("returns undefined for an empty email", async () => {
    const store = fakeStore({ "sub-1": { email: "alice@example.com" } });
    expect(await store.getByEmail("")).toBeUndefined();
    expect(await store.getByEmail("   ")).toBeUndefined();
  });
});
