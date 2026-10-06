/**
 * Tier 1 contract — deleting a conversation must drop EVERY half of it.
 *
 * A conversation is spread across four stores: the `conversations` row (the list), the
 * per-conversation directory on the state volume, the `conversation_events` rows (the log),
 * and the `resource_links` rows. index.ts composes them into one ConversationStore, and
 * `removeConversation` is the only place that has to undo all four.
 *
 * It did not. The event rows were never dropped — eventStore.removeConversation existed and
 * its doc comment said "the caller is responsible for the event rows (see index.ts)", but
 * index.ts only deleted meta + files + links. Nothing noticed, because the composition was
 * an anonymous object literal inside main() that no test could reach.
 *
 * The cost was not a disk leak. The surviving rows kept an orphan RUN_STARTED alive, which
 * every adoption path rediscovers as a dangling run and settles by re-registering the
 * conversation it was just deleted from; and the store's cached seq head survived with it,
 * so the same id coming back derived a seq another writer already held. In CI one
 * conversation survived 150 consecutive DELETEs and took the rest of the shard with it.
 * Why: PR #723.
 *
 * So this file pins the composition itself, with fakes for the four halves. It is
 * deliberately not a test of any one store — each has its own — but of the thing that has
 * to remember all of them.
 */

import { describe, it, expect } from "vitest";

import { pgStoreOverrides } from "../../src/index.js";
import type { ConversationStore, ConversationMeta } from "../../src/session/manager.js";
import type { SessionId } from "../../src/types.js";

const CONV = "conv-1" as SessionId;

/** Records which halves were asked to drop the conversation. */
function halves() {
  const dropped: string[] = [];
  return {
    dropped,
    metaStore: {
      saveMeta: async () => {},
      listConversations: async () => [] as ConversationMeta[],
      removeConversation: async (id: SessionId) => void dropped.push(`meta:${id}`),
      close: async () => {},
    },
    fileStore: {
      saveMeta: async () => {},
      removeConversation: async (id: SessionId) => void dropped.push(`files:${id}`),
    } as unknown as ConversationStore,
    eventStore: {
      removeConversation: async (id: SessionId) => void dropped.push(`events:${id}`),
    },
    linkStore: {
      addLink: async () => {},
      listLinks: async () => [],
      deleteByConversation: async (id: SessionId) => void dropped.push(`links:${id}`),
      close: async () => {},
    },
  };
}

describe("the Postgres store overlay — removeConversation", () => {
  it("THE INVARIANT: drops all four halves — meta row, files, EVENT ROWS, links", async () => {
    const h = halves();
    const overrides = pgStoreOverrides({
      fileStore: h.fileStore,
      metaStore: h.metaStore as never,
      linkStore: h.linkStore as never,
      eventStore: h.eventStore,
    });

    await overrides.removeConversation!(CONV);

    // Sorted: the ORDER is not the contract (each half is independent), the COVERAGE is.
    expect(h.dropped.sort()).toEqual([`events:${CONV}`, `files:${CONV}`, `links:${CONV}`, `meta:${CONV}`]);
  });

  it("a failing event-row delete does not fail the DELETE — nor skip the remaining halves", async () => {
    // The conversation is already gone from every listing by the time the rows are dropped,
    // so leaked rows are a leak to reconcile, not a 500 that invites a retry which 404s.
    // The links delete runs AFTER it, so a throw here would silently orphan a link row —
    // which is globally unique and would then collide with a later re-link.
    const h = halves();
    const overrides = pgStoreOverrides({
      fileStore: h.fileStore,
      metaStore: h.metaStore as never,
      linkStore: h.linkStore as never,
      eventStore: { removeConversation: async () => Promise.reject(new Error("pg is down")) },
    });

    await expect(overrides.removeConversation!(CONV)).resolves.toBeUndefined();
    expect(h.dropped, "the links half still ran").toContain(`links:${CONV}`);
  });

  it("no event store (no DSN) composes without one — the pg-less mode still deletes", async () => {
    const h = halves();
    const overrides = pgStoreOverrides({
      fileStore: h.fileStore,
      metaStore: h.metaStore as never,
      linkStore: h.linkStore as never,
    });

    await expect(overrides.removeConversation!(CONV)).resolves.toBeUndefined();
    expect(h.dropped.sort()).toEqual([`files:${CONV}`, `links:${CONV}`, `meta:${CONV}`]);
  });

  it("no meta store means NO overlay at all — the file store is left alone", async () => {
    // Without a DSN index.ts must not wrap the file store: the Proxy is skipped entirely
    // when the overlay is empty, and an overlay carrying only a delete would break that.
    const h = halves();
    const overrides = pgStoreOverrides({ fileStore: h.fileStore, eventStore: h.eventStore });
    expect(Object.keys(overrides)).toEqual([]);
  });
});
