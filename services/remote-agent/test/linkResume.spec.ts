// Tier 1: the container keeps its sessions across a brief drop.

import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";

import { runRemoteAgentClient, type RemoteAgentClient } from "../src/remoteAgentClient.js";
import { registerBackend, BACKENDS } from "../src/agentBackend.js";
import { Link, LINK_ID_PARAM, LINK_SEQ_PARAM } from "../src/link.js";
import type { WireFrame } from "../src/protocol.js";

/** Prompt makes one tunneled tool call, returning its stdout. */
function toolBackend(id: string) {
  const stats = { closes: 0 };
  registerBackend({
    id,
    needsClaudeAuth: false,
    async create(deps: { exec: { run(r: { command: string }): Promise<{ stdout: string }> } }) {
      return {
        async initialize() { return { protocolVersion: 1 }; },
        async newSession() { return { sessionId: "acp-1" }; },
        async prompt() {
          const r = await deps.exec.run({ command: "restart_sandbox" });
          return { stopReason: r.stdout };
        },
        async cancel() {},
        async killActiveTerminals() {},
        isAlive() { return true; },
        onSessionUpdate() { return () => {}; },
        onTerminalCreated() { return () => {}; },
        onPermissionRequest() {},
        async close() { stats.closes += 1; },
      } as never;
    },
  } as never);
  return stats;
}

/** A linked cloud end; `resume` decides each reconnect. */
function linkedCloud(resume: (attempt: number) => boolean) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const ready = new Promise<string>((resolve) =>
    wss.on("listening", () => resolve(`ws://127.0.0.1:${(wss.address() as { port: number }).port}`)),
  );
  let link: Link | undefined;
  let sock: ServerSocket | undefined;
  let attempts = 0;
  const onFrame = new Set<(f: WireFrame) => void>();
  const connections: Array<() => void> = [];
  wss.on("connection", (s: ServerSocket, req) => {
    const url = new URL(req.url ?? "/", "http://x");
    const id = url.searchParams.get(LINK_ID_PARAM)!;
    const seq = Number(url.searchParams.get(LINK_SEQ_PARAM));
    const resumed = !!link && link.id === id && link.canResume(seq) && resume(attempts++);
    if (!resumed) {
      link?.dispose();
      link = new Link(id);
    }
    sock = s;
    s.send(JSON.stringify({ type: "connected", payload: { owner: "alice", link: { resumed, seq: link.received } } }));
    link.attach((raw) => s.send(raw), resumed ? seq : 0);
    s.on("message", (raw) => {
      const f = JSON.parse(String(raw)) as WireFrame;
      if (!link!.receive(f) || !f.ch) return;
      for (const cb of [...onFrame]) cb(f);
    });
    s.on("close", () => link?.detach());
    connections.shift()?.();
  });
  const next = <T extends WireFrame>(match: (f: WireFrame) => boolean) =>
    new Promise<T>((resolve) => {
      const cb = (f: WireFrame) => {
        if (!match(f)) return;
        onFrame.delete(cb);
        resolve(f as T);
      };
      onFrame.add(cb);
    });
  return {
    ready,
    connected: () => new Promise<void>((r) => connections.push(r)),
    send: (f: WireFrame) => link!.send(f),
    next,
    call: async (type: string, id: string, payload: unknown) => {
      const acked = next((f) => f.type === "ack" && f.id === id);
      link!.send({ ch: "acp", type, id, payload });
      return acked;
    },
    drop: () => sock?.terminate(),
    close: () => new Promise<void>((r) => wss.close(() => r())),
  };
}

let client: RemoteAgentClient | undefined;
let stopCloud: (() => Promise<void>) | undefined;
afterEach(async () => {
  client?.stop();
  await stopCloud?.();
  delete BACKENDS["tool"];
});

async function startTurn(resume: (attempt: number) => boolean) {
  const stats = toolBackend("tool");
  const cloud = linkedCloud(resume);
  stopCloud = cloud.close;
  const first = cloud.connected();
  client = runRemoteAgentClient({ url: await cloud.ready, joinToken: "t", backend: "tool", log: () => {} });
  await first;
  await cloud.call("initialize", "i1", { params: {} });
  await cloud.call("new_session", "n1", { params: { cwd: "/w" } });
  const execRun = cloud.next((f) => f.type === "exec_run");
  const promptAck = cloud.call("prompt", "p1", { sessionId: "acp-1", prompt: [] });
  const run = await execRun;
  return { stats, cloud, run, promptAck };
}

describe("container link resume", () => {
  it("a drop mid tool call keeps the session and delivers the reply after resume", async () => {
    const { stats, cloud, run, promptAck } = await startTurn(() => true);
    const back = cloud.connected();
    cloud.drop();
    // The tool's reply is sent while the socket is down.
    cloud.send({ ch: "exec", type: "exec_result", id: run.id, payload: { result: { stdout: "resumed", exitCode: 0 } } });
    await back;
    const ack = await promptAck;
    expect(ack.payload).toEqual({ result: { stopReason: "resumed" } });
    expect(stats.closes).toBe(0);
  }, 10_000);

  it("a controller that cannot resume gets a fresh container: the old sessions are closed", async () => {
    const { stats, cloud } = await startTurn(() => false);
    const back = cloud.connected();
    cloud.drop();
    await back;
    const refused = await cloud.call("prompt", "p2", { sessionId: "acp-1", prompt: [] });
    expect((refused.payload as { error?: string }).error).toMatch(/unknown session/);
    expect(stats.closes).toBeGreaterThan(0);
  }, 10_000);
});
