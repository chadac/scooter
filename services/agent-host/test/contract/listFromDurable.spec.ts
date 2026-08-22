/**
 * Tier 1 contract — listConversations() must answer from the DURABLE store, not the wiped cache.
 *
 * THE USER-FACING BUG. After a rollout every conversation vanishes from the sidebar. The data is
 * NOT lost — measured on odin: 59 conversations with full transcripts (events.jsonl + meta.json)
 * on the durable PVC, and 0 in the local emptyDir — but GET /conversations served `sessions.list()`,
 * which is populated by hydrate(), which reads `store.listConversations()`, which the mirrored
 * store delegated to LOCAL. So the one store that HAS the conversations was never asked, and all
 * five replicas reported 0.
 *
 * This is the listing half of docs/CONVERSATION_STATE_MODEL.md: the local file store is a CACHE
 * (LOCAL_STATE_PATH, an emptyDir) and must never be the thing that answers "which conversations
 * exist?". Here the durable store answers, with local used only to enrich.
 */

import { describe, it, expect } from "vitest";

import { mirroredConversationStore } from "../../src/session/mirroredStore.js";
import type { ConversationStore } from "../../src/session/manager.js";
import type { AguiEvent } from "../../src/bridge.js";

/** A store whose meta list is explicitly controllable. */
function storeWith(metas: Array<{ id: string; threadId: string; title?: string }>): ConversationStore {
  const logs = new Map<string, AguiEvent[]>();
  const byId = new Map(metas.map((m) => [m.id, { title: "", createdAt: 1, lastActivityAt: 1, ...m }]));
  return {
    appendEvent: async (id, e) => {
      (logs.get(id) ?? logs.set(id, []).get(id)!).push(e);
    },
    async *readEvents(id) {
      yield* logs.get(id) ?? [];
    },
    gooseStatePath: (id) => `/state/${id}/goose`,
    saveMeta: async (m: { id: string }) => {
      byId.set(m.id, m as never);
    },
    listConversations: async () => [...byId.values()] as never,
  } as ConversationStore;
}

describe("listConversations() reads the DURABLE store", () => {
  it("THE REGRESSION: an EMPTY local cache still lists what the durable store holds", async () => {
    // Exactly the production shape after a rollout: local emptyDir wiped, mirror intact.
    const local = storeWith([]);
    const durable = storeWith([
      { id: "conv-1", threadId: "conv-1", title: "Yesterday's work" },
      { id: "conv-2", threadId: "conv-2", title: "The other thread" },
    ]);
    const store = mirroredConversationStore(local, durable, {});

    const listed = (await store.listConversations?.()) ?? [];
    expect(listed.map((m) => m.id).sort()).toEqual(["conv-1", "conv-2"]);
  });

  it("UNIONs local and durable — a conversation created since the last mirror flush is not hidden", async () => {
    // The mirror is async/coalesced, so a just-created conversation can be local-only. Listing
    // ONLY the durable store would make it disappear for a few seconds, which is the same class
    // of bug in the other direction.
    const local = storeWith([{ id: "fresh", threadId: "fresh" }]);
    const durable = storeWith([{ id: "old", threadId: "old" }]);
    const store = mirroredConversationStore(local, durable, {});

    const listed = (await store.listConversations?.()) ?? [];
    expect(listed.map((m) => m.id).sort()).toEqual(["fresh", "old"]);
  });

  it("prefers the LOCAL copy of a conversation present in both (it is the hot path)", async () => {
    // Local is authoritative for a live conversation's latest meta (title/activity); the durable
    // copy can lag by one coalesced flush.
    const local = storeWith([{ id: "both", threadId: "both", title: "Newer title" }]);
    const durable = storeWith([{ id: "both", threadId: "both", title: "Stale title" }]);
    const store = mirroredConversationStore(local, durable, {});

    const listed = (await store.listConversations?.()) ?? [];
    expect(listed).toHaveLength(1);
    expect((listed[0] as { title?: string }).title).toBe("Newer title");
  });

  it("a durable-store read FAILURE degrades to local rather than losing the list entirely", async () => {
    // Availability: a mirror hiccup must not blank the sidebar. Local may be empty, but an empty
    // list from a broken mirror is still better than a thrown error on every page load.
    const local = storeWith([{ id: "local-only", threadId: "local-only" }]);
    const durable = storeWith([]);
    (durable as { listConversations?: () => Promise<unknown> }).listConversations = async () => {
      throw new Error("NFS unavailable");
    };
    const store = mirroredConversationStore(local, durable, {});

    const listed = (await store.listConversations?.()) ?? [];
    expect(listed.map((m) => m.id)).toEqual(["local-only"]);
  });
});
