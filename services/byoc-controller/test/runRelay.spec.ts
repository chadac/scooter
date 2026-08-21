/**
 * Tier 1 contract — the BYOC run path (increment 2 of todo/docs/BYO_CLAUDE_REMOTE_AGENT.md §M).
 *
 *   agent-host --POST /byoc/:session/prompt--> controller --WS--> container
 *   agent-host <----------- SSE (ACP frames) --controller <--WS-- container
 *
 * Why HTTP/SSE and not a socket from each pod (§L decision 1): the pod holds NO state, so any
 * replica can serve any conversation and a rollout cannot strand a run. The controller owns the one
 * duplex WS to the container; everything above it is stateless and retryable.
 *
 * Tested against a FAKE container socket so the transport is proven before the real container is
 * repointed at it. The failure modes matter as much as the happy path — a relay that HANGS when the
 * container vanishes is worse than one that errors, because the agent-host's run never terminates.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { createSessionRegistry, type SessionRegistry, type SessionStore } from "../src/sessionRegistry.js";
import { createRunRelay, type RunRelay } from "../src/runRelay.js";
import type { WireFrame } from "../src/remoteProtocol.js";

const SECRET = "test-secret";

function fakeStore(): SessionStore {
  const rows = new Map<string, { sessionId: string; status: "online" | "offline" }>();
  return {
    async put(owner, sessionId) { rows.set(owner, { sessionId, status: "offline" }); },
    async setStatus(owner, status) { const r = rows.get(owner); if (r) r.status = status; },
    async getByOwner(owner) { const r = rows.get(owner); return r ? { owner, ...r } : null; },
    async close() {},
  };
}

/** A fake container: records what the controller sends, and can push frames back. */
function fakeContainer() {
  const sent: WireFrame[] = [];
  let onMessage: ((raw: string) => void) | undefined;
  return {
    sent,
    closed: false,
    send(raw: string) { sent.push(JSON.parse(raw) as WireFrame); },
    close() { this.closed = true; },
    /** Wire the controller's inbound handler (the real one comes from the ws 'message' event). */
    bind(handler: (raw: string) => void) { onMessage = handler; },
    /** Simulate the container pushing a frame up. */
    push(frame: WireFrame) { onMessage?.(JSON.stringify(frame)); },
    /** The id the controller assigned to the Nth frame it sent (for correlating an ack). */
    idOf(n = 0) { return sent[n]?.id as string; },
  };
}

/** Drain an async iterable of SSE events into an array (the agent-host's read side). */
async function collect<T>(it: AsyncIterable<T>, max = 50): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) {
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

describe("BYOC run relay", () => {
  let registry: SessionRegistry;
  let relay: RunRelay;
  let container: ReturnType<typeof fakeContainer>;
  let sessionId: string;

  beforeEach(async () => {
    registry = createSessionRegistry({ store: fakeStore(), secret: SECRET });
    relay = createRunRelay({ registry });
    const minted = await registry.mint("alice");
    sessionId = minted.sessionId;
    container = fakeContainer();
    container.bind((raw) => relay.onContainerFrame(sessionId, raw));
    registry.attach(sessionId, minted.token, container);
  });

  it("a prompt reaches the container as an ACP prompt frame with a correlation id", async () => {
    void relay.prompt(sessionId, { sessionId: "acp-1", prompt: [{ type: "text", text: "hello" }] });
    expect(container.sent).toHaveLength(1);
    expect(container.sent[0]).toMatchObject({ ch: "acp", type: "prompt" });
    expect(container.sent[0].id, "every request carries an id so its ack can be correlated").toMatch(/\S/);
  });

  it("session_update frames stream back as SSE events, in order, until the ack ends the run", async () => {
    const stream = relay.prompt(sessionId, { sessionId: "acp-1", prompt: [{ type: "text", text: "hi" }] });
    const id = container.idOf();
    container.push({ ch: "acp", type: "session_update", payload: { sessionId: "acp-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "one" } } } });
    container.push({ ch: "acp", type: "session_update", payload: { sessionId: "acp-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "two" } } } });
    container.push({ ch: "acp", type: "ack", id, payload: { result: { stopReason: "end_turn" } } });

    const events = await collect(stream);
    expect(events.map((e) => e.type)).toEqual(["session_update", "session_update", "ack"]);
    // Order is the whole contract for a token stream — a reordered chunk is corrupt output.
    const texts = events
      .filter((e) => e.type === "session_update")
      .map((e) => ((e.payload as { update: { content: { text: string } } }).update.content.text));
    expect(texts).toEqual(["one", "two"]);
  });

  it("the stream ENDS on the ack (the run is over — a stream left open would hang the agent-host)", async () => {
    const stream = relay.prompt(sessionId, { sessionId: "acp-1", prompt: [] });
    container.push({ ch: "acp", type: "ack", id: container.idOf(), payload: { result: { stopReason: "end_turn" } } });
    const events = await collect(stream);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("ack");
  });

  it("an ack carrying an ERROR still terminates the stream (a failed run must not hang either)", async () => {
    const stream = relay.prompt(sessionId, { sessionId: "acp-1", prompt: [] });
    container.push({ ch: "acp", type: "ack", id: container.idOf(), payload: { error: "model refused" } });
    const events = await collect(stream);
    expect(events).toHaveLength(1);
    expect((events[0].payload as { error?: string }).error).toBe("model refused");
  });

  it("a prompt for a session with NO attached container fails fast — it does not hang", async () => {
    registry.detach(sessionId);
    await expect(collect(relay.prompt(sessionId, { sessionId: "acp-1", prompt: [] }))).rejects.toThrow(/not connected|offline/i);
  });

  it("a prompt for an UNKNOWN session fails fast", async () => {
    await expect(collect(relay.prompt("no-such-session", { sessionId: "acp-1", prompt: [] }))).rejects.toThrow(/unknown session/i);
  });

  it("a MID-RUN container disconnect closes the stream instead of hanging forever", async () => {
    const stream = relay.prompt(sessionId, { sessionId: "acp-1", prompt: [] });
    container.push({ ch: "acp", type: "session_update", payload: { sessionId: "acp-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } } } });
    relay.onContainerGone(sessionId); // the ws 'close' event
    const events = await collect(stream);
    // The partial output survives, then a terminal frame — the agent-host can surface a RUN_ERROR
    // rather than waiting on a container that will never answer.
    expect(events[0].type).toBe("session_update");
    expect(events.at(-1)?.type).toBe("ack");
    expect((events.at(-1)?.payload as { error?: string }).error).toMatch(/disconnect/i);
  });

  it("frames for a DIFFERENT run id are not delivered into this run's stream", async () => {
    const stream = relay.prompt(sessionId, { sessionId: "acp-1", prompt: [] });
    // An ack for some other in-flight request must not terminate this one. With two runs
    // multiplexed on ONE container socket, mis-correlation would cross users' output.
    container.push({ ch: "acp", type: "ack", id: "some-other-id", payload: { result: {} } });
    container.push({ ch: "acp", type: "ack", id: container.idOf(), payload: { result: { stopReason: "end_turn" } } });
    const events = await collect(stream);
    expect(events).toHaveLength(1);
  });

  it("two CONCURRENT runs on the same container each receive only their own frames", async () => {
    const a = relay.prompt(sessionId, { sessionId: "acp-a", prompt: [] });
    const b = relay.prompt(sessionId, { sessionId: "acp-b", prompt: [] });
    const idA = container.idOf(0);
    const idB = container.idOf(1);
    expect(idA).not.toBe(idB);
    container.push({ ch: "acp", type: "ack", id: idB, payload: { result: { stopReason: "b-done" } } });
    container.push({ ch: "acp", type: "ack", id: idA, payload: { result: { stopReason: "a-done" } } });
    const [ea, eb] = await Promise.all([collect(a), collect(b)]);
    expect((ea[0].payload as { result: { stopReason: string } }).result.stopReason).toBe("a-done");
    expect((eb[0].payload as { result: { stopReason: string } }).result.stopReason).toBe("b-done");
  });
});
