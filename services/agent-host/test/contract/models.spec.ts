/**
 * Tier 1 contract — the model catalog (agent model-switch, stage 1).
 *
 * Pins: AGENT_MODELS_JSON (rich form w/ hints + default) parses; the legacy
 * GOOSE_MODEL + AGENT_AVAILABLE_MODELS still yields a catalog; exactly one default
 * is derived; resolveModel guards against unoffered models. See
 * docs/AGENT_MODEL_SWITCH.md.
 */

import { describe, it, expect } from "vitest";

import {
  catalogFromEnv,
  resolveModel,
  isOffered,
  availableIds,
} from "../../src/agent/models.js";

describe("model catalog", () => {
  it("parses AGENT_MODELS_JSON with hints + a default flag", () => {
    const cat = catalogFromEnv({
      AGENT_MODELS_JSON: JSON.stringify([
        { id: "sonnet", hint: "fast/cheap", default: true },
        { id: "opus", hint: "slow/powerful" },
      ]),
    } as NodeJS.ProcessEnv);
    expect(availableIds(cat)).toEqual(["sonnet", "opus"]);
    expect(cat.defaultId).toBe("sonnet");
    expect(cat.models.find((m) => m.id === "opus")!.hint).toBe("slow/powerful");
    expect(cat.models.find((m) => m.id === "opus")!.default).toBe(false);
  });

  it("derives a default when none is flagged (first model)", () => {
    const cat = catalogFromEnv({
      AGENT_MODELS_JSON: JSON.stringify([{ id: "a" }, { id: "b" }]),
    } as NodeJS.ProcessEnv);
    expect(cat.defaultId).toBe("a");
    expect(cat.models[0].default).toBe(true);
    expect(cat.models[1].default).toBe(false);
  });

  it("normalizes to exactly one default even if two are flagged", () => {
    const cat = catalogFromEnv({
      AGENT_MODELS_JSON: JSON.stringify([
        { id: "a", default: true },
        { id: "b", default: true },
      ]),
    } as NodeJS.ProcessEnv);
    expect(cat.models.filter((m) => m.default)).toHaveLength(1);
    expect(cat.defaultId).toBe("a"); // first flagged wins
  });

  it("falls back to the legacy GOOSE_MODEL + AGENT_AVAILABLE_MODELS (no hints)", () => {
    const cat = catalogFromEnv({
      GOOSE_MODEL: "opus",
      AGENT_AVAILABLE_MODELS: "opus, sonnet",
    } as NodeJS.ProcessEnv);
    expect(availableIds(cat)).toEqual(["opus", "sonnet"]);
    expect(cat.defaultId).toBe("opus");
    expect(cat.models.every((m) => m.hint === "")).toBe(true);
  });

  it("legacy: the default is included even if not in AGENT_AVAILABLE_MODELS", () => {
    const cat = catalogFromEnv({
      GOOSE_MODEL: "opus",
      AGENT_AVAILABLE_MODELS: "sonnet",
    } as NodeJS.ProcessEnv);
    expect(availableIds(cat)).toContain("opus");
    expect(cat.defaultId).toBe("opus");
  });

  it("empty env -> empty catalog, resolveModel undefined", () => {
    const cat = catalogFromEnv({} as NodeJS.ProcessEnv);
    expect(cat.models).toEqual([]);
    expect(resolveModel("anything", cat)).toBeUndefined();
  });

  it("malformed AGENT_MODELS_JSON falls back to legacy (never throws)", () => {
    const cat = catalogFromEnv({
      AGENT_MODELS_JSON: "not json",
      GOOSE_MODEL: "opus",
    } as NodeJS.ProcessEnv);
    expect(cat.defaultId).toBe("opus");
  });

  it("resolveModel returns the requested model only if offered, else the default", () => {
    const cat = catalogFromEnv({
      AGENT_MODELS_JSON: JSON.stringify([{ id: "sonnet", default: true }, { id: "opus" }]),
    } as NodeJS.ProcessEnv);
    expect(resolveModel("opus", cat)).toBe("opus");
    expect(resolveModel("gpt-4", cat)).toBe("sonnet"); // unoffered -> default
    expect(resolveModel(undefined, cat)).toBe("sonnet");
    expect(isOffered(cat, "opus")).toBe(true);
    expect(isOffered(cat, "gpt-4")).toBe(false);
  });
});
