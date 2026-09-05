/**
 * Tier 1 contract test — per-conversation model resolution.
 *
 * resolveModel picks the conversation's model: an explicit request iff it's an
 * offered model (or the default), else the host default. Guards against
 * arbitrary model strings reaching the agent launch env.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { resolveModel } from "../../src/index.js";

const cfg = { model: "opus", availableModels: ["opus", "sonnet"] };

describe("resolveModel", () => {
  it("returns the default when nothing is requested", () => {
    expect(resolveModel(undefined, cfg)).toBe("opus");
  });

  it("honors a requested model that is offered", () => {
    expect(resolveModel("sonnet", cfg)).toBe("sonnet");
  });

  it("honors the default even if it isn't in availableModels", () => {
    expect(resolveModel("opus", { model: "opus", availableModels: [] })).toBe("opus");
  });

  it("falls back to the default for an unknown model", () => {
    expect(resolveModel("haiku", cfg)).toBe("opus");
  });

  it("returns undefined when there is no default and no valid request", () => {
    expect(resolveModel("haiku", { model: undefined, availableModels: [] })).toBeUndefined();
  });

  it("logs a warning when falling back from an unavailable model", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    
    const result = resolveModel("haiku", cfg);
    
    expect(result).toBe("opus");
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("conversation requested unavailable model")
    );
    
    spy.mockRestore();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
