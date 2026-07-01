/**
 * Tier 1 contract test — the modify_environment MCP tool handler.
 *
 * The agent (goose) calls modify_environment(module_nix) over MCP; the handler
 * routes it to moduleManager.apply(conversationId, module) and maps the result
 * back to an MCP tool response. The conversationId is bound per MCP server
 * instance (one server per conversation's newSession). We test the HANDLER logic
 * directly (not the HTTP transport): success -> ok text; failure -> the build
 * error surfaced to the agent (isError) so it can fix its module.
 */

import { describe, it, expect } from "vitest";

import { handleModifyEnvironment } from "../../src/agent/mcpServer.js";
import type { ModuleManager } from "../../src/session/moduleManager.js";

function fakeManager(result: { ok: boolean; error?: string }): {
  mgr: ModuleManager;
  calls: Array<{ id: string; module: string }>;
} {
  const calls: Array<{ id: string; module: string }> = [];
  const mgr: ModuleManager = {
    async apply(id, module) {
      calls.push({ id, module });
      return result;
    },
    isApplying() {
      return false;
    },
  };
  return { mgr, calls };
}

const MODULE = `{ ... }: { environment.systemPackages = [ ]; }`;

describe("modify_environment MCP tool handler", () => {
  it("routes to moduleManager.apply with the conversation id + returns success", async () => {
    const { mgr, calls } = fakeManager({ ok: true });
    const res = await handleModifyEnvironment(mgr, "conv1", { module_nix: MODULE });

    expect(calls).toEqual([{ id: "conv1", module: MODULE }]);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text.toLowerCase()).toContain("applied");
  });

  it("surfaces the build/switch error to the agent on failure (isError)", async () => {
    const { mgr } = fakeManager({ ok: false, error: "error: undefined variable 'foo'" });
    const res = await handleModifyEnvironment(mgr, "conv1", { module_nix: MODULE });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("undefined variable 'foo'");
  });

  it("rejects an empty module without calling apply", async () => {
    const { mgr, calls } = fakeManager({ ok: true });
    const res = await handleModifyEnvironment(mgr, "conv1", { module_nix: "   " });

    expect(res.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});
