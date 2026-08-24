/**
 * Tier 1 contract — RemoteAcpClient (the cloud side of bring-your-own-Claude) over a fake WS.
 *
 * Proves the ACP-over-WS split: ACP requests go DOWN + await their ack; the agent's notifications
 * come UP to the bridge callbacks; the agent's TOOL calls (Channel B) run on the CLOUD ExecBackend;
 * a dropped connection rejects in-flight requests (offline → RUN_ERROR, not a silent hang). See
 * remoteProtocol.ts + todo/done/BYO_CLAUDE_REMOTE_AGENT.md.
 */

import { describe, it, expect, vi } from "vitest";

import { createRemoteAcpClient } from "../../src/acp/remoteAcpClient.js";
import type { RemoteTransport, WireFrame } from "../../src/acp/remoteProtocol.js";
import type { ExecBackend } from "../../src/types.js";

/** An in-memory transport pair: whatever `a` sends, `b` receives, and vice-versa. Models the WS. */
function transportPair(): { a: RemoteTransport; b: RemoteTransport; closeBoth: () => void } {
  const make = () => {
    const frameCbs = new Set<(f: WireFrame) => void>();
    const closeCbs = new Set<() => void>();
    let open = true;
    return {
      frameCbs,
      closeCbs,
      isOpenRef: () => open,
      setClosed: () => {
        open = false;
      },
      transport: {
        send: (_f: WireFrame) => {},
        onFrame: (cb: (f: WireFrame) => void) => {
          frameCbs.add(cb);
          return () => frameCbs.delete(cb);
        },
        isOpen: () => open,
        onClose: (cb: () => void) => {
          closeCbs.add(cb);
          return () => closeCbs.delete(cb);
        },
        close: () => {
          open = false;
          for (const cb of closeCbs) cb();
        },
      } as RemoteTransport,
    };
  };
  const A = make();
  const B = make();
  // Wire the duplex: A.send → B's frame listeners; B.send → A's.
  A.transport.send = (f: WireFrame) => queueMicrotask(() => B.frameCbs.forEach((cb) => cb(f)));
  B.transport.send = (f: WireFrame) => queueMicrotask(() => A.frameCbs.forEach((cb) => cb(f)));
  return {
    a: A.transport,
    b: B.transport,
    closeBoth: () => {
      A.transport.close();
      B.transport.close();
    },
  };
}

/** A fake ExecBackend for the cloud side — records runs, returns a canned result. */
function fakeExec(): ExecBackend & { runs: Array<{ command: string; args: string[] }> } {
  const runs: Array<{ command: string; args: string[] }> = [];
  return {
    runs,
    run: async (req) => {
      runs.push({ command: req.command, args: req.args });
      return { stdout: `ran:${req.command} ${req.args.join(" ")}`, stderr: "", exitCode: 0 };
    },
    spawn: () => {
      throw new Error("spawn not used in this test");
    },
    readTextFile: async (p) => `contents-of:${p}`,
    writeTextFile: async () => {},
  } as ExecBackend & { runs: Array<{ command: string; args: string[] }> };
}

/** A minimal fake "container agent" bound to transport end `b`: answers ACP requests with acks and
 *  can push notifications / exec requests to the cloud. */
function fakeContainerAgent(b: RemoteTransport) {
  const acked: WireFrame[] = [];
  b.onFrame((f) => {
    if (f.ch === "acp" && f.id && f.type !== "ack") {
      acked.push(f);
      // Reply with a canned ack per request type.
      const result =
        f.type === "initialize" ? { protocolVersion: 1 }
        : f.type === "new_session" ? { sessionId: "sess-remote-1" }
        : f.type === "prompt" ? { stopReason: "end_turn" }
        : {};
      b.send({ ch: "acp", type: "ack", id: f.id, payload: { result } });
    }
  });
  return {
    acked,
    pushUpdate: (sessionId: string, update: unknown) =>
      b.send({ ch: "acp", type: "session_update", payload: { sessionId, update } }),
    runToolInCloud: (id: string, command: string, args: string[]) =>
      b.send({ ch: "exec", type: "exec_run", id, payload: { command, args } }),
    onExecResult: (cb: (f: WireFrame) => void) => b.onFrame((f) => f.ch === "exec" && cb(f)),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("RemoteAcpClient over a fake WS", () => {
  it("sends ACP requests down + resolves on the ack (initialize/newSession/prompt)", async () => {
    const { a, b } = transportPair();
    const agent = fakeContainerAgent(b);
    const client = createRemoteAcpClient({ transport: a, exec: fakeExec() });

    expect((await client.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } })).protocolVersion).toBe(1);
    expect((await client.newSession({ cwd: "/workspace" })).sessionId).toBe("sess-remote-1");
    expect((await client.prompt({ sessionId: "sess-remote-1", prompt: [{ type: "text", text: "hi" }] })).stopReason).toBe("end_turn");

    // The agent saw exactly those three ACP requests, in order.
    expect(agent.acked.map((f) => f.type)).toEqual(["initialize", "new_session", "prompt"]);
  });

  it("dispatches the agent's session_update notifications to onSessionUpdate", async () => {
    const { a, b } = transportPair();
    fakeContainerAgent(b);
    const client = createRemoteAcpClient({ transport: a, exec: fakeExec() });
    const seen = vi.fn();
    client.onSessionUpdate(seen);

    agent_pushChunk(b, "sess-1", "hello from the laptop");
    await tick();

    expect(seen).toHaveBeenCalledWith("sess-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello from the laptop" } });
  });

  it("runs the agent's tool calls on the CLOUD ExecBackend and returns the result", async () => {
    const { a, b } = transportPair();
    const agent = fakeContainerAgent(b);
    const exec = fakeExec();
    createRemoteAcpClient({ transport: a, exec });

    let result: unknown;
    agent.onExecResult((f) => {
      if (f.type === "exec_result") result = (f.payload as { result?: unknown }).result;
    });
    agent.runToolInCloud("x1", "echo", ["SENTINEL"]);
    await tick();

    // The tool ran on the CLOUD exec backend (not the laptop) + the result tunneled back.
    expect(exec.runs).toEqual([{ command: "echo", args: ["SENTINEL"] }]);
    expect(result).toEqual({ stdout: "ran:echo SENTINEL", stderr: "", exitCode: 0 });
  });

  it("rejects an in-flight prompt when the connection drops (offline → RUN_ERROR, not a hang)", async () => {
    const { a, b } = transportPair();
    // A container that NEVER acks — so prompt() stays pending until we drop the connection.
    b.onFrame(() => {});
    const client = createRemoteAcpClient({ transport: a, exec: fakeExec() });

    const p = client.prompt({ sessionId: "s", prompt: [{ type: "text", text: "hi" }] });
    a.close(); // the WS drops
    await expect(p).rejects.toThrow(/disconnected|not connected/i);
    expect(client.isAlive()).toBe(false);
  });
});

/** Helper: push an agent_message_chunk update from container end `b`. */
function agent_pushChunk(b: RemoteTransport, sessionId: string, text: string) {
  b.send({ ch: "acp", type: "session_update", payload: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
}
