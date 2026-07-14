/**
 * Tier 1 contract — the in-memory ModuleRegistryStore (stage 1): module CRUD,
 * the visibility filter (own private + all public), version bump on update,
 * publish, and per-conversation attach/detach/enable with version-PINNED-at-attach.
 * The Pg impl shares this behavior (tested against the same expectations).
 * See todo/MODULE_REGISTRY.md.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { createInMemoryModuleRegistryStore } from "../../src/modules/registryStore.js";
import type { ModuleRegistryStore } from "../../src/modules/registryStore.js";

let store: ModuleRegistryStore;
beforeEach(() => {
  store = createInMemoryModuleRegistryStore();
});

const newMod = (owner: string, name: string, over = {}) => ({
  owner,
  name,
  visibility: "private" as const,
  configmap: `module-${name}`,
  ...over,
});

describe("module CRUD", () => {
  it("creates a module with version 1 + timestamps + a stable id", async () => {
    const m = await store.createModule(newMod("alice", "marimo"));
    expect(m.version).toBe(1);
    expect(m.owner).toBe("alice");
    expect(m.id).toBeTruthy();
    expect(m.createdAt).toBeGreaterThan(0);
  });

  it("update bumps the version + updatedAt", async () => {
    const m = await store.createModule(newMod("alice", "marimo"));
    const u = await store.updateModule(m.id, { description: "notebook" });
    expect(u?.version).toBe(2);
    expect(u?.description).toBe("notebook");
  });

  it("publish flips visibility to public", async () => {
    const m = await store.createModule(newMod("alice", "marimo"));
    const p = await store.publishModule(m.id);
    expect(p?.visibility).toBe("public");
  });
});

describe("visibility filter", () => {
  it("lists the viewer's OWN private modules + ALL public ones, not others' private", async () => {
    const aPriv = await store.createModule(newMod("alice", "a-priv"));
    const aPub = await store.createModule(newMod("alice", "a-pub"));
    await store.publishModule(aPub.id);
    const bPriv = await store.createModule(newMod("bob", "b-priv"));
    const bPub = await store.createModule(newMod("bob", "b-pub"));
    await store.publishModule(bPub.id);

    const visibleToAlice = (await store.listVisibleModules("alice")).map((m) => m.id);
    expect(visibleToAlice).toContain(aPriv.id); // own private
    expect(visibleToAlice).toContain(aPub.id); // own public
    expect(visibleToAlice).toContain(bPub.id); // others' public
    expect(visibleToAlice).not.toContain(bPriv.id); // others' private — hidden
  });

  it("filters by a name/description query (case-insensitive substring)", async () => {
    await store.createModule(newMod("alice", "marimo-notebook", { description: "data viz" }));
    await store.createModule(newMod("alice", "jupyter"));
    const hits = await store.listVisibleModules("alice", "MARIMO");
    expect(hits.map((m) => m.name)).toEqual(["marimo-notebook"]);
  });
});

describe("conversation attachment", () => {
  it("attaches PINNING the module's current version, enabled by default", async () => {
    const m = await store.createModule(newMod("alice", "marimo"));
    await store.updateModule(m.id, { description: "v2 now" }); // version -> 2
    const att = await store.attachModule("conv1", m.id);
    expect(att.version).toBe(2);
    expect(att.enabled).toBe(true);
  });

  it("does NOT change an existing attachment's pin when the module is later edited", async () => {
    const m = await store.createModule(newMod("alice", "marimo"));
    await store.attachModule("conv1", m.id); // pins v1
    await store.updateModule(m.id, { description: "edited" }); // module -> v2
    const [att] = await store.listConversationModules("conv1");
    expect(att.version).toBe(1); // still pinned to v1 until re-attach
  });

  it("re-attach updates the pinned version (the 'pull the update' path)", async () => {
    const m = await store.createModule(newMod("alice", "marimo"));
    await store.attachModule("conv1", m.id); // v1
    await store.updateModule(m.id, {}); // v2
    const re = await store.attachModule("conv1", m.id);
    expect(re.version).toBe(2);
    // Still one attachment (idempotent per conversation+module).
    expect(await store.listConversationModules("conv1")).toHaveLength(1);
  });

  it("enable/disable toggles an attachment", async () => {
    const m = await store.createModule(newMod("alice", "marimo"));
    await store.attachModule("conv1", m.id);
    const off = await store.setEnabled("conv1", m.id, false);
    expect(off?.enabled).toBe(false);
    expect((await store.listConversationModules("conv1"))[0].enabled).toBe(false);
  });

  it("detach removes the attachment", async () => {
    const m = await store.createModule(newMod("alice", "marimo"));
    await store.attachModule("conv1", m.id);
    await store.detachModule("conv1", m.id);
    expect(await store.listConversationModules("conv1")).toEqual([]);
  });

  it("setEnabled on a non-attached module returns undefined", async () => {
    expect(await store.setEnabled("conv1", "nope", true)).toBeUndefined();
  });
});
