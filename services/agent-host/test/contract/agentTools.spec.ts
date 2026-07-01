/**
 * Tier 1 contract — the agent-tools MCP handlers.
 *
 * RED until agentTools.ts is implemented (it's currently declare-only). These
 * encode the load-bearing guarantees:
 *   - ERRORS ARE NEVER HIDDEN: a broker non-2xx AND Slack's 200-with-{ok:false}
 *     both map to isError carrying the REAL upstream error verbatim.
 *   - INFERRED DEFAULTS: the tool reads the conversation's link `ref` for the
 *     target; a missing ref → a clear isError (never a wrong guess).
 *   - web_fetch is SSRF-guarded (refuses internal / cloud-metadata addresses).
 */

import { describe, it, expect, vi } from "vitest";

import {
  handleSlackRespond,
  handleJiraComment,
  handleWebFetch,
  inferRef,
  toToolResult,
  type BrokerClient,
  type BrokerResponse,
  type ToolContext,
  type AgentToolsDeps,
} from "../../src/agent/agentTools.js";
import type { ConversationLink } from "../../src/session/manager.js";

function fakeBroker(res: BrokerResponse): BrokerClient {
  return { call: vi.fn(async () => res) };
}

const slackLink = (ref?: ConversationLink["ref"]): ConversationLink => ({
  source: "slack",
  resourceType: "thread",
  title: "#eng thread",
  ref: ref ?? { channel: "C123", threadTs: "1700.5" },
});

function ctxWith(links: ConversationLink[]): ToolContext {
  return { conversationId: "c1", links: async () => links };
}

describe("agent-tools: error-echo (never hide)", () => {
  it("maps a broker non-2xx to isError with the verbatim status + body", () => {
    const res: BrokerResponse = { status: 502, raw: "upstream boom", data: undefined };
    const out = toToolResult(res, { successText: "posted" });
    expect(out.isError).toBe(true);
    const text = out.content.map((c) => c.text).join("");
    expect(text).toContain("502");
    expect(text).toContain("upstream boom");
  });

  it("treats Slack 200-with-{ok:false} as an error and surfaces Slack's error", () => {
    const res: BrokerResponse = { status: 200, raw: '{"ok":false,"error":"channel_not_found"}', data: { ok: false, error: "channel_not_found" } };
    const out = toToolResult(res, { successText: "posted", slackOkCheck: true });
    expect(out.isError).toBe(true);
    expect(out.content.map((c) => c.text).join("")).toContain("channel_not_found");
  });

  it("returns success text on a 200 ok:true", () => {
    const res: BrokerResponse = { status: 200, raw: '{"ok":true,"ts":"1.2"}', data: { ok: true, ts: "1.2" } };
    const out = toToolResult(res, { successText: "posted to the thread", slackOkCheck: true });
    expect(out.isError).toBeFalsy();
    expect(out.content.map((c) => c.text).join("")).toContain("posted to the thread");
  });
});

describe("agent-tools: inferred defaults", () => {
  it("infers the slack channel + thread_ts from the conversation link ref", () => {
    const ref = inferRef([slackLink({ channel: "CABC", threadTs: "42.0" })], "slack");
    expect(ref).toMatchObject({ channel: "CABC", threadTs: "42.0" });
  });

  it("returns undefined when no matching link ref exists", () => {
    expect(inferRef([], "slack")).toBeUndefined();
  });

  it("slack_respond posts to the inferred thread and reports success", async () => {
    const broker = fakeBroker({ status: 200, raw: '{"ok":true,"ts":"9.9"}', data: { ok: true, ts: "9.9" } });
    const deps: AgentToolsDeps = { broker };
    const out = await handleSlackRespond(deps, ctxWith([slackLink()]), { text: "on it" });
    expect(out.isError).toBeFalsy();
    // Called the broker's slack chat.postMessage with the inferred channel + ts.
    const call = (broker.call as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2]).toContain("/slack/chat.postMessage");
    expect(call[3]).toMatchObject({ channel: "C123", thread_ts: "1700.5", text: "on it" });
  });

  it("slack_respond errors clearly (not a guess) when neither ref nor DB has the target", async () => {
    const broker = fakeBroker({ status: 200, raw: "{}", data: {} });
    const out = await handleSlackRespond({ broker }, ctxWith([]), { text: "hi" });
    expect(out.isError).toBe(true);
    expect((broker.call as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0); // never called blind
  });

  it("slack_respond FALLS BACK to the webhooks conversation_map when the link has no ref", async () => {
    // A conversation created before `ref` existed: its slack link has no channel.
    const refless: ConversationLink = { source: "slack", resourceType: "thread", title: "#eng thread" };
    const broker = fakeBroker({ status: 200, raw: '{"ok":true}', data: { ok: true } });
    // The webhooks store maps this conversation to its slack resource.
    const ctx: ToolContext = {
      conversationId: "c1",
      links: async () => [refless],
      resourceLookup: async (source) =>
        source === "slack"
          ? { source: "slack", resourceType: "thread", resourceId: "C999:1699.42", slackChannel: "C999", slackTs: "1699.42" }
          : undefined,
    };
    const out = await handleSlackRespond({ broker }, ctx, { text: "on it" });
    expect(out.isError).toBeFalsy();
    const call = (broker.call as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[3]).toMatchObject({ channel: "C999", thread_ts: "1699.42", text: "on it" });
  });

  it("slack_respond fallback parses channel:thread_ts from resource_id when the slack columns are unset", async () => {
    const broker = fakeBroker({ status: 200, raw: '{"ok":true}', data: { ok: true } });
    const ctx: ToolContext = {
      conversationId: "c1",
      links: async () => [],
      resourceLookup: async () => ({ source: "slack", resourceType: "thread", resourceId: "C777:1700.9" }),
    };
    const out = await handleSlackRespond({ broker }, ctx, { text: "hi" });
    expect(out.isError).toBeFalsy();
    expect((broker.call as ReturnType<typeof vi.fn>).mock.calls[0][3]).toMatchObject({ channel: "C777", thread_ts: "1700.9" });
  });

  it("jira_comment posts to the inferred issue via the v2 comment endpoint", async () => {
    const broker = fakeBroker({ status: 201, raw: '{"id":"1"}', data: { id: "1" } });
    const jiraLink: ConversationLink = { source: "jira", resourceType: "issue", ref: { issueKey: "ENG-42" } };
    const out = await handleJiraComment({ broker }, ctxWith([jiraLink]), { body: "done" });
    expect(out.isError).toBeFalsy();
    const call = (broker.call as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2]).toBe("/jira/rest/api/2/issue/ENG-42/comment");
    expect(call[3]).toMatchObject({ body: "done" });
  });

  it("jira_comment errors clearly (not a guess) when the issue can't be inferred", async () => {
    const broker = fakeBroker({ status: 200, raw: "{}", data: {} });
    const out = await handleJiraComment({ broker }, ctxWith([]), { body: "hi" });
    expect(out.isError).toBe(true);
    expect((broker.call as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});

describe("agent-tools: web_fetch SSRF guard", () => {
  const deps: AgentToolsDeps = { broker: fakeBroker({ status: 200, raw: "", data: undefined }) };

  it.each([
    "http://169.254.169.254/latest/meta-data/", // cloud metadata
    "http://127.0.0.1:8080/",                    // loopback
    "http://10.0.0.5/",                          // RFC1918
    "http://agent-broker.agent-sandbox.svc.cluster.local/", // cluster-internal
  ])("refuses %s", async (url) => {
    const out = await handleWebFetch(deps, { url });
    expect(out.isError).toBe(true);
  });
});
