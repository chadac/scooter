/**
 * Unit tests for the provider grouping that drives the two-level model picker.
 */

import { describe, it, expect } from "vitest";
import { groupModelsByProvider, providerLabel, UNTAGGED_GROUP } from "./modelGroups.js";

describe("groupModelsByProvider", () => {
  it("returns null when no model carries a provider tag (legacy flat catalog)", () => {
    expect(groupModelsByProvider(["a", "b"], undefined, "a")).toBeNull();
    expect(groupModelsByProvider(["a", "b"], { a: [], b: [] }, "a")).toBeNull();
  });

  it("groups each model under its provider, default provider first", () => {
    const groups = groupModelsByProvider(
      ["us.anthropic.claude-opus-4-8", "claude-sonnet-4-5"],
      { "us.anthropic.claude-opus-4-8": ["goose"], "claude-sonnet-4-5": ["byoc"] },
      "claude-sonnet-4-5",
    );
    expect(groups).not.toBeNull();
    // byoc holds the default -> it leads; byoc spells out, goose stays verbatim.
    expect(groups!.map((g) => g.provider)).toEqual(["byoc", "goose"]);
    expect(groups!.map((g) => g.label)).toEqual(["bring-your-own-claude", "goose"]);
    expect(groups!.find((g) => g.provider === "byoc")!.models).toEqual(["claude-sonnet-4-5"]);
  });

  it("preserves catalog order for providers (first appearance) and models", () => {
    const groups = groupModelsByProvider(
      ["opus", "sonnet", "haiku", "mini"],
      { opus: ["cc"], sonnet: ["cc"], haiku: ["byoc"], mini: ["byoc"] },
      null,
    );
    expect(groups!.map((g) => g.provider)).toEqual(["cc", "byoc"]);
    expect(groups!.find((g) => g.provider === "cc")!.models).toEqual(["opus", "sonnet"]);
    expect(groups!.find((g) => g.provider === "byoc")!.models).toEqual(["haiku", "mini"]);
  });

  it("lists a model offered by two providers under each group", () => {
    const groups = groupModelsByProvider(
      ["shared", "onlybyoc"],
      { shared: ["byoc", "cc"], onlybyoc: ["byoc"] },
      null,
    );
    const byoc = groups!.find((g) => g.provider === "byoc")!;
    const cc = groups!.find((g) => g.provider === "cc")!;
    expect(byoc.models).toContain("shared");
    expect(cc.models).toEqual(["shared"]);
  });

  it("buckets untagged models into an 'other' group, sorted last", () => {
    const groups = groupModelsByProvider(
      ["tagged", "loose"],
      { tagged: ["byoc"], loose: [] },
      "tagged",
    );
    expect(groups!.map((g) => g.provider)).toEqual(["byoc", UNTAGGED_GROUP]);
    expect(groups!.find((g) => g.provider === UNTAGGED_GROUP)!.models).toEqual(["loose"]);
  });
});

describe("providerLabel", () => {
  it("spells out byoc and passes other tags through verbatim", () => {
    expect(providerLabel("byoc")).toBe("bring-your-own-claude");
    expect(providerLabel("goose")).toBe("goose");
    expect(providerLabel("claude-code")).toBe("claude-code");
  });
});
