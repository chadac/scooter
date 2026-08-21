/**
 * UI unit test — toRepositorySnapshot: fold our message array into an
 * ExportedMessageRepository for the INCREMENTAL external-store render path.
 *
 * The load-bearing property is ID STABILITY: the same logical message keeps its id
 * across pushes (so the core's per-message reconcile keeps it in place, no re-paint),
 * and the parent chain + head are linear/chronological (so the newest turn stays the
 * pinned leaf). fromBranchableArray throws on a missing id — this guards that too.
 */

import { describe, it, expect } from "vitest";

import { toRepositorySnapshot } from "./messageRepository.js";

const msg = (id: string, role: "user" | "assistant", text: string) => ({
  id,
  role,
  content: [{ type: "text", text }],
});

describe("toRepositorySnapshot", () => {
  it("builds a linear parent chain with the last message as the head", () => {
    const snap = toRepositorySnapshot([
      msg("u1", "user", "hi"),
      msg("a1", "assistant", "hello"),
      msg("u2", "user", "bye"),
    ]);
    expect(snap.messages.map((m) => m.message.id)).toEqual(["u1", "a1", "u2"]);
    expect(snap.messages.map((m) => m.parentId)).toEqual([null, "u1", "a1"]);
    expect(snap.headId).toBe("u2");
  });

  it("PRESERVES ids (does not re-generate) — the incremental-reconcile invariant", () => {
    const snap = toRepositorySnapshot([msg("stable-1", "user", "x"), msg("stable-2", "assistant", "y")]);
    expect(snap.messages.map((m) => m.message.id)).toEqual(["stable-1", "stable-2"]);
  });

  it("an empty list yields an empty repo with a null head", () => {
    const snap = toRepositorySnapshot([]);
    expect(snap.messages).toEqual([]);
    expect(snap.headId).toBeNull();
  });

  it("keeps ids stable across two folds where only the tail grew (add, not rebuild)", () => {
    const first = toRepositorySnapshot([msg("u1", "user", "a"), msg("a1", "assistant", "b")]);
    const second = toRepositorySnapshot([
      msg("u1", "user", "a"),
      msg("a1", "assistant", "b"),
      msg("u2", "user", "c"),
    ]);
    // The first two messages keep the SAME ids in the grown snapshot — so the core
    // reconciles by adding only u2, not by replacing u1/a1.
    expect(second.messages.slice(0, 2).map((m) => m.message.id)).toEqual(
      first.messages.map((m) => m.message.id),
    );
    expect(second.headId).toBe("u2");
  });
});

describe("duplicate message ids must not crash the UI", () => {
  it("dedupes by id instead of throwing (a duplicate used to WHITE-SCREEN the app)", () => {
    // fromBranchableArray links each item into a parent tree; linking the same id twice
    // throws inside assistant-ui ("A message with the same id already exists in the
    // parent tree"). That throw happens during render, so it unmounts
    // <ConversationRuntime> and the user gets a BLANK PAGE — the whole conversation is
    // unreachable. Seen on CI reloading a revived conversation. Building the snapshot
    // must never be able to do that.
    const dup = [
      { id: "m1", role: "user", content: "hello" },
      { id: "m2", role: "assistant", content: "hi" },
      { id: "m1", role: "user", content: "hello" }, // the duplicate
    ];
    expect(() => toRepositorySnapshot(dup)).not.toThrow();
    const snap = toRepositorySnapshot(dup);
    const ids = snap.messages.map((m) => (m.message as { id: string }).id);
    expect(ids.filter((id) => id === "m1")).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length); // no id appears twice
  });

  it("keeps the FIRST occurrence and still pins the head to the last unique message", () => {
    const dup = [
      { id: "a", role: "user", content: "first" },
      { id: "a", role: "user", content: "repeat" },
      { id: "b", role: "assistant", content: "reply" },
    ];
    const snap = toRepositorySnapshot(dup);
    expect(snap.headId).toBe("b");
    expect(snap.messages).toHaveLength(2);
  });
});
