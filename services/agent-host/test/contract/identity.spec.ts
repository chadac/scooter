/**
 * Tier 1 contract test — user identity from the trusted ingress header.
 */

import { describe, it, expect } from "vitest";
import type { IncomingMessage } from "node:http";

import {
  userFromRequest,
  identityConfigFromEnv,
  ANONYMOUS_USER,
  createAlbOidcResolver,
  decodeJwtClaims,
} from "../../src/auth/identity.js";

const DEFAULT = { userHeader: "x-auth-user", emailHeader: "x-auth-email" };

/** A fake request with the given (already-lowercased) headers. */
function req(headers: Record<string, string | string[]>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("user identity from header", () => {
  it("reads the user id from the configured header", () => {
    const u = userFromRequest(req({ "x-auth-user": "alice" }), DEFAULT);
    expect(u).toEqual({ id: "alice", email: undefined, anonymous: false });
  });

  it("also reads an email when present", () => {
    const u = userFromRequest(req({ "x-auth-user": "alice", "x-auth-email": "alice@x.io" }), DEFAULT);
    expect(u.id).toBe("alice");
    expect(u.email).toBe("alice@x.io");
    expect(u.anonymous).toBe(false);
  });

  it("no header -> the anonymous user", () => {
    const u = userFromRequest(req({}), DEFAULT);
    expect(u).toEqual({ id: ANONYMOUS_USER, anonymous: true });
  });

  it("blank/whitespace header -> anonymous (not an empty-string user)", () => {
    expect(userFromRequest(req({ "x-auth-user": "   " }), DEFAULT).anonymous).toBe(true);
    expect(userFromRequest(req({ "x-auth-user": "" }), DEFAULT).anonymous).toBe(true);
  });

  it("takes the first value when a header is duplicated", () => {
    const u = userFromRequest(req({ "x-auth-user": ["bob", "evil"] }), DEFAULT);
    expect(u.id).toBe("bob");
  });

  it("identityConfigFromEnv defaults + env override (lowercased)", () => {
    const prev = { u: process.env.AUTH_USER_HEADER, e: process.env.AUTH_EMAIL_HEADER };
    try {
      delete process.env.AUTH_USER_HEADER;
      delete process.env.AUTH_EMAIL_HEADER;
      expect(identityConfigFromEnv()).toEqual({ userHeader: "x-auth-user", emailHeader: "x-auth-email" });
      process.env.AUTH_USER_HEADER = "X-Forwarded-User";
      expect(identityConfigFromEnv().userHeader).toBe("x-forwarded-user"); // node lowercases header names
    } finally {
      if (prev.u === undefined) delete process.env.AUTH_USER_HEADER; else process.env.AUTH_USER_HEADER = prev.u;
      if (prev.e === undefined) delete process.env.AUTH_EMAIL_HEADER; else process.env.AUTH_EMAIL_HEADER = prev.e;
    }
  });
});

describe("ALB OIDC resolver", () => {
  // A JWT whose payload claims carry email + name (base64url, no signature check).
  function jwt(claims: Record<string, unknown>): string {
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    return `${b64({ alg: "ES256" })}.${b64(claims)}.sig`;
  }

  it("uses the sub from x-amzn-oidc-identity and email/name from the data JWT", () => {
    const r = createAlbOidcResolver({ identityHeader: "x-amzn-oidc-identity", dataHeader: "x-amzn-oidc-data" });
    const u = r.resolve(req({
      "x-amzn-oidc-identity": "cognito-sub-123",
      "x-amzn-oidc-data": jwt({ email: "alice@x.io", name: "Alice" }),
    }));
    expect(u).toMatchObject({ id: "cognito-sub-123", email: "alice@x.io", name: "Alice", anonymous: false });
  });

  it("yields the sub with NO email when the JWT lacks the claim (store can fill later)", () => {
    const r = createAlbOidcResolver({ identityHeader: "x-amzn-oidc-identity", dataHeader: "x-amzn-oidc-data" });
    const u = r.resolve(req({ "x-amzn-oidc-identity": "sub-x", "x-amzn-oidc-data": jwt({ foo: "bar" }) }));
    expect(u).toMatchObject({ id: "sub-x", email: undefined, anonymous: false });
  });

  it("is anonymous when the identity header is absent", () => {
    const r = createAlbOidcResolver({ identityHeader: "x-amzn-oidc-identity", dataHeader: "x-amzn-oidc-data" });
    expect(r.resolve(req({})).anonymous).toBe(true);
  });

  it("degrades to no-email on a malformed JWT (not a crash)", () => {
    const r = createAlbOidcResolver({ identityHeader: "x-amzn-oidc-identity", dataHeader: "x-amzn-oidc-data" });
    const u = r.resolve(req({ "x-amzn-oidc-identity": "sub-y", "x-amzn-oidc-data": "not-a-jwt" }));
    expect(u).toMatchObject({ id: "sub-y", email: undefined, anonymous: false });
  });

  it("decodeJwtClaims returns {} for garbage", () => {
    expect(decodeJwtClaims("garbage")).toEqual({});
    expect(decodeJwtClaims("a.b.c")).toEqual({});
  });
});
