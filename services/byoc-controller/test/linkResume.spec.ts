// Tier 1: a socket drop within the grace window costs nothing.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeEach } from "vitest";

import { createSessionRegistry, type SessionRegistry, type SessionStore } from "../src/sessionRegistry.js";
import { createRunRelay, type LinkRequest, type RunRelay } from "../src/runRelay.js";
import type { WireFrame } from "../src/remoteProtocol.js";

function fakeStore(): SessionStore {
  const rows = new Map<string, { sessionId: string; status: "online" | "offline" }>();
  return {
    async put(owner, sessionId) { rows.set(owner, { sessionId, status: "offline" }); },
    async setStatus(owner, status) { const r = rows.get(owner); if (r) r.status = status; },
    async getByOwner(owner) { const r = rows.get(owner); return r ? { owner, ...r } : null; },
    async close() {},
  };
}

/** Records what the controller sends, minus link acks. */
function fakeSocket() {
  const sent: WireFrame[] = [];
  return {
    sent,
    send(raw: string) {
      const f = JSON.parse(raw) as WireFrame;
      if (f.ch !== "link") sent.push(f);
    },
    close() {},
  };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

const update = (seq: number): WireFrame => ({
  ch: "acp",
  type: "session_update",
  seq,
  payload: { sessionId: "acp-1", update: { sessionUpdate: "agent_message_chunk" } },
});

describe("BYOC link resume", () => {
  let registry: SessionRegistry;
  let relay: RunRelay;
  let sessionId: string;
  let token: string;

  beforeEach(async () => {
    registry = createSessionRegistry({ store: fakeStore(), secret: "test-secret" });
    relay = createRunRelay({ registry, linkGraceMs: 30 });
    ({ sessionId, token } = await registry.mint("alice"));
  });

  /** Attach as shell.ts does. */
  const attach = (link?: LinkRequest) => {
    const sock = fakeSocket();
    registry.attach(sessionId, token, sock);
    const attached = relay.onContainerAttached(sessionId, sock, link);
    attached.start();
    return { sock, resume: attached.resume };
  };
  const drop = (sock: ReturnType<typeof fakeSocket>) => {
    relay.onContainerClosed(sessionId, sock);
    registry.detachIfCurrent(sessionId, sock);
  };
  const push = (frame: WireFrame) => relay.onContainerFrame(sessionId, JSON.stringify(frame));

  it("a drop mid tool call keeps the run, queues the reply, and replays only what was missed", async () => {
    const first = attach({ id: "L", seq: 0 });
    expect(first.resume).toEqual({ resumed: false, seq: 0 });
    const stream = relay.prompt(sessionId, { sessionId: "acp-1", prompt: [] });
    const promptId = first.sock.sent[0].id!;
    push(update(1));
    push({ ch: "exec", type: "exec_run", id: "x-1", sid: "acp-1", seq: 2, payload: { command: "restart" } });

    drop(first.sock);
    // A reply during the drop is queued, not refused.
    expect(relay.answerExec(sessionId, "x-1", { result: { ok: true } }).ok).toBe(true);

    // The prompt (seq 1) arrived before the drop.
    const second = attach({ id: "L", seq: 1 });
    expect(second.resume).toEqual({ resumed: true, seq: 2 });
    expect(second.sock.sent.map((f) => [f.type, f.id, f.seq])).toEqual([["exec_result", "x-1", 2]]);

    // A replayed exec_run must not be delivered twice.
    push({ ch: "exec", type: "exec_run", id: "x-1", sid: "acp-1", seq: 2, payload: { command: "restart" } });
    push({ ch: "acp", type: "ack", id: promptId, seq: 3, payload: { result: { stopReason: "end_turn" } } });
    const events = await collect(stream);
    expect(events.map((e) => e.type)).toEqual(["session_update", "exec_run", "ack"]);
    expect(events.at(-1)?.payload).toEqual({ result: { stopReason: "end_turn" } });
    // The seq stays link bookkeeping.
    expect(events.every((e) => e.seq === undefined)).toBe(true);
  });

  it("a new prompt during the drop is queued, not refused", async () => {
    const first = attach({ id: "L", seq: 0 });
    drop(first.sock);
    const stream = relay.prompt(sessionId, { sessionId: "acp-1", prompt: [] });
    const second = attach({ id: "L", seq: 0 });
    expect(second.sock.sent.map((f) => f.type)).toEqual(["prompt"]);
    push({ ch: "acp", type: "ack", id: second.sock.sent[0].id, seq: 1, payload: { result: {} } });
    expect((await collect(stream)).map((e) => e.type)).toEqual(["ack"]);
  });

  it("no reconnect within the grace window fails the run as before", async () => {
    const first = attach({ id: "L", seq: 0 });
    const stream = relay.prompt(sessionId, { sessionId: "acp-1", prompt: [] });
    drop(first.sock);
    const events = await collect(stream);
    expect((events.at(-1)?.payload as { error?: string }).error).toMatch(/disconnect/i);
  });

  it("a different link (a restarted container) fails the old runs at once", async () => {
    const first = attach({ id: "L", seq: 0 });
    const stream = relay.prompt(sessionId, { sessionId: "acp-1", prompt: [] });
    drop(first.sock);
    expect(attach({ id: "L2", seq: 0 }).resume).toEqual({ resumed: false, seq: 0 });
    const events = await collect(stream);
    expect((events.at(-1)?.payload as { error?: string }).error).toMatch(/disconnect/i);
  });

  it("a claim to have frames the controller never sent is not resumed", async () => {
    const first = attach({ id: "L", seq: 0 });
    drop(first.sock);
    expect(attach({ id: "L", seq: 5 }).resume).toEqual({ resumed: false, seq: 0 });
  });

  it("a superseded socket's late close does not suspend its replacement", async () => {
    const first = attach({ id: "L", seq: 0 });
    const stream = relay.prompt(sessionId, { sessionId: "acp-1", prompt: [] });
    const second = attach({ id: "L", seq: 1 });
    drop(first.sock);
    push({ ch: "acp", type: "ack", id: first.sock.sent[0].id, seq: 1, payload: { result: {} } });
    expect((await collect(stream)).at(-1)?.payload).toEqual({ result: {} });
    expect(second.resume?.resumed).toBe(true);
  });

  it("a container without links keeps the old behaviour: the close ends its runs", async () => {
    const first = attach();
    expect(first.resume).toBeUndefined();
    const stream = relay.prompt(sessionId, { sessionId: "acp-1", prompt: [] });
    expect(first.sock.sent[0].seq).toBeUndefined();
    drop(first.sock);
    const events = await collect(stream);
    expect((events.at(-1)?.payload as { error?: string }).error).toMatch(/disconnect/i);
  });

  it("the hello is not delivered into a held run", async () => {
    const first = attach({ id: "L", seq: 0 });
    const stream = relay.prompt(sessionId, { sessionId: "acp-1", prompt: [] });
    push({ protocolVersion: 1, joinToken: "t" } as unknown as WireFrame);
    push({ ch: "acp", type: "ack", id: first.sock.sent[0].id, seq: 1, payload: { result: {} } });
    expect((await collect(stream)).map((e) => e.type)).toEqual(["ack"]);
  });

  it("link.ts is the same file on both ends of the socket", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const read = (p: string) => readFileSync(join(here, p), "utf8");
    expect(read("../src/link.ts")).toBe(read("../../remote-agent/src/link.ts"));
  });
});
