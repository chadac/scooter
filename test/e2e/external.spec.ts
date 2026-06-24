/**
 * Tier 3 E2E — against a LIVE deployment (external server).
 *
 * Unlike the rest of the e2e suite (which boots a fake-agent stack locally),
 * this drives a REAL deployed agent-host: a real conversation spawns a real
 * sandbox and runs a real shell tool call via the in-cluster pods/exec path.
 * That exercises things the fake stack can't — e.g. the in-cluster exec
 * WebSocket, broker git auth, real Bedrock — so it catches cluster-only
 * failures (like a 403 on pods/exec).
 *
 * Gated: RUN_EXTERNAL_E2E=1 and AGENT_HOST_URL=<base url of the live agent-host>
 * (e.g. https://chat.example.com). Optional EXTERNAL_BASIC_AUTH=user:pass for
 * an endpoint behind basic-auth.
 *
 * It talks to the agent-host's HTTP API directly (no browser): POST /agui spawns
 * a conversation and streams AG-UI events; we accumulate the assistant's reply.
 * The agent is told to run a specific shell command and echo a sentinel, so a
 * working exec produces the sentinel and a broken one (403) does not.
 */

import { test, expect, request as pwRequest } from "@playwright/test";

const BASE = (process.env.AGENT_HOST_URL ?? "").replace(/\/$/, "");
const enabled = process.env.RUN_EXTERNAL_E2E === "1" && BASE !== "";
const maybe = enabled ? test.describe : test.describe.skip;

function authHeader(): Record<string, string> {
  const ba = process.env.EXTERNAL_BASIC_AUTH;
  if (!ba) return {};
  return { Authorization: "Basic " + Buffer.from(ba).toString("base64") };
}

/** POST /agui with a task and accumulate the assistant's final text. */
async function runConversation(task: string, timeoutMs = 180_000): Promise<string> {
  const ctx = await pwRequest.newContext({ extraHTTPHeaders: authHeader() });
  try {
    const threadId = `ext-e2e-${Date.now()}`;
    const res = await ctx.post(`${BASE}/agui`, {
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      data: { threadId, runId: "r1", messages: [{ id: "m1", role: "user", content: task }] },
      timeout: timeoutMs,
    });
    expect(res.ok(), `POST /agui failed: ${res.status()}`).toBeTruthy();
    const body = await res.text();
    // Accumulate TEXT_MESSAGE_CONTENT deltas; surface RUN_ERROR.
    let text = "";
    let runError = "";
    for (const line of body.split("\n")) {
      const m = line.match(/^data:\s*(.*)$/);
      if (!m) continue;
      let ev: { type?: string; delta?: string; message?: string };
      try {
        ev = JSON.parse(m[1]);
      } catch {
        continue;
      }
      if (ev.type === "TEXT_MESSAGE_CONTENT" && ev.delta) text += ev.delta;
      if (ev.type === "RUN_ERROR") runError += (ev.message ?? "") + " ";
    }
    if (runError) text += `\n[RUN_ERROR] ${runError}`;
    return text;
  } finally {
    await ctx.dispose();
  }
}

maybe("external deployment", () => {
  test("the live API is reachable + auth works", async () => {
    const ctx = await pwRequest.newContext({ extraHTTPHeaders: authHeader() });
    const res = await ctx.get(`${BASE}/models`);
    await ctx.dispose();
    expect(res.ok(), `GET /models failed: ${res.status()}`).toBeTruthy();
  });

  test("a real shell tool call runs in the sandbox (in-cluster exec works)", async () => {
    // Ask the agent to run a shell command and echo a sentinel. A working
    // in-cluster pods/exec produces the sentinel; a broken one (e.g. a 403 on
    // the exec WebSocket) yields a RUN_ERROR / no sentinel.
    const sentinel = `EXEC_OK_${Date.now()}`;
    const reply = await runConversation(
      `Run this shell command and report its output verbatim: echo ${sentinel}`,
    );
    expect(reply, `agent reply:\n${reply}`).toContain(sentinel);
    expect(reply).not.toMatch(/Permission denied|Unexpected server response|403|exec/i);
  });

  test("git clone over HTTPS works via the broker credential helper", async () => {
    // The repo skill + broker git auth should let the agent clone a public repo.
    // Use a tiny public repo so the clone is fast; assert it succeeded.
    const reply = await runConversation(
      "Clone the public repo https://github.com/githubtraining/hellogitworld " +
        "into /workspace/hello, then run `ls /workspace/hello` and report the output.",
      240_000,
    );
    expect(reply, `agent reply:\n${reply}`).toMatch(/README|LICENSE|\.git|hello/i);
    expect(reply).not.toMatch(/Permission denied|Unexpected server response|403|authentication failed/i);
  });
});
