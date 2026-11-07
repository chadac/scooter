/** The bridge's conversation hooks around a scripted agent. */

import { describe, it, expect } from "vitest";

import { createSessionBridge, type AguiEvent } from "../../src/bridge.js";
import type { AcpClient, PromptParams, SessionUpdate } from "../../src/acp/client.js";
import { createFakeSandboxApi } from "../fakes/fakeSandboxApi.js";
import { createSandboxExecBackend } from "../../src/exec/sandboxExec.js";
import type { HookEvent, HookFolder, HookOutcome, HookRunner } from "../../src/hooks/types.js";

type Turn = { text?: string; updates?: SessionUpdate[] };

/** Answers each prompt with the next scripted turn. */
function scriptedAgent(turns: Turn[]) {
  const prompts: string[] = [];
  let cb: ((sid: string, u: SessionUpdate) => void) | undefined;
  const client: AcpClient = {
    initialize: async () => ({ protocolVersion: 1 }),
    newSession: async () => ({ sessionId: "acp-1" }),
    prompt: async (p: PromptParams) => {
      prompts.push(p.prompt.map((b) => (b.type === "text" ? b.text : "")).join("\n"));
      const turn = turns.shift() ?? { text: "ok" };
      for (const u of turn.updates ?? []) cb?.("acp-1", u);
      if (turn.text) cb?.("acp-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: turn.text } });
      return { stopReason: "end_turn" };
    },
    cancel: async () => {},
    killActiveTerminals: async () => {},
    isAlive: () => true,
    onSessionUpdate: (f) => {
      cb = f;
      return () => {};
    },
    onTerminalCreated: () => () => {},
    onPermissionRequest: () => {},
    close: async () => {},
  };
  return { client, prompts };
}

/** A HookRunner answering from `answer`, recording each call. */
function scriptedHooks(answer: (event: HookEvent, input: Record<string, unknown>) => Partial<HookOutcome> | undefined) {
  const calls: Array<{ event: HookEvent; input: Record<string, unknown> }> = [];
  const events = new Set<HookEvent>(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]);
  const runner: HookRunner = {
    has: async (e) => events.has(e),
    run: async (event, input) => {
      calls.push({ event, input });
      const a = answer(event, input) ?? {};
      return {
        context: [],
        systemMessages: [],
        runs: [{ id: "test-hook", event, decision: a.block ? "block" : "allow", ms: 0 }],
        ...a,
      };
    },
  };
  return { runner, calls };
}

function makeBridge(
  agent: AcpClient,
  hooks: HookRunner,
  extra: { maxStopBlocks?: number; parentId?: () => string | undefined; untitled?: () => boolean; folder?: () => Promise<HookFolder | null> } = {},
) {
  const exec = createSandboxExecBackend(createFakeSandboxApi());
  const bridge = createSessionBridge({
    config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
    exec,
    acpClient: agent,
    hooks,
    firstActivityTimeoutMs: 0,
    livenessProbeMs: 0,
    ...extra,
  });
  const events: AguiEvent[] = [];
  bridge.onEvent((e) => events.push(e));
  return { bridge, events };
}

const hookNotes = (events: AguiEvent[]) =>
  events.filter((e): e is Extract<AguiEvent, { type: "SYSTEM_MESSAGE" }> => e.type === "SYSTEM_MESSAGE" && e.source === "hook").map((e) => e.text);
const finishes = (events: AguiEvent[]) => events.filter((e) => e.type === "RUN_FINISHED" || e.type === "RUN_ERROR");

describe("bridge conversation hooks", () => {
  it("sends the agent back in the SAME run when a Stop hook blocks, then lets it stop", async () => {
    const agent = scriptedAgent([{ text: "Want me to open the PR?" }, { text: "Opened it." }]);
    const hooks = scriptedHooks((event, input) =>
      event === "Stop" && input.stop_hook_active === false ? { block: "Open the PR, you're pre-authorized." } : undefined,
    );
    const { bridge, events } = makeBridge(agent.client, hooks.runner);
    await bridge.prompt({ threadId: "t", text: "fix it" });

    expect(agent.prompts).toHaveLength(2);
    expect(agent.prompts[1]).toContain("Open the PR, you're pre-authorized.");
    expect(agent.prompts[1]).toContain("System message from hook");
    const stops = hooks.calls.filter((c) => c.event === "Stop").map((c) => c.input);
    expect(stops).toEqual([
      expect.objectContaining({ stop_hook_active: false, last_assistant_message: "Want me to open the PR?" }),
      expect.objectContaining({ stop_hook_active: true, last_assistant_message: "Opened it." }),
    ]);
    expect((stops[1].scooter as { stop_blocks: number }).stop_blocks).toBe(1);
    // One run, one terminal event, and the reason shown.
    expect(finishes(events)).toHaveLength(1);
    expect(new Set(events.filter((e) => e.type === "RUN_STARTED").map((e) => (e as { runId: string }).runId)).size).toBe(1);
    expect(hookNotes(events)).toEqual(["Stop hook test-hook: Open the PR, you're pre-authorized."]);
  });

  it("stops looping after maxStopBlocks and says so", async () => {
    const agent = scriptedAgent([]);
    const hooks = scriptedHooks((event) => (event === "Stop" ? { block: "keep going" } : undefined));
    const { bridge, events } = makeBridge(agent.client, hooks.runner, { maxStopBlocks: 2 });
    await bridge.prompt({ threadId: "t", text: "go" });
    expect(agent.prompts).toHaveLength(3);
    expect(hookNotes(events).at(-1)).toMatch(/sent the agent back 2 times/);
    expect(finishes(events)).toHaveLength(1);
  });

  it("ends the turn without reaching the agent when UserPromptSubmit blocks", async () => {
    const agent = scriptedAgent([]);
    const hooks = scriptedHooks((event) => (event === "UserPromptSubmit" ? { block: "no secrets in prompts" } : undefined));
    const { bridge, events } = makeBridge(agent.client, hooks.runner);
    await bridge.prompt({ threadId: "t", text: "my key is sk-123" });
    expect(agent.prompts).toEqual([]);
    expect(hooks.calls.find((c) => c.event === "UserPromptSubmit")?.input.prompt).toBe("my key is sk-123");
    expect(hookNotes(events)).toEqual(["UserPromptSubmit hook test-hook: no secrets in prompts"]);
    expect(finishes(events)).toEqual([expect.objectContaining({ type: "RUN_FINISHED" })]);
  });

  it("adds SessionStart (once per session) and UserPromptSubmit context to the prompt", async () => {
    const agent = scriptedAgent([]);
    const hooks = scriptedHooks((event) =>
      event === "SessionStart" ? { context: ["repo uses pnpm"] } : event === "UserPromptSubmit" ? { context: ["it is Friday"] } : undefined,
    );
    const { bridge } = makeBridge(agent.client, hooks.runner);
    await bridge.prompt({ threadId: "t", text: "one" });
    await bridge.prompt({ threadId: "t", text: "two" });
    expect(agent.prompts[0]).toContain("repo uses pnpm");
    expect(agent.prompts[0]).toContain("it is Friday");
    expect(agent.prompts[1]).not.toContain("repo uses pnpm");
    expect(hooks.calls.filter((c) => c.event === "SessionStart")).toHaveLength(1);
  });

  it("runs goose's PostToolUse at the bridge and delivers its feedback when the turn ends", async () => {
    const agent = scriptedAgent([
      {
        updates: [
          { sessionUpdate: "tool_call", toolCallId: "c1", title: "Edit", rawInput: { path: "a.ts" } },
          { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: { type: "text", text: "edited" } }] },
        ],
        text: "Done.",
      },
      { text: "Fixed the lint." },
    ]);
    const hooks = scriptedHooks((event, input) =>
      event === "PostToolUse" && input.tool_name === "Edit" ? { block: "eslint: 2 errors in a.ts" } : undefined,
    );
    const { bridge } = makeBridge(agent.client, hooks.runner);
    await bridge.prompt({ threadId: "t", text: "edit" });
    const post = hooks.calls.find((c) => c.event === "PostToolUse")?.input;
    expect(post).toMatchObject({ tool_name: "Edit", tool_input: { path: "a.ts" }, tool_use_id: "c1" });
    expect(agent.prompts).toHaveLength(2);
    expect(agent.prompts[1]).toContain("Hook feedback on your Edit call: eslint: 2 errors in a.ts");
  });

  it("holds a deferred PreToolUse refusal for the end of the turn", async () => {
    let bridgeRef: ReturnType<typeof createSessionBridge> | undefined;
    const turns: Turn[] = [{ text: "Tried to push." }, { text: "OK, not force-pushing." }];
    const agent = scriptedAgent(turns);
    const hooks = scriptedHooks((event) => (event === "PreToolUse" ? { block: "no force-push" } : undefined));
    const prompt = agent.client.prompt;
    agent.client.prompt = async (p) => {
      // goose's approve-mode gate fires mid-turn, before the turn's reply.
      if (agent.prompts.length === 0) {
        const out = await bridgeRef!.runToolHook("PreToolUse", "Shell", { command: "git push -f" }, {}, true);
        expect(out.block).toBe("no force-push");
      }
      return prompt(p);
    };
    const { bridge } = makeBridge(agent.client, hooks.runner);
    bridgeRef = bridge;
    await bridge.prompt({ threadId: "t", text: "ship" });
    expect(agent.prompts).toHaveLength(2);
    expect(agent.prompts[1]).toContain("A hook refused your Shell call: no force-push");
  });

  it("tells hooks which conversation spawned a subagent", async () => {
    const agent = scriptedAgent([]);
    const hooks = scriptedHooks(() => undefined);
    const { bridge } = makeBridge(agent.client, hooks.runner, { parentId: () => "parent-1" });
    await bridge.prompt({ threadId: "t", text: "go", source: "subagent" });
    const stop = hooks.calls.find((c) => c.event === "Stop")?.input.scooter;
    expect(stop).toMatchObject({ parent_id: "parent-1", source: "subagent", provider: "goose" });
  });

  it("does not run Stop hooks for a cancelled turn", async () => {
    const agent = scriptedAgent([]);
    agent.client.prompt = async () => ({ stopReason: "cancelled" });
    const hooks = scriptedHooks(() => ({ block: "never" }));
    const { bridge } = makeBridge(agent.client, hooks.runner);
    await bridge.prompt({ threadId: "t", text: "go" });
    expect(hooks.calls.filter((c) => c.event === "Stop")).toEqual([]);
  });
});

describe("bridge untitled fact", () => {
  const stopFacts = async (untitled: (() => boolean) | undefined, text = "Done.") => {
    const agent = scriptedAgent([{ text }]);
    const hooks = scriptedHooks(() => undefined);
    const { bridge } = makeBridge(agent.client, hooks.runner, untitled ? { untitled } : {});
    await bridge.prompt({ threadId: "t", text: "fix it" });
    return (hooks.calls.find((c) => c.event === "Stop")!.input.scooter as Record<string, unknown>).untitled;
  };

  it("tells Stop hooks whether the conversation is unnamed", async () => {
    expect(await stopFacts(() => true)).toBe(true);
    expect(await stopFacts(() => false)).toBe(false);
    expect(await stopFacts(undefined)).toBe(false);
  });

  it("counts a <title> marker whose save is still in flight as named", async () => {
    expect(await stopFacts(() => true, "<title>Fix the thing</title>Done.")).toBe(false);
  });
});

describe("bridge folder fact", () => {
  it("tells every hook the owner's folder, reading it once per run", async () => {
    const agent = scriptedAgent([{ text: "Done." }]);
    const hooks = scriptedHooks(() => undefined);
    let reads = 0;
    const folder = async () => {
      reads++;
      return { id: "f1", name: "Infra" };
    };
    const { bridge } = makeBridge(agent.client, hooks.runner, { folder });
    await bridge.prompt({ threadId: "t", text: "fix it" });
    const seen = hooks.calls.map((c) => (c.input.scooter as Record<string, unknown>).folder);
    expect(seen.length).toBeGreaterThan(1);
    for (const f of seen) expect(f).toEqual({ id: "f1", name: "Infra" });
    expect(reads).toBe(1);
  });

  it("passes null when the read fails, so filed hooks skip", async () => {
    const agent = scriptedAgent([{ text: "Done." }]);
    const hooks = scriptedHooks(() => undefined);
    const { bridge } = makeBridge(agent.client, hooks.runner, { folder: () => Promise.reject(new Error("db down")) });
    await bridge.prompt({ threadId: "t", text: "fix it" });
    const stop = hooks.calls.find((c) => c.event === "Stop")!;
    expect((stop.input.scooter as Record<string, unknown>).folder).toBeNull();
  });
});
