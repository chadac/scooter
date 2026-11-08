// Tier 1: the resumable link loses nothing and delivers once.

import { describe, it, expect, afterEach, vi } from "vitest";

import { ACK_EVERY_FRAMES, Link } from "../src/link.js";

const parsed = (raw: string[]) => raw.map((r) => JSON.parse(r) as { ch?: string; type?: string; seq?: number; payload?: unknown });

afterEach(() => vi.useRealTimers());

describe("resumable link", () => {
  it("stamps frames in order and keeps them until the peer acks", () => {
    const out: string[] = [];
    const link = new Link("l1");
    link.attach((r) => out.push(r), 0);
    link.send({ ch: "acp", type: "a" });
    link.send({ ch: "acp", type: "b" });
    expect(parsed(out).map((f) => f.seq)).toEqual([1, 2]);
    expect(link.pending).toBe(2);
    link.receive({ ch: "link", type: "ack", payload: { seq: 1 } });
    expect(link.pending).toBe(1);
  });

  it("queues while detached and replays only what the peer lacks", () => {
    const link = new Link("l1");
    link.attach(() => {}, 0);
    link.send({ ch: "acp", type: "a" });
    link.send({ ch: "acp", type: "b" });
    link.detach();
    link.send({ ch: "exec", type: "exec_run" });
    const out: string[] = [];
    // The peer got seq 1 before the drop.
    link.attach((r) => out.push(r), 1);
    expect(parsed(out).map((f) => [f.seq, f.type])).toEqual([
      [2, "b"],
      [3, "exec_run"],
    ]);
  });

  it("delivers each seq once, so a replay is idempotent", () => {
    const link = new Link("l1");
    expect(link.receive({ ch: "acp", type: "a", seq: 1 })).toBe(true);
    expect(link.receive({ ch: "acp", type: "a", seq: 1 })).toBe(false);
    expect(link.receive({ ch: "acp", type: "b", seq: 2 })).toBe(true);
    expect(link.received).toBe(2);
    // Unstamped frames from old peers always pass.
    expect(link.receive({ ch: "acp", type: "c" })).toBe(true);
    link.dispose();
  });

  it("acks after a burst at once, and after a quiet frame within the delay", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const link = new Link("l1", { ackDelayMs: 50 });
    link.attach((r) => out.push(r), 0);
    link.receive({ ch: "acp", type: "a", seq: 1 });
    expect(out).toHaveLength(0);
    vi.advanceTimersByTime(50);
    expect(parsed(out)).toEqual([{ ch: "link", type: "ack", payload: { seq: 1 } }]);
    out.length = 0;
    for (let i = 2; i < 2 + ACK_EVERY_FRAMES; i++) link.receive({ ch: "acp", type: "a", seq: i });
    expect(parsed(out)).toEqual([{ ch: "link", type: "ack", payload: { seq: ACK_EVERY_FRAMES + 1 } }]);
    link.dispose();
  });

  it("acks on reattach what arrived just before the drop", () => {
    const link = new Link("l1", { ackDelayMs: 60_000 });
    link.attach(() => {}, 0);
    link.receive({ ch: "acp", type: "a", seq: 1 });
    link.detach();
    const out: string[] = [];
    link.attach((r) => out.push(r), 0);
    expect(parsed(out)).toEqual([{ ch: "link", type: "ack", payload: { seq: 1 } }]);
    link.dispose();
  });

  it("resumes only a peer the outbox can still catch up", () => {
    const link = new Link("l1");
    link.send({ ch: "acp", type: "a" });
    link.send({ ch: "acp", type: "b" });
    link.receive({ ch: "link", type: "ack", payload: { seq: 1 } });
    expect(link.canResume(0)).toBe(false); // seq 1 is gone from the outbox
    expect(link.canResume(1)).toBe(true);
    expect(link.canResume(2)).toBe(true);
    expect(link.canResume(3)).toBe(false); // claims a frame never sent
  });

  it("refuses to resume once the outbox overflowed", () => {
    const link = new Link("l1", { maxFrames: 2 });
    for (let i = 0; i < 3; i++) link.send({ ch: "acp", type: "a" });
    expect(link.overflowed).toBe(true);
    expect(link.pending).toBe(0);
    expect(link.canResume(3)).toBe(false);
  });

  it("writes bare frames and keeps nothing for a peer without links", () => {
    const out: string[] = [];
    const link = new Link("l1");
    link.attachLegacy((r) => out.push(r));
    link.send({ ch: "acp", type: "a" });
    expect(parsed(out)).toEqual([{ ch: "acp", type: "a" }]);
    expect(link.pending).toBe(0);
  });
});
