/**
 * Tier 1 — replay the REAL goose subagent-fanout transcript (recorded against
 * Bedrock, real ACP tool calls) and assert the completion machinery works on
 * goose's actual event shapes.
 *
 * This is the provider that exposed the completion bug: a subagent finishes but
 * its result never reaches the parent. The host-side race is fixed + unit-tested in
 * store-flush.spec.ts (the fire-and-forget append/read window). THIS test guards the
 * OTHER half — that goose's real subagent event shape is one the completion path can
 * actually read: lastRunCompleted() sees the RUN_FINISHED and lastAssistantText()
 * extracts the child's final message (the haiku). If a goose version change alters
 * that shape (e.g. the final turn stops ending with an assistant TEXT message), this
 * catches it — which the fake-agent tests never would.
 *
 * The fixture is recorded, not hand-authored:
 *   GOOSE_BACKEND=bedrock node test/support/record-transcript.mjs goose subagent-fanout
 */

import { describe, it, expect } from "vitest";

import { fixtureExists, loadFixture, type TranscriptEntry } from "../support/transcript.js";
import { lastRunCompleted } from "../../src/session/danglingRun.js";
import { lastAssistantText } from "../../src/agent/subagentTools.js";
import type { AguiEvent } from "../../src/bridge.js";

const SCENARIO = "subagent-fanout";

// The recorder concatenates parent + subagent conversations into one file, each
// entry tagged with its conversationId. Group the agui-out events per conversation.
function eventsByConversation(entries: TranscriptEntry[]): Map<string, AguiEvent[]> {
  const byConv = new Map<string, AguiEvent[]>();
  for (const e of entries) {
    if (e.layer !== "agui-out") continue;
    const conv = (e as { conversationId?: string }).conversationId ?? "?";
    (byConv.get(conv) ?? byConv.set(conv, []).get(conv)!).push(e.data as AguiEvent);
  }
  return byConv;
}

// goose renders the MCP tool name as "Scooter-env: Spawn Subagent"; the SDK/other
// paths use "spawn_subagent". Match either (space- or underscore-separated).
const SPAWN_RE = /spawn[_ ]?subagent/i;
const hasSpawn = (events: AguiEvent[]) =>
  events.some((e) => e.type === "TOOL_CALL_START" && SPAWN_RE.test((e as { toolCallName?: string }).toolCallName ?? ""));

// Gated: the fixture is recorded on demand (needs Bedrock creds), so skip cleanly
// when it isn't present rather than fail on a fresh checkout.
const maybe = fixtureExists("goose", SCENARIO) ? describe : describe.skip;

maybe("goose subagent-fanout (real Bedrock transcript)", () => {
  const entries = fixtureExists("goose", SCENARIO) ? loadFixture("goose", SCENARIO) : [];
  const byConv = eventsByConversation(entries);
  const parents = [...byConv.entries()].filter(([, ev]) => hasSpawn(ev));
  const subagents = [...byConv.entries()].filter(([, ev]) => !hasSpawn(ev));

  it("the parent actually spawned subagents (real spawn_subagent tool calls)", () => {
    expect(parents.length).toBe(1);
    const parentSpawns = parents[0][1].filter(
      (e) => e.type === "TOOL_CALL_START" && SPAWN_RE.test((e as { toolCallName?: string }).toolCallName ?? ""),
    );
    expect(parentSpawns.length).toBeGreaterThanOrEqual(2);
  });

  it("every subagent's run COMPLETED (lastRunCompleted sees a real goose RUN_FINISHED)", () => {
    expect(subagents.length).toBeGreaterThanOrEqual(2);
    for (const [, ev] of subagents) {
      expect(lastRunCompleted(ev)).toBe(true);
    }
  });

  it("every subagent yields a non-empty result (lastAssistantText extracts goose's final message)", () => {
    // The exact failure the parent saw: a finished subagent whose result was empty →
    // "reported no final result message". On real goose the final turn IS a plain
    // assistant TEXT message, so lastAssistantText must return it.
    for (const [conv, ev] of subagents) {
      const result = lastAssistantText(ev);
      expect(result, `subagent ${conv} produced no extractable final text`).toBeTruthy();
      expect((result ?? "").length).toBeGreaterThan(0);
    }
  });
});
