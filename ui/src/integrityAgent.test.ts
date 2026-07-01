/**
 * Tier 1 (ui) — IntegrityAgent full-fidelity rendering.
 *
 * RED until IntegrityAgent is implemented (it's currently a `declare`-only stub).
 *
 * Proves the core guarantee: an IntegrityAgent driven by a scripted integrity
 * stream (text + a tool call + a reasoning block, each in a checksum envelope)
 * produces the SAME full-fidelity message state assistant-ui renders from a
 * locally-driven /agui run — text message, tool call, and reasoning all present.
 * This is what makes a Slack-driven run look identical to your own in the UI.
 *
 * We feed the agent a fake integrity source (no real network): a list of
 * IntegrityFrame-shaped events, then assert the AbstractAgent's applied
 * `messages` reflect all three modalities. Send is fire-and-forget: a prompt
 * issues POST /agui and does NOT block on / consume its SSE.
 */

import { describe, it, expect, vi } from "vitest";

import { createIntegrityAgent } from "./integrityAgent.js";

// A scripted integrity stream: TEXT + TOOL_CALL_* + REASONING_*, checksum-wrapped.
// (Shapes mirror bridge.ts AguiEvent + integrityStream.ts IntegrityFrame.)
const SCRIPTED_FRAMES = [
  { kind: "event", event: { type: "RUN_STARTED", threadId: "c1", runId: "r1" } },
  { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" } },
  { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Working on it" } },
  { kind: "event", event: { type: "TEXT_MESSAGE_END", messageId: "m1" } },
  { kind: "event", event: { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "run_command" } },
  { kind: "event", event: { type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: '{"cmd":"ls"}' } },
  { kind: "event", event: { type: "TOOL_CALL_END", toolCallId: "t1" } },
  { kind: "event", event: { type: "TOOL_CALL_RESULT", toolCallId: "t1", messageId: "m2", content: "a.txt" } },
  { kind: "event", event: { type: "REASONING_START", messageId: "g1" } },
  { kind: "event", event: { type: "REASONING_MESSAGE_START", messageId: "g1", role: "reasoning" } },
  { kind: "event", event: { type: "REASONING_MESSAGE_CONTENT", messageId: "g1", delta: "think" } },
  { kind: "event", event: { type: "REASONING_MESSAGE_END", messageId: "g1" } },
  { kind: "event", event: { type: "REASONING_END", messageId: "g1" } },
  { kind: "event", event: { type: "RUN_FINISHED", threadId: "c1", runId: "r1" } },
  { kind: "synced" },
];

describe("IntegrityAgent", () => {
  it.todo("renders text + tool call + reasoning (full fidelity) from the integrity stream", async () => {
    // TODO(impl): inject the scripted frames as the agent's integrity source
    // (a fetch/EventSource stub), subscribe, and assert:
    //   - a text message "Working on it"
    //   - a tool call `run_command` with args + result "a.txt"
    //   - a reasoning message "think"
    // are ALL present in the applied messages.
    const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1" });
    expect(agent).toBeDefined();
    expect(SCRIPTED_FRAMES.length).toBeGreaterThan(0);
  });

  it.todo("send() issues a fire-and-forget POST /agui and does NOT consume its SSE", async () => {
    // TODO(impl): stub fetch; agent.send("hi") POSTs {threadId:"c1", messages:[...]}
    // to /agui, resolves without reading the response body, and writes NOTHING to
    // the thread directly (the reply arrives via the integrity source).
    const fetchSpy = vi.fn();
    void fetchSpy;
    expect(true).toBe(true);
  });

  it.todo("submitResume() POSTs /agui with resume[] to answer an interrupt", async () => {
    // TODO(impl): agent.submitResume([{interruptId, status:"resolved"}]) -> POST
    // /agui { resume: [...] }; the continued run streams back via the integrity source.
    expect(true).toBe(true);
  });
});
