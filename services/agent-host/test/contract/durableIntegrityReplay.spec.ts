/**
 * Tier 1 contract — history must survive a pod restart.
 *
 * LOCAL_STATE_PATH is an emptyDir: a rollout wipes it. hydrate() reloads META from the
 * mirror at startup, so every conversation reappears in the list with its title — while
 * its events.jsonl is NOT pulled. Two bugs made that unreadable rather than merely cold:
 *
 *   1. ensureReadable returned true on the in-memory entry alone, so the mirror pull was
 *      skipped for exactly the conversations that needed it.
 *   2. the integrity stream replayed via readEventsWithChecksum — LOCAL only — so it
 *      honestly reported `synced` with zero events.
 *
 * Observed live on scooter.chadac.me: 123 conversations in memory, 0 event logs local,
 * 3714 events (1.7 MB) sitting in the mirror for the one being read.
 */

import { describe, it, expect } from "vitest";

import type { AguiEvent } from "../../src/bridge.js";
import { mirroredConversationStore } from "../../src/session/mirroredStore.js";
import { createSessionManager } from "../../src/session/manager.js";
import type { ConversationStore } from "../../src/session/manager.js";

const ev = (id: string): AguiEvent => ({ type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: id }) as AguiEvent;

/** A minimal in-memory store: events per conversation, nothing else the reads need. */
function memStore(events: Record<string, AguiEvent[]>): ConversationStore {
  return {
    async *readEvents(id: string) {
      for (const e of events[id] ?? []) yield e;
    },
    async appendEvent() {},
    async listConversations() {
      return [];
    },
    async saveConversation() {},
  } as unknown as ConversationStore;
}

describe("integrity replay reads the DURABLE log", () => {
  it("THE REGRESSION: an empty local log replays the MIRROR's events", async () => {
    // The post-rollout shape: local wiped, mirror intact.
    const store = mirroredConversationStore(memStore({}), memStore({ c1: [ev("a"), ev("b"), ev("c")] }));
    const out = [];
    for await (const c of store.readEventsDurableWithChecksum("c1")) out.push(c);
    expect(out.map((c) => (c.event as { messageId: string }).messageId)).toEqual(["a", "b", "c"]);
  });

  it("chains checksums over the mirror's log so the client can verify it", async () => {
    const store = mirroredConversationStore(memStore({}), memStore({ c1: [ev("a"), ev("b")] }));
    const out = [];
    for await (const c of store.readEventsDurableWithChecksum("c1")) out.push(c);
    // Each event links to the one before: prevChecksum[n] === checksum[n-1].
    expect(out[1].prevChecksum).toBe(out[0].checksum);
    expect(out[0].checksum).not.toBe(out[1].checksum);
  });

  it("prefers LOCAL when it is the longer log (the hot authority)", async () => {
    const store = mirroredConversationStore(
      memStore({ c1: [ev("a"), ev("b"), ev("c")] }),
      memStore({ c1: [ev("a")] }), // mirror lags a live conversation
    );
    const out = [];
    for await (const c of store.readEventsDurableWithChecksum("c1")) out.push(c);
    expect(out).toHaveLength(3);
  });

  it("an empty conversation replays nothing, from either side", async () => {
    const store = mirroredConversationStore(memStore({}), memStore({}));
    const out = [];
    for await (const c of store.readEventsDurableWithChecksum("c1")) out.push(c);
    expect(out).toEqual([]);
  });

  it("a mirror read failure falls back to local rather than throwing", async () => {
    const broken = {
      // eslint-disable-next-line require-yield
      async *readEvents() {
        throw new Error("nfs down");
      },
    } as unknown as ConversationStore;
    const store = mirroredConversationStore(memStore({ c1: [ev("a")] }), broken);
    const out = [];
    for await (const c of store.readEventsDurableWithChecksum("c1")) out.push(c);
    expect(out).toHaveLength(1);
  });
});

describe("ensureReadable pulls the mirror even for a KNOWN conversation", () => {
  const fakeProvisioner = () =>
    ({
      create: async () => ({ name: "sb", namespace: "ns" }),
      resume: async (r: unknown) => r,
      suspend: async () => {},
      destroy: async () => {},
      reconcile: async () => [],
    }) as never;

  it("THE REGRESSION: an in-memory entry does NOT skip the pull", async () => {
    // hydrate() loads META from the mirror at startup, so the entry exists while its
    // events were never pulled. Short-circuiting on the entry alone left exactly those
    // conversations with an unreadable history.
    let pulls = 0;
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(),
      store: memStore({}),
      selfPod: "pod-a",
      hydrateFromMirror: async () => {
        pulls++;
        return true;
      },
    } as never);
    const conv = await sessions.start("t1" as never); // now IN MEMORY

    expect(await sessions.ensureReadable(conv.id as never)).toBe(true);
    expect(pulls, "a known conversation must still take the mirror pull").toBe(1);
  });

  it("a known conversation stays readable even when the pull finds nothing", async () => {
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(),
      store: memStore({}),
      selfPod: "pod-a",
      hydrateFromMirror: async () => false, // mirror has nothing newer
    } as never);
    const conv = await sessions.start("t1" as never);
    expect(await sessions.ensureReadable(conv.id as never)).toBe(true);
  });
});
