/**
 * UI-LAYER REPLAY harness (Tier-1). Replays a REAL recorded AG-UI event log through
 * the ACTUAL UI render path (IntegrityAgent fold + RuntimeProvider's
 * spliceSystemMessages) and asserts the RENDER ORDER — so render-layer bugs are
 * caught even when the server's event log is correct.
 *
 * A transcript replay that stops at the AG-UI log would NOT catch this class of bug:
 * the log is right; the UI splices the chip wrong. Fixtures are the real AG-UI logs
 * recorded from live agents (see todo/docs/AGENT_TRANSCRIPT_HARNESS.md).
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createIntegrityAgent } from "./integrityAgent.js";
import { spliceSystemMessages, parseSystemMessage } from "./RuntimeProvider.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Load a recorded AG-UI event log fixture (array of AguiEvent). */
function loadAguiLog(name: string): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(join(HERE, "__fixtures__", name), "utf8"));
}

/** A fetchImpl that serves a recorded AG-UI log on the integrity stream (each event
 *  wrapped as an integrity frame) + an empty /tail. This drives the REAL
 *  IntegrityAgent fold with real server output. */
function replayFetch(events: Array<Record<string, unknown>>): typeof fetch {
  const frames = [...events.map((event) => ({ kind: "event", event })), { kind: "synced" }];
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
  return vi.fn(async (url: string) => {
    if (typeof url === "string" && url.includes("/tail")) {
      return new Response(JSON.stringify({ events: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

/** Fold a recorded AG-UI log through the real IntegrityAgent, then produce the
 *  EXACT render list RuntimeProvider builds (folded messages + spliced system
 *  chips). Returns the render order as a list of {kind, id, ...}. */
async function renderFrom(events: Array<Record<string, unknown>>) {
  const agent = createIntegrityAgent({ baseUrl: "http://host", conversationId: "c1", fetchImpl: replayFetch(events), idleReconnectMs: 0 });
  const stop = agent.renderPump();
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const done = () => { unsub(); stop(); resolve(); };
    const { unsubscribe: unsub } = agent.subscribe({ onMessagesChanged: () => { clearTimeout(timer); timer = setTimeout(done, 150); } });
    setTimeout(done, 1500);
  });
  const folded = (agent as unknown as { messages: Array<{ id?: string; role?: string; content?: unknown; toolCalls?: unknown[] }> }).messages;
  const spliced = spliceSystemMessages(folded, agent.getSystemMessages()) as Array<{ id?: string; role?: string; content?: unknown; toolCalls?: unknown[] }>;
  agent.dispose();
  // Flatten to a render-order list: each real message contributes its text and its
  // tool cards (in that order, as assistant-ui renders); a sys chip is one entry.
  const order: Array<{ kind: "text" | "tool" | "sys"; label: string }> = [];
  for (const m of spliced) {
    const content = m.content;
    const textPart = typeof content === "string" ? content : Array.isArray(content) ? (content.find((p) => (p as { type?: string }).type === "text") as { text?: string } | undefined)?.text ?? "" : "";
    const sys = parseSystemMessage(m.id, textPart);
    if (sys) { order.push({ kind: "sys", label: sys.source }); continue; }
    if (textPart) order.push({ kind: "text", label: (m.id ?? "") + "" });
    for (const tc of m.toolCalls ?? []) {
      const name = (tc as { function?: { name?: string } }).function?.name ?? "tool";
      order.push({ kind: "tool", label: String(name).split("__").pop() ?? "tool" });
    }
  }
  return order;
}

describe("UI-layer replay: real AG-UI log render order", () => {
  it("folds the real claude subagent transcript into messages + tool cards", async () => {
    const order = await renderFrom(loadAguiLog("claude-subagent-chip-order.json"));
    // Sanity: the real log produced check_subagent tool cards and the subagent chip.
    expect(order.some((o) => o.kind === "tool" && o.label === "check_subagent")).toBe(true);
    expect(order.some((o) => o.kind === "sys" && o.label === "subagent")).toBe(true);
  });

  // KNOWN BUG (todo/docs/AGENT_TRANSCRIPT_HARNESS.md): the subagent-result chip
  // renders ABOVE the check_subagent tool cards that preceded it — the chip anchors
  // to the last TEXT_MESSAGE_START, but the tool cards nest into that SAME assistant
  // message, so the splice puts the chip before them. Server order is correct; this
  // is a UI render-splice artifact. This test CAPTURES it: the sys chip must come
  // AFTER the last check_subagent card. `it.fails` = we EXPECT this to fail today;
  // when the splice/anchor is fixed it will start passing → vitest flags it so we
  // remove `.fails`. This is the render-layer harness catching a real recorded bug.
  it.fails("renders the subagent-result chip AFTER the check_subagent tool cards, not above them", async () => {
    const order = await renderFrom(loadAguiLog("claude-subagent-chip-order.json"));
    const lastCheck = order.map((o) => o.kind === "tool" && o.label === "check_subagent").lastIndexOf(true);
    const sysIdx = order.findIndex((o) => o.kind === "sys" && o.label === "subagent");
    expect(lastCheck).toBeGreaterThanOrEqual(0);
    expect(sysIdx).toBeGreaterThan(lastCheck); // the chip must come AFTER the polls
  });
});
