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
  handleSlackReact,
  handleJiraComment,
  handleGithubComment,
  handleGitlabComment,
  handleWebFetch,
  inferRef,
  toToolResult,
  registerAgentTools,
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

  it("slack_react reacts to the inferred thread message, stripping colons from the emoji", async () => {
    const broker = fakeBroker({ status: 200, raw: '{"ok":true}', data: { ok: true } });
    const out = await handleSlackReact({ broker }, ctxWith([slackLink()]), { emoji: ":eyes:" });
    expect(out.isError).toBeFalsy();
    const call = (broker.call as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2]).toContain("/slack/reactions.add");
    // channel + the thread anchor ts as the target message; name WITHOUT colons.
    expect(call[3]).toMatchObject({ channel: "C123", timestamp: "1700.5", name: "eyes" });
  });

  it("slack_react FALLS BACK to the webhooks conversation_map when the link has no ref", async () => {
    const refless: ConversationLink = { source: "slack", resourceType: "thread", title: "#eng thread" };
    const broker = fakeBroker({ status: 200, raw: '{"ok":true}', data: { ok: true } });
    const ctx: ToolContext = {
      conversationId: "c1",
      links: async () => [refless],
      resourceLookup: async () => ({ source: "slack", resourceType: "thread", resourceId: "C999:1699.42", slackChannel: "C999", slackTs: "1699.42" }),
    };
    const out = await handleSlackReact({ broker }, ctx, { emoji: "tada" });
    expect(out.isError).toBeFalsy();
    expect((broker.call as ReturnType<typeof vi.fn>).mock.calls[0][3]).toMatchObject({ channel: "C999", timestamp: "1699.42", name: "tada" });
  });

  it("slack_react errors clearly (not a guess) when neither ref nor DB has the target", async () => {
    const broker = fakeBroker({ status: 200, raw: "{}", data: {} });
    const out = await handleSlackReact({ broker }, ctxWith([]), { emoji: "eyes" });
    expect(out.isError).toBe(true);
    expect((broker.call as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
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

describe("agent-tools: DB fallback for github/gitlab/jira (ref-less links)", () => {
  const ok = (): BrokerResponse => ({ status: 201, raw: '{"id":1}', data: { id: 1 } });

  it("github_comment FALLS BACK to the conversation_map (owner/repo#number) when the link has no ref", async () => {
    const broker = fakeBroker(ok());
    const ctx: ToolContext = {
      conversationId: "c1",
      links: async () => [],
      resourceLookup: async (source) =>
        source === "github"
          ? { source: "github", resourceType: "pull_request", resourceId: "octo/hello-world#7" }
          : undefined,
    };
    const out = await handleGithubComment({ broker }, ctx, { body: "on it" });
    expect(out.isError).toBeFalsy();
    const call = (broker.call as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2]).toBe("/github/repos/octo/hello-world/issues/7/comments");
  });

  it("github_comment errors when neither the ref nor the DB has the target", async () => {
    const broker = fakeBroker(ok());
    const ctx: ToolContext = { conversationId: "c1", links: async () => [], resourceLookup: async () => undefined };
    const out = await handleGithubComment({ broker }, ctx, { body: "hi" });
    expect(out.isError).toBe(true);
    expect((broker.call as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("gitlab_comment FALLS BACK to the conversation_map for an MR (repo!iid)", async () => {
    const broker = fakeBroker(ok());
    const ctx: ToolContext = {
      conversationId: "c1",
      links: async () => [],
      resourceLookup: async (source) =>
        source === "gitlab"
          ? { source: "gitlab", resourceType: "merge_request", resourceId: "group/proj!12" }
          : undefined,
    };
    const out = await handleGitlabComment({ broker }, ctx, { body: "on it" });
    expect(out.isError).toBeFalsy();
    const call = (broker.call as ReturnType<typeof vi.fn>).mock.calls[0];
    // repo path is URL-encoded as the project id.
    expect(call[2]).toBe("/gitlab/projects/group%2Fproj/merge_requests/12/notes");
  });

  it("gitlab_comment FALLS BACK to the conversation_map for an issue (repo#iid)", async () => {
    const broker = fakeBroker(ok());
    const ctx: ToolContext = {
      conversationId: "c1",
      links: async () => [],
      resourceLookup: async () => ({ source: "gitlab", resourceType: "issue", resourceId: "group/proj#5" }),
    };
    const out = await handleGitlabComment({ broker }, ctx, { body: "hi" });
    expect(out.isError).toBeFalsy();
    expect((broker.call as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe("/gitlab/projects/group%2Fproj/issues/5/notes");
  });

  it("jira_comment FALLS BACK to the conversation_map (resource_id IS the issue key)", async () => {
    const broker = fakeBroker(ok());
    const ctx: ToolContext = {
      conversationId: "c1",
      links: async () => [],
      resourceLookup: async (source) =>
        source === "jira" ? { source: "jira", resourceType: "issue", resourceId: "ENG-99" } : undefined,
    };
    const out = await handleJiraComment({ broker }, ctx, { body: "done" });
    expect(out.isError).toBeFalsy();
    expect((broker.call as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe("/jira/rest/api/2/issue/ENG-99/comment");
  });

  it("the link ref WINS over the DB fallback when both are present", async () => {
    const broker = fakeBroker(ok());
    const jiraLink: ConversationLink = { source: "jira", resourceType: "issue", ref: { issueKey: "ENG-1" } };
    const ctx: ToolContext = {
      conversationId: "c1",
      links: async () => [jiraLink],
      resourceLookup: async () => ({ source: "jira", resourceType: "issue", resourceId: "ENG-999" }),
    };
    const out = await handleJiraComment({ broker }, ctx, { body: "done" });
    expect(out.isError).toBeFalsy();
    expect((broker.call as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe("/jira/rest/api/2/issue/ENG-1/comment");
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

describe("agent-tools: registered titles (the UI's provider-card renderer keys off these)", () => {
  // The UI's ToolCallView (ui/src/toolCallView.ts) matches these EXACT title
  // strings to render slack/github/gitlab/jira as message cards. goose surfaces
  // the ACP `title` as the tool name in the UI, so a rename here silently reverts
  // the card to the generic tool box. If you change a title, update the UI matcher.
  it("keeps the titles the UI depends on", () => {
    const titles = new Map<string, string>();
    const server = {
      registerTool: (name: string, meta: { title?: string }) => {
        titles.set(name, meta.title ?? "");
      },
    } as unknown as Parameters<typeof registerAgentTools>[0];
    registerAgentTools(
      server,
      { broker: fakeBroker({ status: 200, raw: "", data: undefined }) },
      ctxWith([]),
    );
    expect(titles.get("slack_respond")).toBe("Respond in the Slack thread");
    expect(titles.get("slack_react")).toBe("React to the Slack message");
    expect(titles.get("github_comment")).toBe("Comment on the GitHub PR/issue");
    expect(titles.get("gitlab_comment")).toBe("Comment on the GitLab MR");
    expect(titles.get("jira_comment")).toBe("Comment on the Jira issue");
  });
});
