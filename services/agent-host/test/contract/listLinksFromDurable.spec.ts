/**
 * Tier 1 contract — listLinks() answers from the DURABLE store, not the wiped cache.
 *
 * The same defect that blanked the conversation list, in the links panel: LOCAL_STATE_PATH
 * is an emptyDir, so after a rollout it is empty while the mirror still holds every link.
 * Reading local-only made a conversation's PR links permanently invisible — writes were
 * always correct, so the data was there the whole time.
 *
 * This covers the file-backed path. A deployment with a Postgres DSN reads links from the
 * database instead (linkStore.spec.ts); this is the store that must still be right without
 * one.
 */

import { describe, it, expect } from "vitest";

import { mirroredConversationStore } from "../../src/session/mirroredStore.js";
import type { ConversationStore, ConversationLink } from "../../src/session/manager.js";
import type { SessionId } from "../../src/types.js";

const ID = "conv-1" as SessionId;

const pr = (over: Partial<ConversationLink> = {}): ConversationLink => ({
  source: "github",
  resourceType: "pull_request",
  url: "https://github.com/example-org/example-app/pull/203",
  title: "example-org/example-app #203",
  ...over,
});

/** A store whose links are explicitly controllable. */
function storeWith(links: ConversationLink[], overrides: Partial<ConversationStore> = {}): ConversationStore {
  const byConv = new Map<string, ConversationLink[]>([[ID, [...links]]]);
  return {
    appendEvent: async () => {},
    async *readEvents() {},
    gooseStatePath: (id: SessionId) => `/state/${id}`,
    addLink: async (id: SessionId, l: ConversationLink) => {
      byConv.set(id, [...(byConv.get(id) ?? []), l]);
    },
    listLinks: async (id: SessionId) => byConv.get(id) ?? [],
    ...overrides,
  } as ConversationStore;
}

describe("listLinks() reads the DURABLE store", () => {
  it("THE OUTAGE: an EMPTY local cache still lists what the mirror holds", async () => {
    // Exactly the production shape after a rollout: local emptyDir wiped, mirror intact.
    const store = mirroredConversationStore(storeWith([]), storeWith([pr()]), {});

    expect(await store.listLinks!(ID)).toEqual([pr()]);
  });

  it("UNIONs local and durable — a just-added link is not hidden", async () => {
    // The mirror write is async + coalesced, so a fresh link is local-only for a moment.
    const local = storeWith([pr({ url: "https://example.com/fresh", title: "fresh" })]);
    const durable = storeWith([pr({ url: "https://example.com/old", title: "old" })]);
    const store = mirroredConversationStore(local, durable, {});

    const titles = (await store.listLinks!(ID)).map((l) => l.title).sort();
    expect(titles).toEqual(["fresh", "old"]);
  });

  it("DEDUPES a link present in both stores", async () => {
    const store = mirroredConversationStore(storeWith([pr()]), storeWith([pr()]), {});

    expect(await store.listLinks!(ID)).toHaveLength(1);
  });

  it("degrades to LOCAL when the durable read fails, rather than blanking the panel", async () => {
    const durable = storeWith([], {
      listLinks: async () => {
        throw new Error("NFS unreachable");
      },
    });
    const store = mirroredConversationStore(storeWith([pr()]), durable, {});

    expect(await store.listLinks!(ID)).toEqual([pr()]);
  });

  it("still writes a new link to BOTH stores", async () => {
    const local = storeWith([]);
    const durable = storeWith([]);
    const store = mirroredConversationStore(local, durable, {});

    await store.addLink!(ID, pr());
    await new Promise((r) => setTimeout(r, 0)); // the mirror write is fire-and-forget

    expect(await local.listLinks!(ID)).toEqual([pr()]);
    expect(await durable.listLinks!(ID)).toEqual([pr()]);
  });
});
