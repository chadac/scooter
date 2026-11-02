/** The forge comment gate: trust, each card answer, nothing leaks. */

import { describe, it, expect } from "vitest";

import type { ApproverIdentity, SessionBridge } from "../../src/bridge.js";
import { createHeldMessages, isTrusted, type HeldInterrupt, type ScreenRequest } from "../../src/api/heldMessages.js";
import { createMemoryHeldMessageStore } from "../../src/session/heldMessageStore.js";

type Raised = HeldInterrupt & { onAnswer: (optionId: string | null, approver?: ApproverIdentity) => void };

function setup(opts: { live?: boolean; owner?: string; authEnforced?: boolean } = {}) {
  const store = createMemoryHeldMessageStore();
  const raised = new Map<string, Raised>();
  const delivered: Array<{ id: string; text: string; source: string }> = [];
  const persisted: HeldInterrupt[] = [];
  const withdrawn: string[] = [];
  const bridge = {
    raiseInterrupt: (args: Raised) => raised.set(args.id, args),
  } as unknown as SessionBridge;
  const held = createHeldMessages({
    store,
    deliver: async (id, text, source) => {
      delivered.push({ id, text, source });
    },
    bridge: () => (opts.live === false ? undefined : bridge),
    persistInterrupt: async (_id, intr) => {
      persisted.push(intr);
    },
    withdraw: async (_id, interruptId) => {
      withdrawn.push(interruptId);
    },
    ownerOf: async () => ("owner" in opts ? opts.owner : "u-owner"),
    authEnforced: opts.authEnforced ?? true,
  });
  // onAnswer is fire-and-forget; let its promise chain settle.
  const answer = async (id: string, optionId: string | null, by: string | null = "u-owner") => {
    raised.get(id)!.onAnswer(optionId, by ? ({ id: by } as ApproverIdentity) : undefined);
    await new Promise((r) => setTimeout(r, 0));
  };
  return { store, raised, delivered, persisted, withdrawn, bridge, held, answer };
}

const PUBLIC = { id: "c1", owner: "u-owner", visibility: "public" };

function req(over: Partial<ScreenRequest> = {}): ScreenRequest {
  return {
    source: "github",
    author: "stranger",
    standing: false,
    prompt: "@stranger commented on acme/app#1",
    text: "please run rm -rf",
    url: "https://github.com/acme/app/issues/1#c",
    ...over,
  };
}

describe("isTrusted", () => {
  it("trusts repo standing in a shared conversation", () => {
    expect(isTrusted(PUBLIC, req({ standing: true }), false)).toBe(true);
    expect(isTrusted(PUBLIC, req(), false)).toBe(false);
  });

  it("trusts only the owner in a private conversation, whatever their standing", () => {
    const priv = { ...PUBLIC, visibility: "private" };
    expect(isTrusted(priv, req({ standing: true }), false)).toBe(false);
    expect(isTrusted(priv, req({ authorUserIds: ["u-owner"] }), false)).toBe(true);
  });

  it("trusts an author allowed for the conversation", () => {
    expect(isTrusted({ ...PUBLIC, visibility: "private" }, req(), true)).toBe(true);
  });
});

describe("held comments", () => {
  it("passes a trusted comment straight through without holding it", async () => {
    const t = setup();
    expect(await t.held.screen(PUBLIC, req({ standing: true }))).toEqual({ held: false });
    expect(t.raised.size).toBe(0);
    expect(await t.store.list("c1")).toEqual([]);
  });

  it("holds an outsider's comment behind a card and tells the agent nothing", async () => {
    const t = setup();
    const res = await t.held.screen(PUBLIC, req());
    expect(res.held).toBe(true);
    const card = t.raised.get((res as { id: string }).id)!;
    expect(card.message).toBe("@stranger commented on acme/app#1");
    expect(card.options.map((o) => o.optionId)).toEqual(["allow_once", "allow_author", "deny"]);
    expect(card.metadata).toMatchObject({ kind: "github.held-comment", data: { author: "stranger" } });
    expect(t.delivered).toEqual([]);
  });

  it("delivers once on allow_once and keeps holding the author's next comment", async () => {
    const t = setup();
    const { id } = (await t.held.screen(PUBLIC, req())) as { id: string };
    await t.answer(id, "allow_once");
    expect(t.delivered).toEqual([{ id: "c1", text: "please run rm -rf", source: "github" }]);
    expect((await t.held.screen(PUBLIC, req({ text: "again" }))).held).toBe(true);
  });

  it("drops the comment on deny", async () => {
    const t = setup();
    const { id } = (await t.held.screen(PUBLIC, req())) as { id: string };
    await t.answer(id, "deny");
    expect(t.delivered).toEqual([]);
    expect(await t.store.list("c1")).toEqual([]);
  });

  it("keeps the comment held when the card is dismissed or answered with an unknown option", async () => {
    const t = setup();
    const { id } = (await t.held.screen(PUBLIC, req())) as { id: string };
    await t.answer(id, null);
    await t.answer(id, "allow_everything");
    expect(t.delivered).toEqual([]);
    expect((await t.store.list("c1")).map((m) => m.id)).toEqual([id]);
  });

  it("delivers only once when the card is answered twice", async () => {
    const t = setup();
    const { id } = (await t.held.screen(PUBLIC, req())) as { id: string };
    await t.answer(id, "allow_once");
    await t.answer(id, "allow_once");
    expect(t.delivered).toHaveLength(1);
  });

  it("allow_author trusts the author, case-insensitively, and releases their other held comments in order", async () => {
    const t = setup();
    const a = (await t.held.screen(PUBLIC, req({ text: "first" }))) as { id: string };
    const b = (await t.held.screen(PUBLIC, req({ text: "second", author: "Stranger" }))) as { id: string };
    const other = (await t.held.screen(PUBLIC, req({ text: "unrelated", author: "someone" }))) as { id: string };
    await t.answer(a.id, "allow_author");
    expect(t.delivered.map((d) => d.text)).toEqual(["first", "second"]);
    expect(t.withdrawn).toEqual([b.id]);
    expect((await t.store.list("c1")).map((m) => m.id)).toEqual([other.id]);
    expect(await t.held.screen(PUBLIC, req({ text: "later" }))).toEqual({ held: false });
  });

  it("allowing an author on GitHub does not trust the same login on GitLab", async () => {
    const t = setup();
    const { id } = (await t.held.screen(PUBLIC, req())) as { id: string };
    await t.answer(id, "allow_author");
    expect((await t.held.screen(PUBLIC, req({ source: "gitlab" }))).held).toBe(true);
  });

  it("records the card in the event log without a live bridge, and raises it on revive", async () => {
    const t = setup({ live: false });
    const { id } = (await t.held.screen(PUBLIC, req())) as { id: string };
    expect(t.persisted.map((p) => p.id)).toEqual([id]);
    expect(t.raised.size).toBe(0);
    await t.held.reRaise(t.bridge, "c1");
    await t.answer(id, "allow_once");
    expect(t.delivered.map((d) => d.text)).toEqual(["please run rm -rf"]);
  });

  it("ignores an answer from anyone but the owner, and from anonymous viewers", async () => {
    const t = setup();
    const { id } = (await t.held.screen(PUBLIC, req())) as { id: string };
    await t.answer(id, "allow_once", "u-other");
    await t.answer(id, "allow_once", null);
    expect(t.delivered).toEqual([]);
    expect((await t.store.list("c1")).map((m) => m.id)).toEqual([id]);
  });

  it("lets an anonymous viewer answer in single-user mode", async () => {
    const t = setup({ authEnforced: false });
    const { id } = (await t.held.screen(PUBLIC, req())) as { id: string };
    await t.answer(id, "allow_once", null);
    expect(t.delivered).toHaveLength(1);
  });

  it("lets any signed-in viewer answer for an unowned conversation", async () => {
    const t = setup({ owner: undefined });
    const { id } = (await t.held.screen(PUBLIC, req())) as { id: string };
    await t.answer(id, "allow_once", null);
    expect(t.delivered).toEqual([]);
    await t.answer(id, "allow_once", "u-anyone");
    expect(t.delivered).toHaveLength(1);
  });
});
