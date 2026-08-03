/**
 * Tier 1 (REPLAY) — drive the REAL sdkClient with RECORDED claude messages, so the
 * test runs against the exact shapes the SDK emits, not a hand-authored fake. This
 * is the harness that would have caught the back-pressure bug: my fake fed a
 * `tool_result` in an `assistant` message; the REAL SDK sends it in a `user`
 * message (which the adapter drops) — so the yield hook keyed on `tool_call_update`
 * never fired.
 *
 * Fixture: recorded from live claude-code on odin (subagent-poll-loop).
 * See todo/docs/AGENT_TRANSCRIPT_HARNESS.md.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createSdkAcpClient } from "./sdkClient.js";
import type { ExecBackend, SessionUpdate } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// The fixture lives in agent-host's test tree (that package owns the recorder).
const FIXTURE = join(HERE, "../../agent-host/test/fixtures/transcripts/claude/subagent-poll-loop.ndjson");

const fakeExec: ExecBackend = {
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  createTerminal: async () => ({ id: "t", write: async () => {}, kill: async () => {}, output: async () => "" }),
} as unknown as ExecBackend;

/** The RAW recorded SDK messages, in order. */
function recordedSdkMessages(): unknown[] {
  return readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((e: { layer: string }) => e.layer === "sdk-in")
    .map((e: { data: unknown }) => e.data);
}

/** A fake query() that yields the RECORDED messages verbatim, honoring interrupt(). */
function replayQuery(messages: unknown[]) {
  let interrupted = false;
  const queryImpl = () => {
    async function* gen() {
      for (const msg of messages) {
        if (interrupted) return;
        yield msg as never;
        await Promise.resolve();
      }
    }
    return Object.assign(gen(), { interrupt: async () => { interrupted = true; } });
  };
  return { queryImpl, wasInterrupted: () => interrupted };
}

describe("REPLAY: real claude transcript (subagent-poll-loop)", () => {
  it("GROUND TRUTH: the SDK sends tool_result in a `user` message, not `assistant`", () => {
    const msgs = recordedSdkMessages() as Array<{ type?: string; message?: { content?: Array<{ type?: string }> } }>;
    const toolResults = msgs.filter((m) => m.message?.content?.some((b) => b.type === "tool_result"));
    expect(toolResults.length).toBeGreaterThan(0);
    // EVERY tool_result rides a `user` message — the shape the fake got wrong twice.
    expect(toolResults.every((m) => m.type === "user")).toBe(true);
  });

  it("the emitted updates carry each tool CALL (tool_use -> tool_call) from the real stream", async () => {
    const updates: SessionUpdate[] = [];
    const rq = replayQuery(recordedSdkMessages());
    const client = await createSdkAcpClient({ oauthToken: "t", model: "claude-opus-4-8", exec: fakeExec, systemPrompt: "hi", queryImpl: rq.queryImpl });
    client.onSessionUpdate((_id, u) => updates.push(u));
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({ prompt: [{ type: "text", text: "poll" }] } as never);

    const toolCalls = updates.filter((u) => u.sessionUpdate === "tool_call");
    expect(toolCalls.length).toBeGreaterThan(0); // real tool_use blocks became tool_call updates
  });

  it("REGRESSION: back-pressure yields when shouldYield() is true — even though tool_result rides a `user` message the adapter drops", async () => {
    // The bug: the yield hook keyed on `tool_call_update` (from a tool_result). But
    // the real SDK sends tool_result in a `user` message that the adapter ignores,
    // so no tool_call_update is emitted — the loop never yielded. The FIX keys the
    // yield on the tool CALL (tool_use -> tool_call), which the adapter DOES emit.
    // With shouldYield() true, replaying the real stream must INTERRUPT.
    const rq = replayQuery(recordedSdkMessages());
    const client = await createSdkAcpClient({
      oauthToken: "t", model: "claude-opus-4-8", exec: fakeExec, systemPrompt: "hi",
      queryImpl: rq.queryImpl, shouldYield: () => true,
    });
    await client.newSession({ threadId: "c1" } as never);
    await client.prompt({ prompt: [{ type: "text", text: "poll" }] } as never);
    expect(rq.wasInterrupted()).toBe(true);
  });
});
