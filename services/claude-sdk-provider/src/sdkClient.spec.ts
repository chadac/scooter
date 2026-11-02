/**
 * Tier 1: the SDK client against a fake query() (deps.queryImpl) that records the
 * options it was called with and streams canned messages. Every prompt must resume
 * the SDK's session so the conversation keeps its history.
 */

import { describe, it, expect } from "vitest";

import { createSdkAcpClient } from "./sdkClient.js";
import type { ExecBackend } from "./types.js";

// Minimal ExecBackend stub; the sandbox MCP server is not exercised by prompt() here.
const fakeExec: ExecBackend = {
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  createTerminal: async () => ({ id: "t", write: async () => {}, kill: async () => {}, output: async () => "" }),
} as unknown as ExecBackend;

/** A fake query() that records each call's options and yields one message with a session_id plus a result. */
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
  const usage = (input: number, cacheRead: number, cacheCreate: number) => ({
    input_tokens: input, output_tokens: 2_000, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate,
  });
  const assistant = (u: unknown, parent: string | null = null, model = "claude-x") =>
    ({ type: "assistant", session_id: "s1", parent_tool_use_id: parent, message: { model, content: [], usage: u } }) as never;
  const result = (modelUsage: Record<string, unknown>) =>
    ({ type: "result", subtype: "success", session_id: "s1", modelUsage }) as never;

  async function contextUsageOf(msgs: never[]) {
    const queryImpl = () => {
      async function* gen() { for (const m of msgs) yield m; }
      return Object.assign(gen(), { interrupt: async () => {} });
    };
    const client = await mkClient(queryImpl);
    const updates: Array<{ sessionUpdate: string; usedTokens?: number; contextWindow?: number }> = [];
    client.onSessionUpdate((_id, u) => updates.push(u as never));
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({ prompt: [{ type: "text", text: "hi" }] } as never);
    return updates.find((u) => u.sessionUpdate === "context_usage");
  }

  it("reports the last main-thread prompt's size, not the turn's summed usage", async () => {
    // Each round re-reads ~90k; summed, the turn exceeds the window.
    const rounds = Array.from({ length: 30 }, (_, i) => assistant(usage(500, 90_000 + i * 100, 1_000)));
    const cu = await contextUsageOf([
      ...rounds,
      result({ "claude-x": { inputTokens: 15_000, outputTokens: 60_000, cacheReadInputTokens: 2_743_500, cacheCreationInputTokens: 30_000, contextWindow: 1_000_000 } }),
    ]);
    expect(cu!.usedTokens).toBe(500 + 92_900 + 1_000);
    expect(cu!.contextWindow).toBe(1_000_000);
  });

  it("ignores subagent prompts and takes the main model's window", async () => {
    const cu = await contextUsageOf([
      assistant(usage(1_000, 50_000, 0)),
      assistant(usage(9_000, 150_000, 0), "toolu_1", "claude-small"),
      result({
        "claude-x": { contextWindow: 1_000_000 },
        "claude-small": { contextWindow: 200_000 },
      }),
    ]);
    expect(cu!.usedTokens).toBe(51_000);
    expect(cu!.contextWindow).toBe(1_000_000);
  });

  it("emits nothing when no assistant message carried usage", async () => {
    const cu = await contextUsageOf([
      { type: "assistant", session_id: "s1", parent_tool_use_id: null, message: { content: [] } } as never,
      result({ "claude-x": { inputTokens: 150_000, contextWindow: 200_000 } }),
    ]);
    expect(cu).toBeUndefined();
  });
});

describe("SDK client session resume", () => {
  it("first prompt has NO resume; the second RESUMES the captured session_id", async () => {
    const fq = fakeQuery();
    const client = await mkClient(fq.queryImpl);
    await client.newSession({ threadId: "c1" } as never);

    await client.prompt({ prompt: [{ type: "text", text: "hello" }] } as never);
    expect(fq.calls[0].options.resume).toBeUndefined();

    await client.prompt({ prompt: [{ type: "text", text: "again" }] } as never);
    expect(fq.calls[1].options.resume).toBe("sess-abc");
  });

  it("resumes even after a cancel (context survives interrupt)", async () => {
    // A query whose stream blocks mid-turn so cancel() has an in-flight query to interrupt.
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
    // The post-cancel turn still resumes the session.
    expect(calls[calls.length - 1].options.resume).toBe("sess-abc");
  });

  it("newSession clears the resume id (a new conversation starts fresh)", async () => {
    const fq = fakeQuery();
    const client = await mkClient(fq.queryImpl);
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({ prompt: [{ type: "text", text: "a" }] } as never); // captures sess-abc

    await client.newSession({ threadId: "c2" } as never);
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
    // The sandbox server stays and scooter-env is added as an HTTP server at the per-conversation endpoint.
    expect(mcp.sandbox).toBeDefined();
    expect(mcp["scooter-env"]).toEqual({ type: "http", url: "http://127.0.0.1:8080/mcp?conv=c1" });
    // Its tools are auto-allowed via the server prefix.
    expect(fq.calls[0].options.allowedTools as string[]).toContain("mcp__scooter-env");
  });

  it("omits scooter-env when no mcpEndpointUrl is given (sandbox tools only)", async () => {
    const fq = fakeQuery();
    const client = await mkClient(fq.queryImpl);
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({ prompt: [{ type: "text", text: "hi" }] } as never);

    const mcp = fq.calls[0].options.mcpServers as Record<string, unknown>;
    expect(mcp.sandbox).toBeDefined();
    expect(mcp["scooter-env"]).toBeUndefined();
    expect(fq.calls[0].options.allowedTools as string[]).not.toContain("mcp__scooter-env");
  });
});

describe("SDK client native subagents (the CLI's Task/Agent tools)", () => {
  /** Run one turn and return the options handed to query(). */
  const optionsOfOneTurn = async () => {
    const fq = fakeQuery();
    const client = await createSdkAcpClient({
      oauthToken: "t", model: "claude-x", exec: fakeExec, systemPrompt: "hi",
      mcpEndpointUrl: "http://127.0.0.1:8080/mcp?conv=c1",
      queryImpl: fq.queryImpl,
    });
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({ prompt: [{ type: "text", text: "fan out" }] } as never);
    return fq.calls[0].options;
  };

  it("THE BUG: hides Task AND Agent from the model, so subagents go through spawn_subagent and show in the UI @proves", async () => {
    // A native subagent runs inside the CLI and is never a conversation, so the UI cannot list it.
    const opts = await optionsOfOneTurn();
    expect(opts.disallowedTools as string[]).toEqual(expect.arrayContaining(["Task", "Agent"]));
  });

  it("the PreToolUse hook redirects an Agent call to spawn_subagent if one gets through", async () => {
    const opts = await optionsOfOneTurn();
    const hooks = opts.hooks as { PreToolUse: Array<{ hooks: Array<(i: unknown) => Promise<unknown>> }> };
    const hook = hooks.PreToolUse[0].hooks[0];
    for (const tool_name of ["Task", "Agent"]) {
      const out = (await hook({ tool_name })) as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      };
      expect(out.hookSpecificOutput?.permissionDecision, tool_name).toBe("deny");
      expect(out.hookSpecificOutput?.permissionDecisionReason, tool_name).toMatch(/spawn_subagent/);
    }
  });
});

describe("SDK client native WebSearch", () => {
  const optionsOfOneTurn = async (nativeWebSearch?: boolean) => {
    const fq = fakeQuery();
    const client = await createSdkAcpClient({
      oauthToken: "t", model: "claude-x", exec: fakeExec, systemPrompt: "hi",
      queryImpl: fq.queryImpl, nativeWebSearch,
    });
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({ prompt: [{ type: "text", text: "search" }] } as never);
    return fq.calls[0].options;
  };
  const decide = async (opts: Record<string, unknown>) => {
    const hooks = opts.hooks as { PreToolUse: Array<{ hooks: Array<(i: unknown) => Promise<unknown>> }> };
    return (await hooks.PreToolUse[0].hooks[0]({ tool_name: "WebSearch" })) as {
      continue?: boolean;
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
  };

  it("with nativeWebSearch, pre-approves WebSearch and the hook lets it run", async () => {
    const opts = await optionsOfOneTurn(true);
    expect(opts.allowedTools as string[]).toContain("WebSearch");
    const out = await decide(opts);
    expect(out.hookSpecificOutput?.permissionDecision).not.toBe("deny");
    expect(out.continue).toBe(true);
  });

  it("without it, WebSearch is redirected to a *_web_search tool", async () => {
    const opts = await optionsOfOneTurn();
    expect(opts.allowedTools as string[]).not.toContain("WebSearch");
    const out = await decide(opts);
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toMatch(/_web_search/);
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

// The SDK does not invoke canUseTool for allowedTools-covered tools, so the yield gate in prompt()'s stream loop keys on the tool call, whose message shapes here match a recorded real transcript (see sdkClient.replay.spec.ts).
describe("SDK client back-pressure (stream-loop interrupt at tool-call boundaries)", () => {
  // A fake query mirroring the real shapes: a tool_use call, then a user-message tool_result.
  function toolLoopQuery() {
    let interrupted = false;
    let reachedEnd = false;
    const queryImpl = () => {
      async function* gen() {
        yield { type: "assistant", session_id: "s1", message: { content: [] } } as never;
        // The tool call: a tool_use block in an assistant message.
        yield { type: "assistant", session_id: "s1", message: { content: [
          { type: "tool_use", id: "tc1", name: "mcp__scooter-env__check_subagent", input: { subagent_id: "x" } },
        ] } } as never;
        // The result: a tool_result in a user message.
        yield { type: "user", session_id: "s1", message: { content: [
          { type: "tool_result", tool_use_id: "tc1", content: "still running" },
        ] } } as never;
        // Reached only if the turn was not ended at the call.
        yield { type: "result", subtype: "success", session_id: "s1" } as never;
        reachedEnd = true;
      }
      return Object.assign(gen(), { interrupt: async () => { interrupted = true; } });
    };
    return { queryImpl, wasInterrupted: () => interrupted, endedEarly: () => !reachedEnd };
  }
  const mk = (shouldYield?: () => boolean, queryImpl?: any) =>
    createSdkAcpClient({ oauthToken: "t", model: "claude-x", exec: fakeExec, systemPrompt: "hi", queryImpl, shouldYield });

  it("ENDS the turn at a tool-call boundary when shouldYield() is true (the check_subagent-loop fix)", async () => {
    const tl = toolLoopQuery();
    const client = await mk(() => true, tl.queryImpl); // a priority item is waiting
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({ prompt: [{ type: "text", text: "poll" }] } as never);
    // Breaks from the stream without calling interrupt.
    expect(tl.wasInterrupted()).toBe(false);
    expect(tl.endedEarly()).toBe(true);
  });

  it("does NOT interrupt when shouldYield() is false (a normal tool loop runs to completion)", async () => {
    const tl = toolLoopQuery();
    const client = await mk(() => false, tl.queryImpl);
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({ prompt: [{ type: "text", text: "poll" }] } as never);
    expect(tl.wasInterrupted()).toBe(false);
    expect(tl.endedEarly()).toBe(false);
  });

  it("does NOT interrupt when no shouldYield is wired (default behavior unchanged)", async () => {
    const tl = toolLoopQuery();
    const client = await mk(undefined, tl.queryImpl);
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({ prompt: [{ type: "text", text: "poll" }] } as never);
    expect(tl.wasInterrupted()).toBe(false);
    expect(tl.endedEarly()).toBe(false);
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
    // The bridge keys pendingPermissions by req.toolCallId, so two concurrent requests sharing an id would collide.
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
    const { fq, seen } = await clientWithHandler();
    const canUseTool = fq.calls[0].options.canUseTool as (n: string, i: unknown) => Promise<unknown>;
    await Promise.all([
      canUseTool("mcp__scooter-env__check_background", { job_id: "a" }),
      canUseTool("mcp__scooter-env__check_background", { job_id: "b" }),
    ]);
    expect(seen).toHaveLength(2);
    expect(seen[0].toolCallId).not.toBe(seen[1].toolCallId);
  });

  it("THE REGRESSION: a REBUILT client does not re-mint the first one's ids", async () => {
    // dropCachedSession rebuilds the client mid-conversation, resetting any counter.
    const first = await clientWithHandler();
    const second = await clientWithHandler();
    for (const c of [first, second]) {
      const canUseTool = c.fq.calls[0].options.canUseTool as (n: string, i: unknown) => Promise<unknown>;
      await canUseTool("mcp__scooter-env__check_background", { job_id: "a" });
    }
    expect(first.seen).toHaveLength(1);
    expect(second.seen).toHaveLength(1);
    expect(first.seen[0].toolCallId).not.toBe(second.seen[0].toolCallId);
  });

  it("the TITLE still names the tool, so the prompt stays readable", async () => {
    const { fq, seen } = await clientWithHandler();
    const canUseTool = fq.calls[0].options.canUseTool as (n: string, i: unknown) => Promise<unknown>;
    await canUseTool("mcp__scooter-env__check_background", { job_id: "a" });
    expect(seen[0].title).toBe("mcp__scooter-env__check_background");
  });
});

describe("multimodal prompt (attached images reach the model)", () => {
  // A fake query() that records the raw prompt arg, string or AsyncIterable.
  function recordingQuery() {
    const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
    const queryImpl = (params: { prompt: unknown; options: Record<string, unknown> }) => {
      calls.push({ prompt: params.prompt, options: params.options });
      async function* gen() {
        yield { type: "assistant", session_id: "s", message: { content: [] } } as never;
        yield { type: "result", subtype: "success", session_id: "s" } as never;
      }
      return Object.assign(gen(), { interrupt: async () => {} });
    };
    return { queryImpl, calls };
  }

  // Drain the streaming-input generator into the single user message it yields.
  async function firstUserMessage(prompt: unknown) {
    const msgs: Array<{ message: { content: unknown[] } }> = [];
    for await (const m of prompt as AsyncIterable<{ message: { content: unknown[] } }>) msgs.push(m);
    return msgs[0];
  }

  it("THE REGRESSION: an image block is sent as a base64 image, NOT the literal text \"[image]\"", async () => {
    const rq = recordingQuery();
    const client = await createSdkAcpClient({
      oauthToken: "t", model: "claude-x", exec: fakeExec, systemPrompt: "hi", queryImpl: rq.queryImpl as never,
    });
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({
      prompt: [
        { type: "text", text: "what is this?" },
        { type: "image", data: "QUJD", mimeType: "image/png" },
      ],
    } as never);

    // An image prompt takes the streaming-input form, never a string.
    expect(typeof rq.calls[0].prompt).not.toBe("string");
    const um = await firstUserMessage(rq.calls[0].prompt);
    const content = um.message.content as Array<Record<string, unknown>>;
    expect(content).toContainEqual({ type: "text", text: "what is this?" });
    expect(content).toContainEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } });
    expect(JSON.stringify(content)).not.toContain("[image]");
  });

  it("a text-only prompt still uses the plain-string form (unchanged common path)", async () => {
    const rq = recordingQuery();
    const client = await createSdkAcpClient({
      oauthToken: "t", model: "claude-x", exec: fakeExec, systemPrompt: "hi", queryImpl: rq.queryImpl as never,
    });
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({ prompt: [{ type: "text", text: "just text" }] } as never);
    expect(rq.calls[0].prompt).toBe("just text");
  });
});
describe("named MCP servers reach the SDK — the contrib provider tools", () => {
  it("THE BUG: scooter-broker is passed to the SDK, with its headers", async () => {
    // The SDK agent's github skill tells it to call agent-broker, so scooter-broker must be offered on this path too.
    const fq = fakeQuery();
    const client = await createSdkAcpClient({
      oauthToken: "t", model: "claude-x", exec: fakeExec, systemPrompt: "hi",
      queryImpl: fq.queryImpl,
      mcpServers: [
        { name: "scooter-broker", url: "http://127.0.0.1:8080/broker-mcp", headers: { "x-conv": "tok" } },
      ],
    });
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({ prompt: [{ type: "text", text: "hi" }] } as never);

    const servers = fq.calls[0].options.mcpServers as Record<string, { type: string; url: string; headers?: Record<string, string> }>;
    expect(Object.keys(servers)).toContain("scooter-broker");
    expect(servers["scooter-broker"].url).toBe("http://127.0.0.1:8080/broker-mcp");
    // Without the header the proxy rejects the call, so the tool exists and fails.
    expect(servers["scooter-broker"].headers).toEqual({ "x-conv": "tok" });
  });

  it("its tools are pre-approved, or permissionMode dontAsk denies them", async () => {
    const fq = fakeQuery();
    const client = await createSdkAcpClient({
      oauthToken: "t", model: "claude-x", exec: fakeExec, systemPrompt: "hi",
      queryImpl: fq.queryImpl,
      mcpServers: [{ name: "scooter-broker", url: "http://x/mcp" }],
    });
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({ prompt: [{ type: "text", text: "hi" }] } as never);
    expect(fq.calls[0].options.allowedTools as string[]).toContain("mcp__scooter-broker");
  });

  it("no named servers -> the option is absent, not an empty map", async () => {
    const fq = fakeQuery();
    const client = await mkClient(fq.queryImpl);
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({ prompt: [{ type: "text", text: "hi" }] } as never);
    const servers = fq.calls[0].options.mcpServers as Record<string, unknown>;
    expect(Object.keys(servers)).not.toContain("scooter-broker");
  });
});


describe("new_session MCP servers reach the SDK — the sandbox's declared servers", () => {
  const sandboxServer = {
    type: "http",
    name: "sandbox-time",
    url: "http://127.0.0.1:8080/sandbox-mcp/time",
    headers: [{ name: "Authorization", value: "Bearer tok" }],
  };

  it("adds each server and pre-approves its tools", async () => {
    // Only new_session knows the sandbox's set.
    const fq = fakeQuery();
    const client = await mkClient(fq.queryImpl);
    await client.newSession({ cwd: "/w", mcpServers: [sandboxServer] } as never);
    await client.prompt({ prompt: [{ type: "text", text: "hi" }] } as never);

    const servers = fq.calls[0].options.mcpServers as Record<string, { type: string; url: string; headers?: Record<string, string> }>;
    expect(servers["sandbox-time"]).toEqual({
      type: "http",
      url: "http://127.0.0.1:8080/sandbox-mcp/time",
      headers: { Authorization: "Bearer tok" },
    });
    expect(servers.sandbox, "the in-process sandbox tools stay").toBeDefined();
    expect(fq.calls[0].options.allowedTools as string[]).toContain("mcp__sandbox-time");
  });

  it("keeps the constructor's entry when new_session repeats a name", async () => {
    // The constructor's scooter-broker carries the real headers.
    const fq = fakeQuery();
    const client = await createSdkAcpClient({
      oauthToken: "t", model: "claude-x", exec: fakeExec, systemPrompt: "hi",
      queryImpl: fq.queryImpl,
      mcpServers: [{ name: "scooter-broker", url: "http://x/broker-mcp", headers: { "x-conv": "ctor" } }],
    });
    await client.newSession({
      cwd: "/w",
      mcpServers: [{ type: "http", name: "scooter-broker", url: "http://y", headers: [] }],
    } as never);
    await client.prompt({ prompt: [{ type: "text", text: "hi" }] } as never);
    const servers = fq.calls[0].options.mcpServers as Record<string, { url: string }>;
    expect(servers["scooter-broker"].url).toBe("http://x/broker-mcp");
    const allowed = fq.calls[0].options.allowedTools as string[];
    expect(allowed.filter((t) => t === "mcp__scooter-broker").length).toBeGreaterThan(0);
  });

  it("drops a server the next new_session no longer offers", async () => {
    const fq = fakeQuery();
    const client = await mkClient(fq.queryImpl);
    await client.newSession({ cwd: "/w", mcpServers: [sandboxServer] } as never);
    await client.newSession({ cwd: "/w", mcpServers: [] } as never);
    await client.prompt({ prompt: [{ type: "text", text: "hi" }] } as never);
    expect(Object.keys(fq.calls[0].options.mcpServers as object)).not.toContain("sandbox-time");
  });
});
