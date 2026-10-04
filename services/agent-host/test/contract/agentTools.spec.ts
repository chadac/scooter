/**
 * The WEB tools (web_search / web_fetch) and their SSRF guard.
 *
 * This file used to cover the provider reply tools too — the error-echo rule, target
 * inference from links, the conversation_map fallback, the attachment gate and the
 * UI-facing titles. #700 moved those tools into the contribs that own them, and the
 * tests moved with them:
 *
 *   error-echo + idempotent errors  -> each contrib's test_mcp_tools.py, via
 *                                      ToolResult.from_upstream
 *   target inference + ordering      -> lib/py/scooter-broker-lib/tests/test_refs_and_links.py
 *   the attachment gate              -> each contrib's gate tests
 *   tool names the UI keys on        -> each contrib's test, since the UI matches the
 *                                      tool NAME and the contribs now own those rows
 *
 * What stays here is what never touched a provider credential.
 */

import { describe, it, expect } from "vitest";

import { handleWebFetch, handleWebSearch, registerWebTools } from "../../src/agent/agentTools.js";

describe("agent-tools: web_fetch SSRF guard", () => {
  // The guard is the security-relevant half of web_fetch, and the reason it stays a
  // first-party tool rather than "just fetch a URL".
  it.each([
    "http://169.254.169.254/latest/meta-data/",              // cloud metadata
    "http://127.0.0.1:8080/",                                // loopback
    "http://10.0.0.5/",                                      // RFC1918
    "http://agent-broker.agent-sandbox.svc.cluster.local/",  // cluster-internal
  ])("refuses %s", async (url) => {
    const out = await handleWebFetch({}, { url });
    expect(out.isError).toBe(true);
  });
});

describe("agent-tools: the web tools need no provider credential", () => {
  // They hit DuckDuckGo / a URL directly, so they are registered UNCONDITIONALLY —
  // nothing about broker wiring or an attached provider gates them. That is also why
  // they are the only tools #700 left in this process; they move to per-provider
  // search contribs in phase 3.
  it("registerWebTools registers web_search + web_fetch with no deps at all", () => {
    const names = new Set<string>();
    const server = { registerTool: (name: string) => names.add(name) } as unknown as Parameters<
      typeof registerWebTools
    >[0];
    registerWebTools(server, {});
    expect(names.has("web_search")).toBe(true);
    expect(names.has("web_fetch")).toBe(true);
  });

  it("web_search reports a reachability failure rather than throwing", async () => {
    const out = await handleWebSearch({
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    }, { query: "anything" });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("offline");
  });
});
