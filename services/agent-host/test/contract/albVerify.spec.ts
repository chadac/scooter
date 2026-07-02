/**
 * Tier 1 — optional ALB OIDC JWT signature verification.
 *
 * Generates a real EC P-256 keypair, signs an ES256 JWT (JOSE raw R||S), and
 * proves verifyAlbJwt accepts a good signature / rejects a tampered one / a wrong
 * key / a missing kid. Then the withAlbVerification wrapper: a verified token
 * keeps its claims; an unverified one keeps the id but DROPS email/name.
 */

import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { AsyncIdentityResolver } from "../../src/auth/identity.js";
import { verifyAlbJwt, withAlbVerification } from "../../src/auth/albVerify.js";

const b64url = (buf: Buffer | string) =>
  Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** Make an ES256 JWT signed by `privateKey` with header.kid = kid. */
function makeJwt(kid: string, claims: Record<string, unknown>, privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]): string {
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "ES256", kid }));
  const payload = b64url(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  // JOSE ES256 signature = raw R||S (ieee-p1363), 64 bytes.
  const sig = cryptoSign("sha256", Buffer.from(signingInput), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${b64url(sig)}`;
}

const kp = () => generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = (k: ReturnType<typeof kp>["publicKey"]) => k.export({ type: "spki", format: "pem" }).toString();

const req = (headers: Record<string, string>) => ({ headers } as unknown as IncomingMessage);

describe("verifyAlbJwt", () => {
  it("accepts a validly-signed token", async () => {
    const { privateKey, publicKey } = kp();
    const jwt = makeJwt("k1", { sub: "s", email: "a@x.io" }, privateKey);
    expect(await verifyAlbJwt(jwt, async () => pem(publicKey))).toBe(true);
  });

  it("rejects a tampered payload", async () => {
    const { privateKey, publicKey } = kp();
    const jwt = makeJwt("k1", { email: "a@x.io" }, privateKey);
    const [h, , s] = jwt.split(".");
    const forged = `${h}.${b64url(JSON.stringify({ email: "attacker@x.io" }))}.${s}`;
    expect(await verifyAlbJwt(forged, async () => pem(publicKey))).toBe(false);
  });

  it("rejects a signature made with a DIFFERENT key", async () => {
    const signer = kp();
    const other = kp();
    const jwt = makeJwt("k1", { email: "a@x.io" }, signer.privateKey);
    expect(await verifyAlbJwt(jwt, async () => pem(other.publicKey))).toBe(false);
  });

  it("rejects when the key can't be fetched / no kid / malformed", async () => {
    const { privateKey } = kp();
    const jwt = makeJwt("k1", {}, privateKey);
    expect(await verifyAlbJwt(jwt, async () => undefined)).toBe(false); // key missing
    expect(await verifyAlbJwt("not.a.jwt", async () => "x")).toBe(false);
    expect(await verifyAlbJwt("a.b", async () => "x")).toBe(false); // not 3 parts
  });
});

describe("withAlbVerification", () => {
  const albResolver = (user: { id: string; email?: string; name?: string; anonymous: boolean }): AsyncIdentityResolver => ({
    resolve: () => user,
  });

  it("keeps the claims when the JWT verifies", async () => {
    const { privateKey, publicKey } = kp();
    const jwt = makeJwt("k1", { email: "a@x.io" }, privateKey);
    const wrapped = withAlbVerification(albResolver({ id: "sub-1", email: "a@x.io", name: "Al", anonymous: false }), {
      region: "us-east-1",
      fetchKey: async () => pem(publicKey),
    });
    const u = await wrapped.resolve(req({ "x-amzn-oidc-data": jwt }));
    expect(u).toMatchObject({ id: "sub-1", email: "a@x.io", name: "Al" });
  });

  it("DROPS the claims (keeps the id) when the JWT does NOT verify", async () => {
    const signer = kp();
    const other = kp();
    const jwt = makeJwt("k1", { email: "a@x.io" }, signer.privateKey);
    const wrapped = withAlbVerification(albResolver({ id: "sub-1", email: "a@x.io", name: "Al", anonymous: false }), {
      region: "us-east-1",
      fetchKey: async () => pem(other.publicKey), // wrong key -> verify fails
    });
    const u = await wrapped.resolve(req({ "x-amzn-oidc-data": jwt }));
    expect(u.id).toBe("sub-1");
    expect(u.email).toBeUndefined();
    expect(u.name).toBeUndefined();
  });

  it("passes through when there's no data header to verify (e.g. header-mode)", async () => {
    const wrapped = withAlbVerification(albResolver({ id: "alice", email: "alice@x.io", anonymous: false }), {
      region: "us-east-1",
      fetchKey: async () => "unused",
    });
    const u = await wrapped.resolve(req({}));
    expect(u).toMatchObject({ id: "alice", email: "alice@x.io" });
  });

  it("passes anonymous through untouched", async () => {
    const wrapped = withAlbVerification(albResolver({ id: "anonymous", anonymous: true }), {
      region: "us-east-1",
      fetchKey: async () => "unused",
    });
    expect((await wrapped.resolve(req({}))).anonymous).toBe(true);
  });
});
