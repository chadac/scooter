/**
 * Tier 1 — the tunnel COMPOSITION, not its parts.
 *
 * Every piece of MCP-over-the-wire is unit-tested against its own fake: target resolution, the
 * stream service, the container proxy, the relay. That is exactly the shape that shipped the
 * id-correlation hang (#304) and the release() drift (#307) — each side correct, the JOINT
 * untested. These assert the wiring that only exists when the pieces are assembled.
 */

import { describe, it, expect } from "vitest";

import { createRemotePersonalizedProvider } from "../../src/acp/remoteAgentRegistry.js";
import type { ExecBackend } from "../../src/types.js";

const exec = {} as ExecBackend;

describe("BYO provider tunnel wiring", () => {
  it("OFFERS scooter-env by name when an MCP endpoint exists", () => {
    // The container cannot reach the agent-host's loopback URL; it must receive a NAME to
    // proxy. Offering the raw URL is the bug this whole feature exists to fix.
    const p = createRemotePersonalizedProvider({
      controllerUrl: "http://c:8080",
      exec,
      mcpUrlFor: (conv) => `http://127.0.0.1:8080/mcp?conv=${conv}`,
    });
    const offered = p.mcpServersFor?.("conv-a") ?? [];
    expect(offered.map((s) => s.name)).toEqual(["scooter-env"]);
    expect(offered[0].url, "the OFFER must not leak the agent-host's loopback URL")
      .not.toContain("127.0.0.1:8080");
  });

  it("offers NOTHING when no MCP endpoint is configured", () => {
    // Better than offering a server whose every call dead-ends.
    const p = createRemotePersonalizedProvider({ controllerUrl: "http://c:8080", exec });
    expect(p.mcpServersFor?.("conv-a") ?? []).toEqual([]);
  });

  it("tags itself byoc so the model catalog resolves the right namespace", () => {
    const p = createRemotePersonalizedProvider({ controllerUrl: "http://c:8080", exec });
    expect(p.modelTag).toBe("byoc");
  });
});
