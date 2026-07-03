/**
 * Tier 1 — SCOOTER_ENV parsing (deployment sandbox env vars).
 *
 * Regression for a multi-line NIX_CONFIG reaching the sandbox as a single line
 * with LITERAL `\n`: the old `k=v;k=v` channel split on `;` and trim()'d each
 * chunk, which dropped newlines. The JSON channel round-trips every value —
 * newlines, `;`, `=`, whitespace — exactly.
 */

import { describe, it, expect } from "vitest";

import { parseScooterEnv } from "../../src/config/scooterEnv.js";

describe("parseScooterEnv — JSON channel (current)", () => {
  it("preserves a multi-line value (NIX_CONFIG) EXACTLY — real newlines, not literal \\n", () => {
    const nixConfig = "extra-substituters = http://cache/itops\nextra-trusted-public-keys = itops:abc=\nflake-registry = /etc/nix/registry.json";
    const raw = JSON.stringify({ NIX_CONFIG: nixConfig, NIXPKGS_ALLOW_UNFREE: "1" });
    const out = parseScooterEnv(raw);
    const nc = out.find((e) => e.name === "NIX_CONFIG");
    expect(nc?.value).toBe(nixConfig); // byte-for-byte, incl. the real \n chars
    expect(nc?.value).toContain("\n"); // a REAL newline
    expect(nc?.value).not.toContain("\\n"); // NOT a literal backslash-n
    // The `=` inside the trusted-key value survived (would break k=v;k=v).
    expect(nc?.value).toContain("itops:abc=");
    expect(out.find((e) => e.name === "NIXPKGS_ALLOW_UNFREE")?.value).toBe("1");
  });

  it("preserves a value containing ';' (fatal to the legacy delimiter)", () => {
    const out = parseScooterEnv(JSON.stringify({ PATHY: "/a;/b;/c" }));
    expect(out).toEqual([{ name: "PATHY", value: "/a;/b;/c" }]);
  });

  it("coerces non-string values to strings", () => {
    const out = parseScooterEnv(JSON.stringify({ N: 5, B: true }));
    expect(out).toEqual([
      { name: "N", value: "5" },
      { name: "B", value: "true" },
    ]);
  });

  it("returns [] for empty / whitespace / undefined", () => {
    expect(parseScooterEnv(undefined)).toEqual([]);
    expect(parseScooterEnv("")).toEqual([]);
    expect(parseScooterEnv("   ")).toEqual([]);
    expect(parseScooterEnv("{}")).toEqual([]);
  });

  it("returns [] (does not throw) on malformed JSON or a non-object", () => {
    expect(parseScooterEnv("{not json")).toEqual([]);
    expect(parseScooterEnv("[1,2,3]")).toEqual([]);
    expect(parseScooterEnv('"a string"')).toEqual([]);
  });
});

describe("parseScooterEnv — legacy k=v;k=v channel (back-compat)", () => {
  it("parses a single-line legacy value", () => {
    expect(parseScooterEnv("FOO=bar;BAZ=qux")).toEqual([
      { name: "FOO", value: "bar" },
      { name: "BAZ", value: "qux" },
    ]);
  });

  it("keeps everything after the FIRST '=' (a value may contain '=')", () => {
    expect(parseScooterEnv("URL=http://x/?a=b")).toEqual([{ name: "URL", value: "http://x/?a=b" }]);
  });

  it("skips empty chunks", () => {
    expect(parseScooterEnv("A=1;;B=2;")).toEqual([
      { name: "A", value: "1" },
      { name: "B", value: "2" },
    ]);
  });
});
