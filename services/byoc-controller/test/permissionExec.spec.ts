/**
 * Tier 1 contract — permissions + the exec tunnel (increment 3, §M; resolves §L Q1/Q2).
 *
 * PERMISSIONS (Q1). ACP permission is request/response MID-RUN: the container's agent asks, then
 * BLOCKS until answered. Over HTTP/SSE that is two halves:
 *
 *   controller --SSE--> agent-host   {type:"permission_request", id, ...}
 *   agent-host --POST-> controller   /byoc/:session/permission/:id  {optionId}
 *
 * Deliberately NOT a WebSocket. A pending permission ENDS the run (bridge.ts emits RUN_FINISHED
 * with outcome:{type:"interrupt"} and parks a promise; there is NO timeout — a human may answer an
 * hour later), so a socket would have to stay open across the whole decision window and lose
 * in-flight state on every rollout. The answer is a stateless POST that mirrors what the UI already
 * does today at POST /conversations/:id/permission/:toolCallId.
 *
 * EXEC (Q2). The BYOC promise is BRAIN LOCAL / BODY CLOUD: when the user's Claude calls a tool, it
 * must run in the CLOUD sandbox. But `pods/exec` RBAC belongs to the AGENT-HOST only — granting it
 * to a service whose job is terminating untrusted user sockets would widen the blast radius exactly
 * where it should be narrowest. So the controller NEVER touches the sandbox: it relays Channel B
 * frames to the agent-host, which serves them on its EXISTING ExecBackend.
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

function fakeContainer() {
  const sent: WireFrame[] = [];
  let onMessage: ((raw: string) => void) | undefined;
  return {
    sent,
    closed: false,
    send(raw: string) { sent.push(JSON.parse(raw) as WireFrame); },
    close() { this.closed = true; },
    bind(handler: (raw: string) => void) { onMessage = handler; },
    push(frame: WireFrame) { onMessage?.(JSON.stringify(frame)); },
    idOf(n = 0) { return sent[n]?.id as string; },
    lastOfType(type: string) { return [...sent].reverse().find((f) => f.type === type); },
  };
}

async function collect<T>(it: AsyncIterable<T>, max = 50): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) { out.push(v); if (out.length >= max) break; }
  return out;
}

describe("BYOC permissions + exec relay", () => {
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

  // --- Permissions (Q1) -----------------------------------------------------------------------

  it("a permission_request from the container surfaces on the run's SSE stream", async () => {
    const stream = relay.prompt(sessionId, { sessionId: "acp-1", prompt: [] });
    container.push({
      ch: "acp", type: "permission_request", id: "perm-1",
      payload: { request: { sessionId: "acp-1", toolCallId: "tc-9", title: "Run rm -rf", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } },
    });
    container.push({ ch: "acp", type: "ack", id: container.idOf(), payload: { result: { stopReason: "end_turn" } } });
    const events = await collect(stream);
    expect(events.map((e) => e.type)).toEqual(["permission_request", "ack"]);
    // The id must ride along — it is what the agent-host POSTs back against.
    expect(events[0].id).toBe("perm-1");
  });

  it("answering a permission sends the ACP ack back down to the container", async () => {
    relay.prompt(sessionId, { sessionId: "acp-1", prompt: [] });
    container.push({
      ch: "acp", type: "permission_request", id: "perm-1",
      payload: { request: { sessionId: "acp-1", toolCallId: "tc-9", title: "Run ls", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } },
    });
    const ok = relay.answerPermission(sessionId, "perm-1", { optionId: "allow" });
    expect(ok.ok).toBe(true);
    const ack = container.lastOfType("ack");
    expect(ack).toMatchObject({ ch: "acp", type: "ack", id: "perm-1" });
    expect(ack?.payload).toMatchObject({ optionId: "allow" });
  });

  it("a CANCELLED permission is relayed as such (the user declined, not a failure)", async () => {
    relay.prompt(sessionId, { sessionId: "acp-1", prompt: [] });
    container.push({ ch: "acp", type: "permission_request", id: "perm-1", payload: { request: { sessionId: "acp-1", toolCallId: "tc-9", title: "x", options: [] } } });
    relay.answerPermission(sessionId, "perm-1", { cancelled: true });
    expect(container.lastOfType("ack")?.payload).toMatchObject({ cancelled: true });
  });

  it("an answer that arrives LATE (after a controller restart dropped the pending map) is rejected, not crashed", () => {
    // The human-decision window has no timeout, so an answer can arrive against a permission this
    // process never saw. It must fail cleanly — the agent-host surfaces "this approval expired"
    // rather than the controller throwing on an unknown id.
    const res = relay.answerPermission(sessionId, "perm-does-not-exist", { optionId: "allow" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toMatch(/unknown permission/i);
  });

  it("an answer for an unknown SESSION is rejected", () => {
    const res = relay.answerPermission("no-such-session", "perm-1", { optionId: "allow" });
    expect(res.ok).toBe(false);
  });

  it("a permission is answerable ONCE — a duplicate POST does not double-ack the container", () => {
    relay.prompt(sessionId, { sessionId: "acp-1", prompt: [] });
    container.push({ ch: "acp", type: "permission_request", id: "perm-1", payload: { request: { sessionId: "acp-1", toolCallId: "tc-9", title: "x", options: [] } } });
    expect(relay.answerPermission(sessionId, "perm-1", { optionId: "allow" }).ok).toBe(true);
    const acksAfterFirst = container.sent.filter((f) => f.type === "ack").length;
    // Two browser tabs both answering, or a retried POST, must not send a second ACP reply — the
    // container's pending call is already resolved and a second ack would desync the protocol.
    expect(relay.answerPermission(sessionId, "perm-1", { optionId: "deny" }).ok).toBe(false);
    expect(container.sent.filter((f) => f.type === "ack")).toHaveLength(acksAfterFirst);
  });

  // --- Exec tunnel (Q2) -----------------------------------------------------------------------

  it("an exec_run from the container surfaces on the SSE stream for the AGENT-HOST to serve", async () => {
    const stream = relay.prompt(sessionId, { sessionId: "acp-1", prompt: [] });
    container.push({ ch: "exec", type: "exec_run", id: "x-1", payload: { command: "ls", args: ["-la"] } });
    container.push({ ch: "acp", type: "ack", id: container.idOf(), payload: { result: { stopReason: "end_turn" } } });
    const events = await collect(stream);
    // The controller must NOT execute this itself — it has no pods/exec RBAC and must not get any
    // (§L Q2). It forwards, and the agent-host runs it on its existing ExecBackend.
    expect(events[0]).toMatchObject({ ch: "exec", type: "exec_run", id: "x-1" });
  });

  it("an exec result POSTed by the agent-host is relayed down to the container", () => {
    relay.prompt(sessionId, { sessionId: "acp-1", prompt: [] });
    container.push({ ch: "exec", type: "exec_run", id: "x-1", payload: { command: "ls" } });
    const ok = relay.answerExec(sessionId, "x-1", { result: { stdout: "file.txt\n", stderr: "", exitCode: 0 } });
    expect(ok.ok).toBe(true);
    const res = container.lastOfType("exec_result");
    expect(res).toMatchObject({ ch: "exec", type: "exec_result", id: "x-1" });
    expect((res?.payload as { result: { stdout: string } }).result.stdout).toBe("file.txt\n");
  });

  it("an exec ERROR is relayed too (a failed tool call must not hang the agent's pending call)", () => {
    relay.prompt(sessionId, { sessionId: "acp-1", prompt: [] });
    container.push({ ch: "exec", type: "exec_run", id: "x-1", payload: { command: "nope" } });
    relay.answerExec(sessionId, "x-1", { error: "command not found" });
    expect((container.lastOfType("exec_result")?.payload as { error: string }).error).toBe("command not found");
  });

  it("a permission id from ANOTHER session cannot be answered through this one (cross-session reply)", async () => {
    // Two owners' containers are multiplexed through the same controller process. The pending-id
    // map is global, so without a session check a caller who learns (or guesses) an id could
    // answer someone ELSE'S permission prompt — approving a tool call on a stranger's agent.
    const other = await registry.mint("mallory");
    const otherContainer = fakeContainer();
    otherContainer.bind((raw) => relay.onContainerFrame(other.sessionId, raw));
    registry.attach(other.sessionId, other.token, otherContainer);

    relay.prompt(sessionId, { sessionId: "acp-1", prompt: [] });
    container.push({ ch: "acp", type: "permission_request", id: "perm-1", payload: { request: { sessionId: "acp-1", toolCallId: "tc", title: "x", options: [] } } });

    // alice's permission, answered while naming MALLORY's session — must be refused.
    const res = relay.answerPermission(other.sessionId, "perm-1", { optionId: "allow" });
    expect(res.ok).toBe(false);
    expect(otherContainer.sent.filter((f) => f.type === "ack")).toHaveLength(0);
    // And alice's container never received an ack it did not earn.
    expect(container.sent.filter((f) => f.type === "ack")).toHaveLength(0);
    // The real owner can still answer it.
    expect(relay.answerPermission(sessionId, "perm-1", { optionId: "allow" }).ok).toBe(true);
  });

  it("an EXEC id cannot be answered as a permission (or vice-versa) — kinds are not interchangeable", () => {
    relay.prompt(sessionId, { sessionId: "acp-1", prompt: [] });
    container.push({ ch: "exec", type: "exec_run", id: "x-1", payload: { command: "ls" } });
    // Answering an exec through the permission path would send an ACP `ack` where the container
    // expects an `exec_result` — a protocol desync that hangs the agent's pending tool call.
    expect(relay.answerPermission(sessionId, "x-1", { optionId: "allow" }).ok).toBe(false);
    expect(container.sent.filter((f) => f.type === "ack")).toHaveLength(0);
    expect(relay.answerExec(sessionId, "x-1", { result: {} }).ok).toBe(true);
  });

  it("a container disconnect ABANDONS pending permissions and execs (no leak across reconnects)", async () => {
    const stream = relay.prompt(sessionId, { sessionId: "acp-1", prompt: [] });
    container.push({ ch: "acp", type: "permission_request", id: "perm-1", payload: { request: { sessionId: "acp-1", toolCallId: "tc", title: "x", options: [] } } });
    container.push({ ch: "exec", type: "exec_run", id: "x-1", payload: { command: "ls" } });
    relay.onContainerGone(sessionId);
    await collect(stream);
    // Both are gone: answering either must fail rather than write into a dead socket, and a
    // reconnecting container must not inherit the previous connection's pending work.
    expect(relay.answerPermission(sessionId, "perm-1", { optionId: "allow" }).ok).toBe(false);
    expect(relay.answerExec(sessionId, "x-1", { result: {} }).ok).toBe(false);
  });
});
