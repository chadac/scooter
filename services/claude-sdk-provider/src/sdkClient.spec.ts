/**
 * Tier 1 — SDK client SESSION RESUME. Every prompt must resume the SDK's session so
 * the conversation keeps its history; without it the agent "loses total context"
 * (most visibly after a cancel). We inject a fake query() (deps.queryImpl) that
 * records the options it was called with and streams a message carrying a session_id.
 */

import { describe, it, expect } from "vitest";

import { createSdkAcpClient } from "./sdkClient.js";
import type { ExecBackend } from "./types.js";

// Minimal ExecBackend stub — the client only wires it into the sandbox MCP server,
// which isn't exercised by prompt() here.
const fakeExec: ExecBackend = {
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  createTerminal: async () => ({ id: "t", write: async () => {}, kill: async () => {}, output: async () => "" }),
} as unknown as ExecBackend;

/** A fake query() that records each call's options and yields one message with a
 *  session_id + a result, then ends. `interrupt` flips a flag. */
function fakeQuery() {
  const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  let interrupted = false;
  const queryImpl = (params: { prompt: string; options: Record<string, unknown> }) => {
    calls.push({ prompt: params.prompt, options: params.options });
    async function* gen() {
      yield { type: "assistant", session_id: "sess-abc", message: { content: [] } } as never;
      yield { type: "result", subtype: "success", session_id: "sess-abc" } as never;
    }
    const it = gen();
    return Object.assign(it, { interrupt: async () => { interrupted = true; } });
  };
  return { queryImpl, calls, wasInterrupted: () => interrupted };
}

const mkClient = (queryImpl: ReturnType<typeof fakeQuery>["queryImpl"]) =>
  createSdkAcpClient({
    oauthToken: "t", model: "claude-x", exec: fakeExec, systemPrompt: "hi", queryImpl,
  });

describe("SDK client context usage", () => {
  it("emits a context_usage update from the result's modelUsage", async () => {
    const queryImpl = () => {
      async function* gen() {
        yield { type: "assistant", session_id: "s1", message: { content: [] } } as never;
        yield {
          type: "result", subtype: "success", session_id: "s1",
          modelUsage: {
            "claude-x": { inputTokens: 150_000, outputTokens: 5_000, cacheReadInputTokens: 4_000, cacheCreationInputTokens: 1_000, contextWindow: 200_000 },
          },
        } as never;
      }
      return Object.assign(gen(), { interrupt: async () => {} });
    };
    const client = await mkClient(queryImpl);
    const updates: Array<{ sessionUpdate: string; usedTokens?: number; contextWindow?: number }> = [];
    client.onSessionUpdate((_id, u) => updates.push(u as never));
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({ prompt: [{ type: "text", text: "hi" }] } as never);

    const cu = updates.find((u) => u.sessionUpdate === "context_usage");
    expect(cu).toBeTruthy();
    expect(cu!.usedTokens).toBe(160_000); // 150k input + 4k cacheRead + 1k cacheCreate + 5k output
    expect(cu!.contextWindow).toBe(200_000);
  });
});

describe("SDK client session resume", () => {
  it("first prompt has NO resume; the second RESUMES the captured session_id", async () => {
    const fq = fakeQuery();
    const client = await mkClient(fq.queryImpl);
    await client.newSession({ threadId: "c1" } as never);

    await client.prompt({ prompt: [{ type: "text", text: "hello" }] } as never);
    expect(fq.calls[0].options.resume).toBeUndefined(); // new session

    await client.prompt({ prompt: [{ type: "text", text: "again" }] } as never);
    expect(fq.calls[1].options.resume).toBe("sess-abc"); // resumed the same session
  });

  it("resumes even after a cancel (context survives interrupt)", async () => {
    // A query whose stream BLOCKS mid-turn so cancel() has an in-flight query to
    // interrupt (the realistic case: the user cancels while the agent is working).
    const calls: Array<{ options: Record<string, unknown> }> = [];
    let interrupted = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const queryImpl = (params: { prompt: string; options: Record<string, unknown> }) => {
      calls.push({ options: params.options });
      async function* gen() {
        yield { type: "assistant", session_id: "sess-abc", message: { content: [] } } as never;
        await gate; // block until interrupted/released
        yield { type: "result", subtype: "success", session_id: "sess-abc" } as never;
      }
      return Object.assign(gen(), { interrupt: async () => { interrupted = true; release(); } });
    };
    const client = await mkClient(queryImpl);
    await client.newSession({ threadId: "c1" } as never);

    const p = client.prompt({ prompt: [{ type: "text", text: "start" }] } as never);
    await new Promise((r) => setTimeout(r, 5)); // let the stream reach the gate
    await client.cancel("c1");
    await p;
    expect(interrupted).toBe(true);

    await client.prompt({ prompt: [{ type: "text", text: "continue" }] } as never);
    // The post-cancel turn still RESUMES the session — it does NOT dead-start fresh
    // (the bug: a cancelled turn lost the session, so the next turn had no context).
    expect(calls[calls.length - 1].options.resume).toBe("sess-abc");
  });

  it("newSession clears the resume id (a new conversation starts fresh)", async () => {
    const fq = fakeQuery();
    const client = await mkClient(fq.queryImpl);
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({ prompt: [{ type: "text", text: "a" }] } as never); // captures sess-abc

    await client.newSession({ threadId: "c2" } as never); // NEW conversation
    await client.prompt({ prompt: [{ type: "text", text: "b" }] } as never);
    expect(fq.calls[fq.calls.length - 1].options.resume).toBeUndefined();
  });
});

describe("SDK client platform MCP tools (scooter-env)", () => {
  it("wires the scooter-env HTTP MCP server + allows its tools when mcpEndpointUrl is given", async () => {
    const fq = fakeQuery();
    const client = await createSdkAcpClient({
      oauthToken: "t", model: "claude-x", exec: fakeExec, systemPrompt: "hi",
      mcpEndpointUrl: "http://127.0.0.1:8080/mcp?conv=c1",
      queryImpl: fq.queryImpl,
    });
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({ prompt: [{ type: "text", text: "schedule something" }] } as never);

    const mcp = fq.calls[0].options.mcpServers as Record<string, { type?: string; url?: string }>;
    // The sandbox server stays; scooter-env is added as an HTTP server pointed at the
    // per-conversation MCP endpoint (this is what carries the scheduler/slack/github tools).
    expect(mcp.sandbox).toBeDefined();
    expect(mcp["scooter-env"]).toEqual({ type: "http", url: "http://127.0.0.1:8080/mcp?conv=c1" });
    // Its tools are auto-allowed (no permission prompt) via the server prefix.
    expect(fq.calls[0].options.allowedTools as string[]).toContain("mcp__scooter-env");
  });

  it("omits scooter-env when no mcpEndpointUrl is given (sandbox tools only)", async () => {
    const fq = fakeQuery();
    const client = await mkClient(fq.queryImpl); // no mcpEndpointUrl
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({ prompt: [{ type: "text", text: "hi" }] } as never);

    const mcp = fq.calls[0].options.mcpServers as Record<string, unknown>;
    expect(mcp.sandbox).toBeDefined();
    expect(mcp["scooter-env"]).toBeUndefined();
    expect(fq.calls[0].options.allowedTools as string[]).not.toContain("mcp__scooter-env");
  });
});

describe("SDK client back-pressure (canUseTool yields to a queued priority item)", () => {
  const clientWith = (shouldYield?: () => boolean) => {
    const fq = fakeQuery();
    return { fq, make: () => createSdkAcpClient({ oauthToken: "t", model: "claude-x", exec: fakeExec, systemPrompt: "hi", queryImpl: fq.queryImpl, shouldYield }) };
  };
  const runOnce = async (make: () => Promise<any>) => {
    const client = await make();
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({ prompt: [{ type: "text", text: "hi" }] } as never);
  };

  it("DENYS the next tool with an explanation + interrupt:true when shouldYield() is true", async () => {
    const { fq, make } = clientWith(() => true);
    await runOnce(make);
    const canUseTool = fq.calls[0].options.canUseTool as (n: string, i: unknown) => Promise<any>;
    const res = await canUseTool("mcp__scooter-env__check_subagent", { subagent_id: "x" });
    expect(res.behavior).toBe("deny");
    expect(res.interrupt).toBe(true);
    expect(res.message).toMatch(/higher.priority|finish your turn|waiting/i);
  });

  it("ALLOWS the tool when shouldYield() is false", async () => {
    const { fq, make } = clientWith(() => false);
    await runOnce(make);
    const canUseTool = fq.calls[0].options.canUseTool as (n: string, i: unknown) => Promise<any>;
    const res = await canUseTool("mcp__scooter-env__check_subagent", { a: 1 });
    expect(res.behavior).toBe("allow");
  });

  it("ALLOWS the tool when no shouldYield is wired (default behavior unchanged)", async () => {
    const { fq, make } = clientWith(undefined);
    await runOnce(make);
    const canUseTool = fq.calls[0].options.canUseTool as (n: string, i: unknown) => Promise<any>;
    const res = await canUseTool("bash", { command: "ls" });
    expect(res.behavior).toBe("allow");
  });

});

// The deployed bug: an agent stuck polling `check_subagent` never yielded to a
// queued priority item (18 calls, no deny, no "Pausing" log). Verified in prod that
// the SDK does NOT invoke canUseTool for allowedTools-covered tools (our sandbox
// aliases + the mcp__scooter-env prefix), so the canUseTool deny is dead. The REAL
// gate is in prompt()'s stream loop: when the agent ISSUES a tool call (a `tool_use`
// block), if shouldYield() is true, interrupt the query so the turn ends.
//
// NOTE the message SHAPES here match a RECORDED real transcript (see
// sdkClient.replay.spec.ts): the tool CALL is a `tool_use` block in an `assistant`
// message; the RESULT is a `tool_result` block in a `user` message — which the
// adapter DROPS, so the hook must key on the CALL, not the result. An earlier fake
// put the result in an `assistant` message and the hook keyed on it — green on a
// fiction, broken in prod. Don't regress to that.
describe("SDK client back-pressure (stream-loop interrupt at tool-call boundaries)", () => {
  // A fake query mirroring the REAL shapes: a tool_use (the call) then a user-type
  // tool_result (the completion, which the adapter ignores). Records interrupt().
  function toolLoopQuery() {
    let interrupted = false;
    const queryImpl = () => {
      async function* gen() {
        yield { type: "assistant", session_id: "s1", message: { content: [] } } as never;
        // The tool CALL — a tool_use block in an ASSISTANT message (real shape).
        yield { type: "assistant", session_id: "s1", message: { content: [
          { type: "tool_use", id: "tc1", name: "mcp__scooter-env__check_subagent", input: { subagent_id: "x" } },
        ] } } as never;
        // The RESULT — a tool_result in a USER message (real shape; adapter drops it).
        yield { type: "user", session_id: "s1", message: { content: [
          { type: "tool_result", tool_use_id: "tc1", content: "still running" },
        ] } } as never;
        // If the turn ISN'T interrupted at the CALL, it would keep looping.
        yield { type: "result", subtype: "success", session_id: "s1" } as never;
      }
      return Object.assign(gen(), { interrupt: async () => { interrupted = true; } });
    };
    return { queryImpl, wasInterrupted: () => interrupted };
  }
  const mk = (shouldYield?: () => boolean, queryImpl?: any) =>
    createSdkAcpClient({ oauthToken: "t", model: "claude-x", exec: fakeExec, systemPrompt: "hi", queryImpl, shouldYield });

  it("INTERRUPTS the turn at a tool-call boundary when shouldYield() is true (the check_subagent-loop fix)", async () => {
    const tl = toolLoopQuery();
    const client = await mk(() => true, tl.queryImpl); // a priority item IS waiting
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({ prompt: [{ type: "text", text: "poll" }] } as never);
    // After the tool_result flowed and shouldYield() was true, the turn interrupted
    // instead of continuing the loop — so the queued priority item can now inject.
    expect(tl.wasInterrupted()).toBe(true);
  });

  it("does NOT interrupt when shouldYield() is false (a normal tool loop runs to completion)", async () => {
    const tl = toolLoopQuery();
    const client = await mk(() => false, tl.queryImpl);
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({ prompt: [{ type: "text", text: "poll" }] } as never);
    expect(tl.wasInterrupted()).toBe(false);
  });

  it("does NOT interrupt when no shouldYield is wired (default behavior unchanged)", async () => {
    const tl = toolLoopQuery();
    const client = await mk(undefined, tl.queryImpl);
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({ prompt: [{ type: "text", text: "poll" }] } as never);
    expect(tl.wasInterrupted()).toBe(false);
  });
});

describe("SDK client permission requests carry a UNIQUE id per call", () => {
  /** Capture what the bridge's permission handler is asked to approve. */
  const clientWithHandler = async () => {
    const fq = fakeQuery();
    const seen: Array<{ toolCallId: string; title: string }> = [];
    const client = await createSdkAcpClient({
      oauthToken: "t",
      model: "claude-x",
      exec: fakeExec,
      systemPrompt: "hi",
      queryImpl: fq.queryImpl,
    } as never);
    // The bridge registers this; it keys pendingPermissions by req.toolCallId, so two
    // concurrent requests sharing an id make the second OVERWRITE the first — and the
    // first's promise then never resolves (the tool call hangs with no TOOL_CALL_RESULT).
    (client as never as { onPermissionRequest: (h: (r: never) => Promise<never>) => void })
      .onPermissionRequest(async (req: never) => {
        const r = req as unknown as { toolCallId: string; title: string };
        seen.push({ toolCallId: r.toolCallId, title: r.title });
        return { optionId: "allow" } as never;
      });
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({ prompt: [{ type: "text", text: "hi" }] } as never);
    return { fq, seen };
  };

  it("THE REGRESSION: two calls to the SAME tool get DISTINCT permission ids", async () => {
    // Live on conv-1ribob: check_background / run_background are called repeatedly, so
    // keying the pending permission by TOOL NAME collided — the second request evicted
    // the first from pendingPermissions and its tool call never returned. 8 orphaned
    // tool calls, 0 PERMISSION_RESOLVED across 629 calls.
    const { fq, seen } = await clientWithHandler();
    const canUseTool = fq.calls[0].options.canUseTool as (n: string, i: unknown) => Promise<unknown>;
    await Promise.all([
      canUseTool("mcp__scooter-env__check_background", { job_id: "a" }),
      canUseTool("mcp__scooter-env__check_background", { job_id: "b" }),
    ]);
    expect(seen).toHaveLength(2);
    expect(seen[0].toolCallId).not.toBe(seen[1].toolCallId);
  });

  it("the TITLE still names the tool, so the prompt stays readable", async () => {
    const { fq, seen } = await clientWithHandler();
    const canUseTool = fq.calls[0].options.canUseTool as (n: string, i: unknown) => Promise<unknown>;
    await canUseTool("mcp__scooter-env__check_background", { job_id: "a" });
    expect(seen[0].title).toBe("mcp__scooter-env__check_background");
  });
});
