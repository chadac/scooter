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
  handleGetSlackContext,
  handleJiraComment,
  handleGithubComment,
  handleGitlabComment,
  handleWebFetch,
  inferRef,
  toToolResult,
  registerAgentTools,
  registerWebTools,
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

  it("treats an idempotent Slack error (already_reacted) as SUCCESS, not failure", () => {
    // The webhooks handler adds 👀 pre-dispatch, so the agent's own ack-react hits
    // `already_reacted` constantly — the desired state already exists, not an error.
    const res: BrokerResponse = { status: 200, raw: '{"ok":false,"error":"already_reacted"}', data: { ok: false, error: "already_reacted" } };
    const out = toToolResult(res, { successText: "Reacted", slackOkCheck: true, idempotentErrors: ["already_reacted"] });
    expect(out.isError).toBeFalsy();
    expect(out.content.map((c) => c.text).join("")).toContain("already");
  });

  it("still errors on a NON-idempotent Slack error even with idempotentErrors set", () => {
    const res: BrokerResponse = { status: 200, raw: '{"ok":false,"error":"channel_not_found"}', data: { ok: false, error: "channel_not_found" } };
    const out = toToolResult(res, { successText: "Reacted", slackOkCheck: true, idempotentErrors: ["already_reacted"] });
    expect(out.isError).toBe(true);
    expect(out.content.map((c) => c.text).join("")).toContain("channel_not_found");
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

  it("slack_react reacts to the EXPLICIT message_ts (not the thread anchor), stripping colons from the emoji", async () => {
    const broker = fakeBroker({ status: 200, raw: '{"ok":true}', data: { ok: true } });
    // thread anchor is 1700.5 (from slackLink()); react to a DIFFERENT message in the thread.
    const out = await handleSlackReact({ broker }, ctxWith([slackLink()]), { emoji: ":eyes:", message_ts: "1701.9" });
    expect(out.isError).toBeFalsy();
    const call = (broker.call as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2]).toContain("/slack/reactions.add");
    // channel from the link + the EXPLICIT message_ts (not the thread anchor); name WITHOUT colons.
    expect(call[3]).toMatchObject({ channel: "C123", timestamp: "1701.9", name: "eyes" });
  });

  it("slack_react returns SUCCESS when Slack says already_reacted (webhooks 👀 got there first)", async () => {
    const broker = fakeBroker({ status: 200, raw: '{"ok":false,"error":"already_reacted"}', data: { ok: false, error: "already_reacted" } });
    const out = await handleSlackReact({ broker }, ctxWith([slackLink()]), { emoji: ":eyes:", message_ts: "1700.5" });
    expect(out.isError).toBeFalsy(); // idempotent — not a (noisy) error
  });

  it("slack_react resolves the channel from the webhooks conversation_map when the link has no ref", async () => {
    const refless: ConversationLink = { source: "slack", resourceType: "thread", title: "#eng thread" };
    const broker = fakeBroker({ status: 200, raw: '{"ok":true}', data: { ok: true } });
    const ctx: ToolContext = {
      conversationId: "c1",
      links: async () => [refless],
      resourceLookup: async () => ({ source: "slack", resourceType: "thread", resourceId: "C999:1699.42", slackChannel: "C999", slackTs: "1699.42" }),
    };
    const out = await handleSlackReact({ broker }, ctx, { emoji: "tada", message_ts: "1699.42" });
    expect(out.isError).toBeFalsy();
    expect((broker.call as ReturnType<typeof vi.fn>).mock.calls[0][3]).toMatchObject({ channel: "C999", timestamp: "1699.42", name: "tada" });
  });

  it("slack_react errors (no guess, no broker call) when message_ts is missing", async () => {
    const broker = fakeBroker({ status: 200, raw: "{}", data: {} });
    // channel is resolvable, but the agent forgot the required message_ts.
    const out = await handleSlackReact({ broker }, ctxWith([slackLink()]), { emoji: "eyes", message_ts: "  " });
    expect(out.isError).toBe(true);
    expect(out.content?.[0]?.text ?? "").toContain("message_ts");
    expect((broker.call as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("slack_react errors clearly (not a guess) when the channel can't be resolved", async () => {
    const broker = fakeBroker({ status: 200, raw: "{}", data: {} });
    const out = await handleSlackReact({ broker }, ctxWith([]), { emoji: "eyes", message_ts: "1700.5" });
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
    expect(call[2]).toBe("/gitlab/api/v4/projects/group%2Fproj/merge_requests/12/notes");
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
    expect((broker.call as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe("/gitlab/api/v4/projects/group%2Fproj/issues/5/notes");
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

describe("agent-tools: web tools are decoupled from the broker", () => {
  // web_search/web_fetch hit DuckDuckGo / a URL directly and never touch the broker,
  // so registerWebTools must register them with NO broker dep, and registerAgentTools
  // must no longer own them. See PR (decouple web tools from broker).
  it("registerWebTools registers web_search + web_fetch without a broker", () => {
    const names = new Set<string>();
    const server = {
      registerTool: (name: string) => names.add(name),
    } as unknown as Parameters<typeof registerWebTools>[0];
    registerWebTools(server, {});
    expect(names.has("web_search")).toBe(true);
    expect(names.has("web_fetch")).toBe(true);
  });

  it("registerAgentTools no longer registers the web tools", async () => {
    const names = new Set<string>();
    const server = {
      registerTool: (name: string) => names.add(name),
    } as unknown as Parameters<typeof registerAgentTools>[0];
    await registerAgentTools(server, { broker: fakeBroker({ status: 200, raw: "", data: undefined }) }, allAttached());
    expect(names.has("web_search")).toBe(false);
    expect(names.has("web_fetch")).toBe(false);
  });
});

// A ctx with every provider attached (via link refs), so all provider tools register.
const githubLink = (): ConversationLink => ({
  source: "github", resourceType: "pr", title: "PR", ref: { owner: "o", repo: "r", number: 7 },
});
const gitlabLink = (): ConversationLink => ({
  source: "gitlab", resourceType: "mr", title: "MR", ref: { projectId: "g/p", mrIid: "3" },
});
const jiraLinkFull = (): ConversationLink => ({
  source: "jira", resourceType: "issue", title: "ENG-1", ref: { issueKey: "ENG-1" },
});
const allAttached = (): ToolContext =>
  ctxWith([slackLink(), githubLink(), gitlabLink(), jiraLinkFull()]);

/** Register the agent-tools against a fake server and return the set of tool names
 *  (and their titles) that actually got registered. Mirrors buildServer: the web
 *  tools come from registerWebTools (broker-independent), the provider reply tools
 *  from registerAgentTools (broker + attachment-gated). */
async function registeredTools(ctx: ToolContext): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const server = {
    registerTool: (name: string, meta: { title?: string }) => {
      titles.set(name, meta.title ?? "");
    },
  } as unknown as Parameters<typeof registerAgentTools>[0];
  registerWebTools(server, {});
  await registerAgentTools(server, { broker: fakeBroker({ status: 200, raw: "", data: undefined }) }, ctx);
  return titles;
}

describe("agent-tools: registered titles (the UI's provider-card renderer keys off these)", () => {
  // The UI's ToolCallView (ui/src/toolCallView.ts) matches these EXACT title
  // strings to render slack/github/gitlab/jira as message cards. goose surfaces
  // the ACP `title` as the tool name in the UI, so a rename here silently reverts
  // the card to the generic tool box. If you change a title, update the UI matcher.
  it("keeps the titles the UI depends on (all providers attached)", async () => {
    const titles = await registeredTools(allAttached());
    expect(titles.get("slack_respond")).toBe("Respond in the Slack thread");
    expect(titles.get("slack_react")).toBe("React to the Slack message");
    expect(titles.get("get_slack_context")).toBe("Get the Slack thread context");
    expect(titles.get("github_comment")).toBe("Comment on the GitHub PR/issue");
    expect(titles.get("gitlab_comment")).toBe("Comment on the GitLab MR");
    expect(titles.get("jira_comment")).toBe("Comment on the Jira issue");
  });
});

describe("agent-tools: provider tools gate on attachment", () => {
  it("registers NO provider reply tools when nothing is attached — only web_*", async () => {
    const titles = await registeredTools(ctxWith([]));
    for (const t of ["slack_respond", "slack_react", "get_slack_context", "github_comment", "gitlab_comment", "jira_comment"]) {
      expect(titles.has(t), `${t} must NOT register with no attachment`).toBe(false);
    }
    // web_search / web_fetch don't depend on a linked resource — always present.
    expect(titles.has("web_search")).toBe(true);
    expect(titles.has("web_fetch")).toBe(true);
  });

  it("registers only the slack tools when only Slack is attached", async () => {
    const titles = await registeredTools(ctxWith([slackLink()]));
    expect(titles.has("slack_respond")).toBe(true);
    expect(titles.has("slack_react")).toBe(true);
    expect(titles.has("get_slack_context")).toBe(true);
    expect(titles.has("github_comment")).toBe(false);
    expect(titles.has("gitlab_comment")).toBe(false);
    expect(titles.has("jira_comment")).toBe(false);
  });

  it("registers only github_comment when only GitHub is attached", async () => {
    const titles = await registeredTools(ctxWith([githubLink()]));
    expect(titles.has("github_comment")).toBe(true);
    expect(titles.has("slack_respond")).toBe(false);
    expect(titles.has("gitlab_comment")).toBe(false);
    expect(titles.has("jira_comment")).toBe(false);
  });

  it("gates on the DB fallback too (ref-less link + resourceLookup mapping)", async () => {
    // No link ref, but the webhooks conversation_map has a Slack mapping → attached.
    const ctx: ToolContext = {
      conversationId: "c1",
      links: async () => [],
      resourceLookup: async (source) =>
        source === "slack"
          ? { source: "slack", resourceType: "thread", resourceId: "C1:1700.9" }
          : undefined,
    };
    const titles = await registeredTools(ctx);
    expect(titles.has("slack_respond")).toBe(true);
    expect(titles.has("github_comment")).toBe(false);
  });
});

describe("agent-tools: get_slack_context", () => {
  it("returns the attached channel + thread_ts", async () => {
    const out = await handleGetSlackContext(
      { broker: fakeBroker({ status: 200, raw: "", data: undefined }) },
      ctxWith([slackLink({ channel: "C42", threadTs: "1712.3" })]),
    );
    const text = out.content.map((c) => c.text).join("\n");
    expect(out.isError).toBeFalsy();
    expect(text).toContain("C42");
    expect(text).toContain("1712.3");
  });
});

/**
 * Replying into an ALREADY-RESOLVED review thread.
 *
 * GitHub sends no webhook when a human resolves a thread, so a reply the agent was
 * asked for minutes ago can land on a closed conversation and read as noise.
 */
describe("github_comment — resolved review threads", () => {
  /** A broker that answers each call in order (GraphQL probe, then the POST). */
  function seqBroker(responses: BrokerResponse[]): BrokerClient & { calls: string[] } {
    const calls: string[] = [];
    let i = 0;
    return {
      calls,
      call: vi.fn(async (_c: string, _m: string, path: string) => {
        calls.push(path);
        return responses[Math.min(i++, responses.length - 1)];
      }),
    } as never;
  }

  const graphql = (threads: unknown) => ({
    status: 200,
    raw: "{}",
    // NOTE: BrokerResponse.data, not .body — an earlier cut read .body and so
    // silently answered "not resolved" for every thread, failing open always.
    data: { data: { repository: { pullRequest: { reviewThreads: { nodes: threads } } } } },
  });
  const thread = (id: number, isResolved: boolean) => ({
    isResolved,
    comments: { nodes: [{ databaseId: id }] },
  });

  it("THE FIX: does NOT post into a resolved thread", async () => {
    const broker = seqBroker([graphql([thread(555, true)])]);
    const res = await handleGithubComment({ broker } as never, ctxWith([githubLink()]), {
      body: "late reply",
      in_reply_to: 555,
    });
    expect(res.isError).toBe(true);
    expect(broker.calls.some((p) => p.includes("/replies"))).toBe(false);
  });

  it("posts normally into an OPEN thread", async () => {
    const broker = seqBroker([graphql([thread(555, false)]), { status: 201, raw: "{}", data: {} }]);
    const res = await handleGithubComment({ broker } as never, ctxWith([githubLink()]), {
      body: "on it",
      in_reply_to: 555,
    });
    expect(res.isError).toBeFalsy();
    expect(broker.calls.some((p) => p.includes("/replies"))).toBe(true);
  });

  it("FAILS OPEN: a non-2xx GraphQL response still posts the reply", async () => {
    // A missed reply is worse than a stale one — the human asked for it.
    const broker = seqBroker([{ status: 500, raw: "boom", data: undefined }, { status: 201, raw: "{}", data: {} }]);
    const res = await handleGithubComment({ broker } as never, ctxWith([githubLink()]), {
      body: "still posting",
      in_reply_to: 555,
    });
    expect(res.isError).toBeFalsy();
    expect(broker.calls.some((p) => p.includes("/replies"))).toBe(true);
  });

  it("FAILS OPEN: a THROWN broker error still posts the reply", async () => {
    // The 500 case above never reaches the catch (call resolves). This one does —
    // without it, flipping the catch to fail CLOSED passes every test.
    let n = 0;
    const calls: string[] = [];
    const broker = {
      call: vi.fn(async (_c: string, _m: string, path: string) => {
        calls.push(path);
        if (n++ === 0) throw new Error("network down");
        return { status: 201, raw: "{}", data: {} };
      }),
    };
    const res = await handleGithubComment({ broker } as never, ctxWith([githubLink()]), {
      body: "still posting",
      in_reply_to: 555,
    });
    expect(res.isError).toBeFalsy();
    expect(calls.some((p) => p.includes("/replies"))).toBe(true);
  });

  it("a PR-level comment skips the check entirely (no in_reply_to)", async () => {
    const broker = seqBroker([{ status: 201, raw: "{}", data: {} }]);
    await handleGithubComment({ broker } as never, ctxWith([githubLink()]), { body: "general note" });
    expect(broker.calls.some((p) => p.includes("graphql"))).toBe(false);
  });
});
