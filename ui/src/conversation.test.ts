/**
 * Conversation — identity that survives the server assigning an id.
 *
 * The invariant under test: `key` never changes, so nothing keyed on the conversation is
 * torn down when the id arrives; and the id is unreachable until the server issues one, so
 * a synthetic id cannot leak into a URL.
 */

import { describe, it, expect, vi } from "vitest";

import { Conversation } from "./conversation.js";

const creates = (id: string | null) => vi.fn(async () => id);
const CFG = { baseUrl: "http://agent-host:8080" };

describe("Conversation identity", () => {
  it("a PENDING conversation has a key but NO server id", () => {
    const c = Conversation.pending("local-1", CFG, creates("server-1"));
    expect(c.key).toBe("local-1");
    expect(c.serverId()).toBeUndefined();
    expect(c.created).toBe(false);
  });

  it("an EXISTING conversation's key IS its id", () => {
    const c = Conversation.existing("server-1", CFG, creates(null));
    expect(c.key).toBe("server-1");
    expect(c.serverId()).toBe("server-1");
    expect(c.created).toBe(true);
  });

  it("the key does NOT change when the server assigns an id", async () => {
    // The whole point. Anything keyed on the conversation — the React runtime above all —
    // must not be torn down at the moment the id appears, because that discards the state
    // of a run already in flight (a Stop button that stops responding).
    const c = Conversation.pending("local-1", CFG, creates("server-1"));
    const keyBefore = c.key;

    await c.ensureCreated();

    expect(c.key).toBe(keyBefore);
    expect(c.serverId()).toBe("server-1");
  });
});

describe("Conversation.ensureCreated", () => {
  it("creates once and reuses the id", async () => {
    const create = creates("server-1");
    const c = Conversation.pending("local-1", CFG, create);

    expect(await c.ensureCreated()).toBe("server-1");
    expect(await c.ensureCreated()).toBe("server-1");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("never creates for an already-existing conversation", async () => {
    const create = creates("must-not-be-used");
    const c = Conversation.existing("server-1", CFG, create);

    expect(await c.ensureCreated()).toBe("server-1");
    expect(create).not.toHaveBeenCalled();
  });

  it("CONCURRENT callers share ONE create", async () => {
    // Two sends racing (or a send racing a resume) must not make two conversations.
    let calls = 0;
    const c = Conversation.pending("local-1", CFG, async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return `server-${calls}`;
    });

    const ids = await Promise.all([c.ensureCreated(), c.ensureCreated(), c.ensureCreated()]);

    expect(calls).toBe(1);
    expect(ids).toEqual(["server-1", "server-1", "server-1"]);
  });

  it("stays uncreated when creation fails, and can be retried", async () => {
    const create = vi
      .fn<[], Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("server-1");
    const c = Conversation.pending("local-1", CFG, create);

    expect(await c.ensureCreated()).toBeNull();
    expect(c.created).toBe(false);
    expect(c.serverId()).toBeUndefined();

    // A failed create must not poison the conversation — the next send retries.
    expect(await c.ensureCreated()).toBe("server-1");
    expect(c.created).toBe(true);
  });
});

describe("Conversation.withId (ACTIONS create first)", () => {
  it("creates the conversation, then runs against the server id", async () => {
    const c = Conversation.pending("local-1", CFG, creates("server-1"));

    const seen = await c.withId(async (id) => id);

    expect(seen).toBe("server-1");
    expect(c.serverId()).toBe("server-1");
  });

  it("THROWS when the conversation cannot be created", async () => {
    // The user asked for something. Silently doing nothing is a dead control.
    const c = Conversation.pending("local-1", CFG, creates(null));
    const fn = vi.fn(async (id: string) => id);

    await expect(c.withId(fn)).rejects.toThrow(/could not create/i);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("Conversation.ifCreated (READS skip the network)", () => {
  it("returns the fallback WITHOUT calling fn for a pending conversation", async () => {
    // This is what stops a fresh page load from 404ing: links/ready/web-services have no
    // answer for a conversation the server has never heard of.
    const c = Conversation.pending("local-1", CFG, creates("server-1"));
    const fn = vi.fn(async () => ["a-link"]);

    expect(await c.ifCreated(fn, [])).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("does NOT create the conversation as a side effect of a read", async () => {
    const create = creates("server-1");
    const c = Conversation.pending("local-1", CFG, create);

    await c.ifCreated(async () => "x", "fallback");

    expect(create).not.toHaveBeenCalled();
    expect(c.created).toBe(false);
  });

  it("runs against the server id once created", async () => {
    const c = Conversation.existing("server-1", CFG, creates(null));
    expect(await c.ifCreated(async (id) => id, "fallback")).toBe("server-1");
  });
});

describe("addressing the server", () => {
  it("url() and shareUrl() are UNDEFINED before the server has created it", () => {
    // The bug this exists to kill: the render stream opened against a local key and 404'd
    // three times, and the ?thread= link named a conversation the server never had.
    const c = Conversation.pending("local-1", CFG, creates("server-1"));
    expect(c.url("/events.integrity")).toBeUndefined();
    expect(c.shareUrl("https://scooter.example")).toBeUndefined();
  });

  it("addresses the SERVER id once created — never the key", async () => {
    const c = Conversation.pending("local-1", CFG, creates("server-1"));
    await c.ensureCreated();

    expect(c.url("/events.integrity")).toBe(
      "http://agent-host:8080/conversations/server-1/events.integrity",
    );
    expect(c.shareUrl("https://scooter.example")).toBe(
      "https://scooter.example/?thread=server-1",
    );
    // The local key must appear in NEITHER.
    expect(c.url("/x")).not.toContain("local-1");
    expect(c.shareUrl("https://scooter.example")).not.toContain("local-1");
  });

  it("tolerates a trailing slash on the base url", () => {
    const c = Conversation.existing("server-1", { baseUrl: "http://h:8080/" }, creates(null));
    expect(c.url("/tail")).toBe("http://h:8080/conversations/server-1/tail");
  });
});
