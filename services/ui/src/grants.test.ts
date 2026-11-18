import { describe, expect, it } from "vitest";

import { formatPreset, formatSpan, grantStatusLine, splitGrants, type Grant } from "./grants.js";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const g = (over: Partial<Grant>): Grant => ({
  contrib: "k8s", id: "g", title: "t", scope: [], status: "active", granted_by: "alice",
  granted_at: NOW - 60 * MIN, expires_at: NOW + 30 * MIN, verbs: [], ...over,
});

describe("splitGrants", () => {
  it("orders active by soonest end with until-revoked last, inactive newest first", () => {
    const { active, inactive } = splitGrants([
      g({ id: "pinned", expires_at: null }),
      g({ id: "late", expires_at: NOW + 90 * MIN }),
      g({ id: "soon", expires_at: NOW + 5 * MIN }),
      g({ id: "old", status: "expired", expires_at: NOW - 90 * MIN }),
      g({ id: "revoked", status: "revoked", ended_at: NOW - 10 * MIN }),
      // Past its end before the next poll.
      g({ id: "lapsed", expires_at: NOW - MIN }),
    ], NOW);
    expect(active.map((x) => x.id)).toEqual(["soon", "late", "pinned"]);
    expect(inactive.map((x) => x.id)).toEqual(["lapsed", "revoked", "old"]);
  });
});

describe("formatting", () => {
  it("spans and presets", () => {
    expect(formatSpan(42 * MIN)).toBe("42m");
    expect(formatSpan(185 * MIN)).toBe("3h 5m");
    expect(formatSpan(24 * 60 * MIN)).toBe("1d");
    expect(formatSpan(10)).toBe("1m");
    expect(formatPreset(480)).toBe("+8h");
    expect(formatPreset(60, "")).toBe("1h");
  });

  it("status lines", () => {
    expect(grantStatusLine(g({}), NOW)).toBe("Expires in 30m");
    expect(grantStatusLine(g({ expires_at: null }), NOW)).toBe("Indefinite");
    expect(grantStatusLine(g({ status: "expired", expires_at: NOW - 120 * MIN }), NOW)).toBe("Expired 2h ago");
    expect(grantStatusLine(g({ status: "revoked", ended_by: "bob", ended_at: NOW - 5 * MIN }), NOW)).toBe(
      "Revoked by bob 5m ago",
    );
  });
});
