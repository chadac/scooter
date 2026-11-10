/**
 * The tunnel composition rather than its parts: the wiring that only exists once target
 * resolution, the stream service and the provider are assembled.
 */

import { describe, it, expect } from "vitest";

import { createRemotePersonalizedProvider } from "../../src/acp/remoteAgentRegistry.js";
import type { ExecBackend } from "../../src/types.js";

const exec = {} as ExecBackend;

describe("BYO provider tunnel wiring", () => {
  it("OFFERS scooter-env by name when an MCP endpoint exists", () => {
    // The container cannot reach the agent-host's loopback URL, so it receives a name to proxy.
    const p = createRemotePersonalizedProvider({
      controllerUrl: "http://c:8080",
      exec,
      mcpUrlFor: (conv) => `http://127.0.0.1:8080/mcp?conv=${conv}`,
    });
    const offered = p.mcpServersFor?.("conv-a", []) ?? [];
    expect(offered.map((s) => s.name)).toEqual(["scooter-env"]);
    expect(offered[0].url, "the OFFER must not leak the agent-host's loopback URL")
      .not.toContain("127.0.0.1:8080");
  });

  it("offers NOTHING when no MCP endpoint is configured", () => {
    const p = createRemotePersonalizedProvider({ controllerUrl: "http://c:8080", exec });
    expect(p.mcpServersFor?.("conv-a", []) ?? []).toEqual([]);
  });

  it("tags itself byoc so the model catalog resolves the right namespace", () => {
    const p = createRemotePersonalizedProvider({ controllerUrl: "http://c:8080", exec });
    expect(p.modelTag).toBe("byoc");
  });
});
