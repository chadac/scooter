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

  it("forwards initialize/new_session AS THEMSELVES, not as an empty prompt", async () => {
    // THE BUG THIS PINS. byocTransport POSTs every ACP request to /prompt (fine — each frame
    // carries its own `type`), but the relay rebuilt the frame with a hardcoded type:"prompt".
    // So the container saw `initialize` and `new_session` as prompts with no sessionId and no
    // text — `prompt acp-session=undefined text=""` — the ACP handshake never completed, and no
    // run could start. Every existing test here sends a prompt, so nothing caught it.
    void relay.request(sessionId, "initialize", { params: { protocolVersion: 1 } });
    expect(container.sent[0]).toMatchObject({ ch: "acp", type: "initialize" });
    expect(container.sent[0].payload).toMatchObject({ params: { protocolVersion: 1 } });

    void relay.request(sessionId, "new_session", { params: { cwd: "/w" } });
    expect(container.sent[1]).toMatchObject({ ch: "acp", type: "new_session" });
    expect(container.sent[1].payload).toMatchObject({ params: { cwd: "/w" } });
  });

  it("a cancel is forwarded as a cancel (not a prompt that would start a second run)", async () => {
    void relay.request(sessionId, "cancel", { sessionId: "acp-1" });
    expect(container.sent[0]).toMatchObject({ ch: "acp", type: "cancel" });
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

// --- the caller's frame id must ROUND-TRIP (aeonai bug: handshake hangs) --------------------

describe("caller frame-id round-trip", () => {
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
    registry.attach(sessionId, minted.token, { send: container.send.bind(container), close: () => {} });
  });

  it("THE HANG: the ack the caller receives carries the CALLER'S id, not a relay-minted one", async () => {
    // The agent-host's remoteAcpClient correlates request→ack BY FRAME ID: it sends
    // `initialize` with id A and awaits pending.get(A). The relay minted randomUUID(),
    // discarded A, and yielded the container's ack (carrying the new id) straight up — so
    // pending.get(A) never resolved, initialize() hung forever, and EVERY real BYOC run died
    // no_activity_timeout while curl probes (which don't correlate) looked healthy.
    const stream = relay.request(sessionId, "initialize", { params: { protocolVersion: 1 } }, "CALLER-ID-A");
    const collected = collect(stream);
    // The container acks with whatever id it was SENT (it echoes faithfully)...
    container.push({ ch: "acp", type: "ack", id: container.idOf(0), payload: { result: { protocolVersion: 1 } } });
    const frames = await collected;
    // ...and what reaches the CALLER must be its own id.
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe("CALLER-ID-A");
  });

  it("a caller WITHOUT an id still works (relay mints one; nothing correlates on it upstream)", async () => {
    const stream = relay.request(sessionId, "initialize", {});
    const collected = collect(stream);
    container.push({ ch: "acp", type: "ack", id: container.idOf(0), payload: {} });
    const frames = await collected;
    expect(frames).toHaveLength(1);
  });

  it("two CONCURRENT requests with caller ids each get their own ack back", async () => {
    // The map-back must be per-run, not global: interleaved acks must not swap ids.
    const s1 = collect(relay.request(sessionId, "initialize", {}, "A"));
    const s2 = collect(relay.request(sessionId, "new_session", {}, "B"));
    container.push({ ch: "acp", type: "ack", id: container.idOf(1), payload: { result: { sessionId: "sdk-1" } } });
    container.push({ ch: "acp", type: "ack", id: container.idOf(0), payload: { result: { protocolVersion: 1 } } });
    const [f1, f2] = await Promise.all([s1, s2]);
    expect(f1[0].id).toBe("A");
    expect(f2[0].id).toBe("B");
  });
});

// --- CONCURRENT conversations on one container: route by ACP session ------------------------

describe("concurrent runs on one container session", () => {
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
    registry.attach(sessionId, minted.token, { send: container.send.bind(container), close: () => {} });
  });

  it("CROSS-TALK: each conversation's stream receives ONLY its own session_updates", async () => {
    // Two conversations of one owner share the container session; each prompt names its own
    // ACP session. The relay used to broadcast every notification to every in-flight run —
    // conversation A's transcript interleaved B's output.
    const sA = collect(relay.prompt(sessionId, { sessionId: "acp-A", prompt: [{ type: "text", text: "a" }] } as never), 3);
    const sB = collect(relay.prompt(sessionId, { sessionId: "acp-B", prompt: [{ type: "text", text: "b" }] } as never), 3);

    container.push({ ch: "acp", type: "session_update", payload: { sessionId: "acp-A", update: { kind: "textA" } } });
    container.push({ ch: "acp", type: "session_update", payload: { sessionId: "acp-B", update: { kind: "textB" } } });
    container.push({ ch: "acp", type: "ack", id: container.idOf(0), payload: { result: { stopReason: "end_turn" } } });
    container.push({ ch: "acp", type: "ack", id: container.idOf(1), payload: { result: { stopReason: "end_turn" } } });

    const [a, b] = await Promise.all([sA, sB]);
    const kinds = (fs: Array<{ type?: string; payload?: unknown }>) =>
      fs.filter((f) => f.type === "session_update").map((f) => (f.payload as { update: { kind: string } }).update.kind);
    expect(kinds(a)).toEqual(["textA"]);
    expect(kinds(b)).toEqual(["textB"]);
  });

  it("EXEC frames with a sid route ONLY to the matching run (no double tool execution)", async () => {
    const sA = collect(relay.prompt(sessionId, { sessionId: "acp-A", prompt: [] } as never), 2);
    const sB = collect(relay.prompt(sessionId, { sessionId: "acp-B", prompt: [] } as never), 2);

    container.push({ ch: "exec", type: "exec_request", id: "x1", sid: "acp-B", payload: { command: "ls" } });
    container.push({ ch: "acp", type: "ack", id: container.idOf(0), payload: { result: {} } });
    container.push({ ch: "acp", type: "ack", id: container.idOf(1), payload: { result: {} } });

    const [a, b] = await Promise.all([sA, sB]);
    expect(a.some((f) => f.type === "exec_request"), "A must NOT see B's tool call").toBe(false);
    expect(b.some((f) => f.type === "exec_request")).toBe(true);
  });

  it("a LEGACY exec frame (no sid) with a SINGLE run in flight still routes exactly", async () => {
    const sA = collect(relay.prompt(sessionId, { sessionId: "acp-A", prompt: [] } as never), 2);
    container.push({ ch: "exec", type: "exec_request", id: "x1", payload: { command: "ls" } });
    container.push({ ch: "acp", type: "ack", id: container.idOf(0), payload: { result: {} } });
    const a = await sA;
    expect(a.some((f) => f.type === "exec_request")).toBe(true);
  });

  it("permission_request routes by the session inside its payload (present since day one)", async () => {
    const sA = collect(relay.prompt(sessionId, { sessionId: "acp-A", prompt: [] } as never), 2);
    const sB = collect(relay.prompt(sessionId, { sessionId: "acp-B", prompt: [] } as never), 2);
    container.push({
      ch: "acp", type: "permission_request", id: "p1",
      payload: { request: { sessionId: "acp-A", toolCallId: "t1", title: "Run ls?", options: [] } },
    });
    container.push({ ch: "acp", type: "ack", id: container.idOf(0), payload: { result: {} } });
    container.push({ ch: "acp", type: "ack", id: container.idOf(1), payload: { result: {} } });
    const [a, b] = await Promise.all([sA, sB]);
    expect(a.some((f) => f.type === "permission_request")).toBe(true);
    expect(b.some((f) => f.type === "permission_request"), "B must not see A's approval prompt").toBe(false);
  });
});

// --- Channel C: TUNNEL forwarding (MCP over the wire) ---------------------------------------

describe("tunnel frame forwarding", () => {
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
    registry.attach(sessionId, minted.token, { send: container.send.bind(container), close: () => {} });
  });

  it("forwards a cloud tunnel frame DOWN to the container", async () => {
    const r = relay.answerTunnel(sessionId, "s1", {
      ch: "tunnel", type: "chunk", id: "s1", payload: { data: "aGk=" },
    });
    expect(r.ok).toBe(true);
    expect(container.sent.at(-1)).toMatchObject({ ch: "tunnel", type: "chunk", id: "s1" });
  });

  it("a tunnel stream is NOT a run — it never terminates one", async () => {
    // The critical separation: tunnel frames share the socket with ACP runs. If a tunnel close
    // were routed through the run bookkeeping it would end the user's actual turn.
    const stream = collect(relay.prompt(sessionId, { sessionId: "acp-A", prompt: [] } as never), 2);
    relay.answerTunnel(sessionId, "s1", { ch: "tunnel", type: "close", id: "s1", payload: {} });
    // The run is still live: only its own ack ends it.
    container.push({ ch: "acp", type: "ack", id: container.idOf(0), payload: { result: {} } });
    const frames = await stream;
    expect(frames.some((f) => f.ch === "tunnel"), "a tunnel frame must not leak into a run's stream").toBe(false);
    expect(frames.at(-1)?.type).toBe("ack");
  });

  it("an OFFLINE container fails the send instead of silently dropping it", async () => {
    registry.detach(sessionId);
    const r = relay.answerTunnel(sessionId, "s1", { ch: "tunnel", type: "chunk", id: "s1", payload: {} });
    expect(r.ok).toBe(false);
  });

  it("container->cloud tunnel frames are exposed to the agent-host, not routed as run output", async () => {
    // The agent-host subscribes to these to serve MCP; they must NOT be pushed into a run's
    // SSE stream (that stream is the conversation's transcript).
    const seen: Array<{ id?: string; type: string }> = [];
    relay.onTunnelFrame?.((sid, frame) => { if (sid === sessionId) seen.push({ id: frame.id, type: frame.type }); });
    const stream = collect(relay.prompt(sessionId, { sessionId: "acp-A", prompt: [] } as never), 2);
    container.push({ ch: "tunnel", type: "open", id: "t1", sid: "acp-A", payload: { target: "scooter-env" } });
    container.push({ ch: "acp", type: "ack", id: container.idOf(0), payload: { result: {} } });
    const frames = await stream;
    expect(seen.map((s) => s.type)).toContain("open");
    expect(frames.some((f) => f.ch === "tunnel")).toBe(false);
  });
});
