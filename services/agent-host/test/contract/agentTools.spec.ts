/**
 * `web_fetch` and its SSRF guard — the last agent tool the agent-host serves itself.
 *
 * This file used to cover the provider reply tools (the error-echo rule, target
 * inference from links, the conversation_map fallback, the attachment gate, the
 * UI-facing titles) and `web_search`. #700 moved every one of them into the contrib
 * that owns the credential, and the tests went with the code:
 *
 *   error-echo + idempotent errors  -> each contrib's test_mcp_tools.py, via
 *                                      ToolResult.from_upstream
 *   target inference + ordering      -> lib/py/scooter-broker-lib/tests/test_refs_and_links.py
 *   the attachment gate              -> each contrib's gate tests
 *   tool names the UI keys on        -> each contrib's test, since the UI matches the
 *                                      tool NAME and the contribs now own those rows
 *   web_search's three outcomes      -> lib/py/scooter-broker-lib/tests/test_search.py
 *                                      plus contrib/{brave,kagi}/tests
 *
 * What stays is the one tool that needs no credential — and whose guard is the real
 * reason it is a tool rather than "just fetch a URL".
 */

import { describe, it, expect } from "vitest";

import { handleWebFetch, registerWebFetch } from "../../src/agent/agentTools.js";

describe("agent-tools: web_fetch SSRF guard", () => {
  // The security-relevant half, and why porting this tool to a Python contrib would be
  // a risk rather than a move: it would mean rewriting the DNS resolution and the
  // blocked-range arithmetic these cases cover.
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

describe("agent-tools: web_fetch needs no credential and no broker", () => {
  it("registers with no deps at all", () => {
    const names = new Set<string>();
    const server = { registerTool: (name: string) => names.add(name) } as unknown as Parameters<
      typeof registerWebFetch
    >[0];
    registerWebFetch(server, {});
    expect(names.has("web_fetch")).toBe(true);
  });

  it("registers web_fetch ALONE — web_search belongs to a search contrib now", () => {
    // The assertion is the absence: while `web_search` rode along here, a keyless
    // search backend looked like platform furniture instead of an integration, and
    // every deployment got a tool that answered real queries with an empty web
    // (PR #698). It now arrives over the broker's /mcp iff contrib/brave or
    // contrib/kagi is configured.
    const names = new Set<string>();
    const server = { registerTool: (name: string) => names.add(name) } as unknown as Parameters<
      typeof registerWebFetch
    >[0];
    registerWebFetch(server, {});
    expect([...names]).toEqual(["web_fetch"]);
  });

  it("reports a reachability failure rather than throwing", async () => {
    // An IP LITERAL in TEST-NET-3 (RFC 5737, reserved for documentation): the guard
    // skips DNS for a literal, so the test exercises the fetch path without depending
    // on a resolver — a hostname here fails at "could not resolve" instead, which is
    // a different branch.
    const out = await handleWebFetch({
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    }, { url: "http://203.0.113.10/page" });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("offline");
  });
});
