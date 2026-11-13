/**
 * goose's context window is deployer-declarable: a per-model contextLimit in the catalog
 * reaches goose as GOOSE_CONTEXT_LIMIT for the conversation's resolved model, a pod-level
 * GOOSE_CONTEXT_LIMIT is forwarded and wins, and AGENT_ENV_PASSTHROUGH extends the
 * allowlist of env vars forwarded to goose.
 */
import { describe, it, expect } from "vitest";

import { catalogFromEnv, contextLimitOf } from "../../src/agent/models.js";
import { bedrockEnv, floorTagOf, gooseLaunchEnv, resolveFloorModel } from "../../src/index.js";

const catalog = catalogFromEnv({
  AGENT_MODELS_JSON: JSON.stringify([
    { id: "opus-5-5", contextLimit: 1_000_000, default: true },
    { id: "haiku", contextLimit: 200_000 },
    { id: "sonnet" },
  ]),
} as NodeJS.ProcessEnv);

describe("catalog contextLimit", () => {
  it("parses a positive integer contextLimit per model", () => {
    expect(contextLimitOf(catalog, "opus-5-5")).toBe(1_000_000);
    expect(contextLimitOf(catalog, "haiku")).toBe(200_000);
    expect(contextLimitOf(catalog, "sonnet")).toBeUndefined();
    expect(contextLimitOf(catalog, "unknown")).toBeUndefined();
    expect(contextLimitOf(catalog, undefined)).toBeUndefined();
  });

  it.each([0, -1, 1.5, "1000000", null, Number.POSITIVE_INFINITY])("drops an invalid contextLimit (%s)", (v) => {
    const c = catalogFromEnv({
      AGENT_MODELS_JSON: JSON.stringify([{ id: "m", contextLimit: v }]),
    } as NodeJS.ProcessEnv);
    expect(c.models[0]).not.toHaveProperty("contextLimit");
  });
});

describe("gooseLaunchEnv", () => {
  const base = { GOOSE_PROVIDER: "aws_bedrock", GOOSE_MODEL: "opus-5-5" };

  it("sets GOOSE_MODEL and the resolved model's GOOSE_CONTEXT_LIMIT", () => {
    expect(gooseLaunchEnv(base, catalog, "haiku")).toEqual({
      GOOSE_PROVIDER: "aws_bedrock",
      GOOSE_MODEL: "haiku",
      GOOSE_CONTEXT_LIMIT: "200000",
    });
    expect(gooseLaunchEnv(base, catalog, "opus-5-5").GOOSE_CONTEXT_LIMIT).toBe("1000000");
  });

  it("leaves GOOSE_CONTEXT_LIMIT unset for a model without one (goose's table decides)", () => {
    expect(gooseLaunchEnv(base, catalog, "sonnet")).not.toHaveProperty("GOOSE_CONTEXT_LIMIT");
  });

  it("lets an explicit pod-level GOOSE_CONTEXT_LIMIT win over the per-model value", () => {
    const env = gooseLaunchEnv({ ...base, GOOSE_CONTEXT_LIMIT: "500000" }, catalog, "haiku");
    expect(env.GOOSE_CONTEXT_LIMIT).toBe("500000");
  });
});

describe("bedrockEnv", () => {
  it("forwards GOOSE_CONTEXT_LIMIT", () => {
    const env = bedrockEnv({ GOOSE_CONTEXT_LIMIT: "1000000" } as NodeJS.ProcessEnv);
    expect(env.GOOSE_CONTEXT_LIMIT).toBe("1000000");
  });

  it("forwards only allowlisted vars by default", () => {
    const env = bedrockEnv({ AWS_REGION: "us-east-1", GOOSE_MAX_TURNS: "50" } as NodeJS.ProcessEnv);
    expect(env).toEqual({ AWS_REGION: "us-east-1", GOOSE_AUTO_COMPACT_THRESHOLD: "0.8" });
  });

  // GitHub Copilot through goose: the seat's token (and the GHES host) reach goose, but no
  // other GITHUB_* var does, so a forge credential on the pod never leaks into a launch.
  it("forwards the Copilot credential and host, and nothing else GitHub-shaped", () => {
    const env = bedrockEnv({
      GOOSE_PROVIDER: "github_copilot",
      GITHUB_COPILOT_TOKEN: "gho_seat",
      GITHUB_COPILOT_HOST: "https://github.example.com",
      GITHUB_TOKEN: "ghp_forge",
      GH_TOKEN: "ghp_forge",
    } as NodeJS.ProcessEnv);
    expect(env).toEqual({
      GOOSE_PROVIDER: "github_copilot",
      GITHUB_COPILOT_TOKEN: "gho_seat",
      GITHUB_COPILOT_HOST: "https://github.example.com",
      GOOSE_AUTO_COMPACT_THRESHOLD: "0.8",
    });
  });

  it("forwards the extra names listed in AGENT_ENV_PASSTHROUGH, when set", () => {
    const env = bedrockEnv({
      AGENT_ENV_PASSTHROUGH: "GOOSE_MAX_TURNS, GOOSE_TOOLSHIM\nUNSET_VAR",
      GOOSE_MAX_TURNS: "50",
      GOOSE_TOOLSHIM: "1",
      SECRET: "nope",
    } as NodeJS.ProcessEnv);
    expect(env).toEqual({
      GOOSE_MAX_TURNS: "50",
      GOOSE_TOOLSHIM: "1",
      GOOSE_AUTO_COMPACT_THRESHOLD: "0.8",
    });
  });
});

// The floor provider only launches with a model it serves. Why: issue #897, goose given a BYOC-only id.
describe("resolveFloorModel", () => {
  const cat = catalogFromEnv({
    AGENT_MODELS_JSON: JSON.stringify([
      { id: "us.anthropic.claude-opus-4-8", providers: ["goose"], defaultFor: ["goose"] },
      { id: "us.anthropic.claude-sonnet-4-6", providers: ["goose", "claude-code"] },
      { id: "claude-opus-5", providers: ["byoc"], defaultFor: ["byoc"] },
      { id: "claude-opus-5-5", providers: ["byoc"] },
    ]),
  } as NodeJS.ProcessEnv);
  const cfg = { model: cat.defaultId, availableModels: cat.models.map((m) => m.id), modelCatalog: cat };

  it("substitutes the goose default for a BYOC-only model", () => {
    expect(resolveFloorModel("claude-opus-5-5", cfg, "goose")).toBe("us.anthropic.claude-opus-4-8");
  });

  it("keeps a model goose serves", () => {
    expect(resolveFloorModel("us.anthropic.claude-sonnet-4-6", cfg, "goose")).toBe("us.anthropic.claude-sonnet-4-6");
  });

  it("falls back to the provider default with no pick", () => {
    expect(resolveFloorModel(undefined, cfg, "goose")).toBe("us.anthropic.claude-opus-4-8");
  });

  it("with an empty catalog behaves like resolveModel", () => {
    const legacy = { model: "m1", availableModels: ["m1", "m2"], modelCatalog: { models: [], defaultId: undefined } as never };
    expect(resolveFloorModel("m2", legacy, "goose")).toBe("m2");
    expect(resolveFloorModel("nope", legacy, "goose")).toBe("m1");
  });

  // The fake e2e stack's shape: no goose group, so the guard has nothing to go on and keeps the pick.
  it("keeps the pick when the catalog has no group for the floor provider", () => {
    const noGoose = catalogFromEnv({
      AGENT_MODELS_JSON: JSON.stringify([
        { id: "model-default", providers: ["byoc", "claude-code"], defaultFor: ["byoc", "claude-code"] },
        { id: "model-smart", providers: ["byoc"] },
      ]),
    } as NodeJS.ProcessEnv);
    const c = { model: noGoose.defaultId, availableModels: noGoose.models.map((m) => m.id), modelCatalog: noGoose };
    expect(resolveFloorModel("model-smart", c, "goose")).toBe("model-smart");
    expect(resolveFloorModel("nope", c, "goose")).toBe(c.model);
  });
});

// GitHub Copilot through goose is its own model namespace: Copilot's dotted ids live under
// the "copilot" tag, so a Bedrock id never reaches a Copilot launch and vice versa.
describe("floorTagOf + the copilot namespace", () => {
  const cat = catalogFromEnv({
    AGENT_MODELS_JSON: JSON.stringify([
      { id: "us.anthropic.claude-opus-4-8", providers: ["goose"], defaultFor: ["goose"] },
      { id: "gpt-5.4", providers: ["copilot"], defaultFor: ["copilot"], contextLimit: 1_050_000 },
      { id: "claude-sonnet-4.6", providers: ["copilot"], contextLimit: 200_000 },
    ]),
  } as NodeJS.ProcessEnv);
  const cfg = { model: cat.defaultId, availableModels: cat.models.map((m) => m.id), modelCatalog: cat };

  it("tags the floor by GOOSE_PROVIDER", () => {
    expect(floorTagOf({}, { GOOSE_PROVIDER: "github_copilot" } as NodeJS.ProcessEnv)).toBe("copilot");
    expect(floorTagOf({}, { GOOSE_PROVIDER: "claude-code" } as NodeJS.ProcessEnv)).toBe("claude-code");
    expect(floorTagOf({}, { GOOSE_PROVIDER: "aws_bedrock" } as NodeJS.ProcessEnv)).toBe("goose");
    expect(floorTagOf({}, { GOOSE_PROVIDER: "anthropic" } as NodeJS.ProcessEnv)).toBe("goose");
    expect(floorTagOf({}, {} as NodeJS.ProcessEnv)).toBe("goose");
    // The fake sandbox runs the goose path whatever the provider says.
    expect(floorTagOf({ fakeSandbox: true }, { GOOSE_PROVIDER: "github_copilot" } as NodeJS.ProcessEnv)).toBe("goose");
  });

  it("a Copilot launch never gets a Bedrock id, nor a Bedrock launch a Copilot id", () => {
    expect(resolveFloorModel("us.anthropic.claude-opus-4-8", cfg, "copilot")).toBe("gpt-5.4");
    expect(resolveFloorModel("claude-sonnet-4.6", cfg, "goose")).toBe("us.anthropic.claude-opus-4-8");
  });

  it("keeps a Copilot pick and launches goose with its declared context window", () => {
    expect(resolveFloorModel("claude-sonnet-4.6", cfg, "copilot")).toBe("claude-sonnet-4.6");
    const env = gooseLaunchEnv(
      bedrockEnv({ GOOSE_PROVIDER: "github_copilot", GITHUB_COPILOT_TOKEN: "gho_seat" } as NodeJS.ProcessEnv),
      cat,
      "claude-sonnet-4.6",
    );
    expect(env.GOOSE_MODEL).toBe("claude-sonnet-4.6");
    expect(env.GOOSE_CONTEXT_LIMIT).toBe("200000");
    expect(env.GITHUB_COPILOT_TOKEN).toBe("gho_seat");
  });
});
