/** Tier 1 — email normalization for identity matching (case + trim + +tag, no dots). */

import { describe, it, expect } from "vitest";

import { normalizeEmail } from "../../src/auth/email.js";

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Alice@Example.COM ")).toBe("alice@example.com");
    expect(normalizeEmail("BOB@corp.com")).toBe("bob@corp.com");
  });

  it("drops a +tag sub-address in the local part", () => {
    expect(normalizeEmail("alice+work@example.com")).toBe("alice@example.com");
    expect(normalizeEmail("Alice+Work+more@Example.com")).toBe("alice@example.com");
  });

  it("maps every cosmetic variant of one mailbox to the SAME value", () => {
    const canonical = "alice@example.com";
    for (const v of ["alice@example.com", "Alice@Example.com", "ALICE@EXAMPLE.COM", "  alice+newsletter@example.com  ", "alice+a@Example.com"]) {
      expect(normalizeEmail(v)).toBe(canonical);
    }
  });

  it("does NOT strip dots (a.b@ and ab@ are different people at most providers)", () => {
    expect(normalizeEmail("a.b@example.com")).toBe("a.b@example.com");
    expect(normalizeEmail("alice.smith@corp.com")).not.toBe("alicesmith@corp.com");
  });

  it("preserves the domain (+tag only affects the local part)", () => {
    expect(normalizeEmail("alice+tag@sub.example.co.uk")).toBe("alice@sub.example.co.uk");
  });

  it("returns '' for blank / falsy input", () => {
    expect(normalizeEmail("")).toBe("");
    expect(normalizeEmail("   ")).toBe("");
    expect(normalizeEmail(null)).toBe("");
    expect(normalizeEmail(undefined)).toBe("");
  });

  it("only lowercases+trims a non-address (no single @)", () => {
    expect(normalizeEmail("not-an-email")).toBe("not-an-email");
    expect(normalizeEmail("  Weird  ")).toBe("weird");
  });

  it("keeps the original local part when the local is ONLY a tag (+tag@x)", () => {
    // No base local — don't collapse to "@domain" (would collide across addresses).
    expect(normalizeEmail("+tag@example.com")).toBe("+tag@example.com");
  });

  it("uses the LAST @ to split (a stray @ in the local part doesn't misparse)", () => {
    expect(normalizeEmail("a+b@weird@example.com")).toBe("a@example.com");
  });
});
