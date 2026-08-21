/**
 * Tier 1 contract — the BYOC controller's HTTP surface (increment 5, cloud half).
 *
 * The routes, and who may call them (§L Q3). The split matters because ONE of these endpoints is
 * deliberately exposed UNAUTHENTICATED on the ingress:
 *
 *   POST /byoc/sessions              MINT — authed (the UI, with a user session)
 *   GET  /byoc/ws/:id                CONNECT — unauthenticated ingress, gated by the join token
 *   POST /byoc/:id/prompt            agent-host -> container, SSE response
 *   POST /byoc/:id/permission/:pid   agent-host -> container (unblocks a permission)
 *   POST /byoc/:id/exec/:xid         agent-host -> container (Channel B result)
 *   GET  /byoc/status?owner=…        the UI badge: minted / connected / disconnected
 *
 * The connect path accepts anything the ingress lets through, so its ONLY defence is the token's
 * signature, expiry, and audience. Everything asserted about rejection here is load-bearing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createSessionRegistry, type SessionRegistry, type SessionStore } from "../src/sessionRegistry.js";
import { createRunRelay, type RunRelay } from "../src/runRelay.js";
import { createServer, type ByocServer } from "../src/server.js";
import { mintJoinToken } from "../src/joinToken.js";
import { createDeviceAuth } from "../src/deviceAuth.js";
import { createMemoryDeviceStore } from "../src/sessionStore.js";
import { generateKeyPairSync, sign as cryptoSign, createHmac } from "node:crypto";

const SECRET = "test-secret";

/** Mint a token with an arbitrary audience, SIGNED correctly — so a rejection can only come from
 *  the audience check. (The previous version of this test tampered with the claims and left the
 *  signature stale, so it passed for the wrong reason and never exercised the guard.) */
function signWithAudience(owner: string, secret: string, aud: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({ owner, iat: now, exp: now + 600, nonce: "test-nonce", aud }),
  ).toString("base64url");
  const sig = createHmac("sha256", secret).update(`${header}.${claims}`).digest("base64url");
  return `${header}.${claims}.${sig}`;
}


function fakeStore(): SessionStore {
  const rows = new Map<string, { sessionId: string; status: "online" | "offline" }>();
  return {
    async put(owner, sessionId) { rows.set(owner, { sessionId, status: "offline" }); },
    async setStatus(owner, status) { const r = rows.get(owner); if (r) r.status = status; },
    async getByOwner(owner) { const r = rows.get(owner); return r ? { owner, ...r } : null; },
    async close() {},
  };
}

describe("BYOC controller HTTP surface", () => {
  let registry: SessionRegistry;
  let relay: RunRelay;
  let server: ByocServer;
  let devices: ReturnType<typeof createDeviceAuth>;

  beforeEach(() => {
    registry = createSessionRegistry({ store: fakeStore(), secret: SECRET });
    relay = createRunRelay({ registry });
    devices = createDeviceAuth({ store: createMemoryDeviceStore(), secret: SECRET });
    server = createServer({ registry, relay, secret: SECRET, devices });
  });
  afterEach(() => server.close());

  const req = (method: string, path: string, opts: { body?: unknown; owner?: string } = {}) =>
    server.handle({
      method,
      path,
      body: opts.body,
      // The authed surface passes the resolved user down; the unauthenticated connect path never does.
      user: opts.owner ? { id: opts.owner } : undefined,
    });

  it("POST /byoc/sessions mints a session for the AUTHENTICATED caller", async () => {
    const res = await req("POST", "/byoc/sessions", { owner: "alice" });
    expect(res.status).toBe(200);
    const body = res.json as { sessionId: string; token: string };
    expect(body.sessionId).toMatch(/\S/);
    expect(body.token.split(".")).toHaveLength(3);
  });

  it("POST /byoc/sessions REFUSES an anonymous caller (a session must be owner-bound)", async () => {
    // Without an owner there is nothing to bind the session to, and resolve-by-owner (the whole
    // point of §L) would have no key. Minting anonymously would also let anyone create sessions.
    const res = await req("POST", "/byoc/sessions");
    expect(res.status).toBe(401);
  });

  it("a minted session is resolvable by its owner, so any agent-host replica can find it", async () => {
    const mint = (await req("POST", "/byoc/sessions", { owner: "alice" })).json as { sessionId: string };
    const res = await req("GET", "/byoc/status?owner=alice");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ sessionId: mint.sessionId, status: "minted" });
  });

  it("GET /byoc/status reports DISCONNECTED for an owner with no session", async () => {
    const res = await req("GET", "/byoc/status?owner=nobody");
    expect(res.json).toMatchObject({ status: "disconnected" });
  });

  it("the WS upgrade ACCEPTS a valid token for that session", async () => {
    const mint = (await req("POST", "/byoc/sessions", { owner: "alice" })).json as { sessionId: string; token: string };
    const ok = server.authorizeUpgrade(mint.sessionId, mint.token);
    expect(ok.ok).toBe(true);
  });

  it("the WS upgrade REJECTS a token signed with another secret", async () => {
    const mint = (await req("POST", "/byoc/sessions", { owner: "alice" })).json as { sessionId: string };
    expect(server.authorizeUpgrade(mint.sessionId, mintJoinToken("alice", "wrong-secret")).ok).toBe(false);
  });

  it("the WS upgrade REJECTS a token for a DIFFERENT owner (the unauthenticated-ingress attack)", async () => {
    const mint = (await req("POST", "/byoc/sessions", { owner: "alice" })).json as { sessionId: string };
    // Anyone can reach /byoc/ws/:id — a valid token of one's OWN must not attach to someone
    // else's session, or an attacker receives that user's prompts.
    expect(server.authorizeUpgrade(mint.sessionId, mintJoinToken("mallory", SECRET)).ok).toBe(false);
  });

  it("the WS upgrade REJECTS an expired token", async () => {
    const mint = (await req("POST", "/byoc/sessions", { owner: "alice" })).json as { sessionId: string };
    expect(server.authorizeUpgrade(mint.sessionId, mintJoinToken("alice", SECRET, { ttlSeconds: -1 })).ok).toBe(false);
  });

  it("the WS upgrade ACCEPTS the agent-host's `remote-agent` audience (transitional)", async () => {
    // The agent-host still mints `aud: "remote-agent"` — it is the only mint endpoint a signed-in
    // user can reach while the webhooks bridge and this controller coexist. Rejecting it made
    // registration IMPOSSIBLE against the deployed controller:
    //   {"error":"join token rejected: wrong audience"}
    // Remove this once the agent-host mints `byoc` directly and the bridge is retired.
    const mint = (await req("POST", "/byoc/sessions", { owner: "alice" })).json as { sessionId: string };
    const legacy = signWithAudience("alice", SECRET, "remote-agent");
    expect(server.authorizeUpgrade(mint.sessionId, legacy).ok).toBe(true);
  });

  it("the WS upgrade REJECTS an UNRELATED audience — the replay guard still holds", async () => {
    // The guard is narrowed, not abandoned: a token minted for some other purpose must not be
    // replayable at /byoc/ws/:id, the one endpoint exposed unauthenticated (§L Q3).
    const mint = (await req("POST", "/byoc/sessions", { owner: "alice" })).json as { sessionId: string };
    const other = signWithAudience("alice", SECRET, "some-other-service");
    expect(server.authorizeUpgrade(mint.sessionId, other).ok).toBe(false);
  });

  it("POST /byoc/:id/prompt for an offline container is 503, not a hang", async () => {
    const mint = (await req("POST", "/byoc/sessions", { owner: "alice" })).json as { sessionId: string };
    const res = await req("POST", `/byoc/${mint.sessionId}/prompt`, { body: { ch: "acp", type: "prompt", payload: {} } });
    // The agent-host's transport turns a non-OK into a closed transport -> RUN_ERROR, so the user
    // is told their Claude is offline instead of watching a spinner.
    expect(res.status).toBe(503);
  });

  it("POST to an UNKNOWN session is 404", async () => {
    const res = await req("POST", "/byoc/does-not-exist/prompt", { body: {} });
    expect(res.status).toBe(404);
  });

  it("an unknown route is 404 (no accidental catch-all on an unauthenticated surface)", async () => {
    expect((await req("GET", "/byoc/../secrets")).status).toBe(404);
    expect((await req("POST", "/admin")).status).toBe(404);
  });

  // --- Device auth over HTTP (§P) ---------------------------------------------------------

  function laptop() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    return {
      pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      sign: (n: string) => cryptoSign(null, Buffer.from(n), privateKey).toString("base64"),
    };
  }

  it("POST /byoc/devices registers a laptop with a join token", async () => {
    const dev = laptop();
    const res = await req("POST", "/byoc/devices", {
      body: { joinToken: mintJoinToken("alice", SECRET), publicKey: dev.pem, label: "laptop" },
    });
    expect(res.status).toBe(200);
    expect((res.json as { deviceId: string }).deviceId).toMatch(/\S/);
  });

  it("POST /byoc/devices REJECTS a bad join token (this route is on the unauthenticated ingress)", async () => {
    const dev = laptop();
    const res = await req("POST", "/byoc/devices", {
      body: { joinToken: mintJoinToken("alice", "wrong"), publicKey: dev.pem },
    });
    expect(res.status).toBe(401);
  });

  it("GET /byoc/challenge issues a nonce a container can sign", async () => {
    const res = await req("GET", "/byoc/challenge");
    expect(res.status).toBe(200);
    expect((res.json as { nonce: string }).nonce).toMatch(/\S/);
  });

  it("a registered device authenticates with a signed nonce — no join token needed", async () => {
    const dev = laptop();
    const reg = await req("POST", "/byoc/devices", {
      body: { joinToken: mintJoinToken("alice", SECRET), publicKey: dev.pem },
    });
    const deviceId = (reg.json as { deviceId: string }).deviceId;
    const { nonce } = (await req("GET", "/byoc/challenge")).json as { nonce: string };
    const auth = await server.authorizeDevice(deviceId, nonce, dev.sign(nonce));
    expect(auth.ok).toBe(true);
    expect(auth.ok && auth.owner).toBe("alice");
  });

  it("GET /byoc/devices lists the AUTHENTICATED caller's devices only", async () => {
    const a = laptop(), b = laptop();
    await req("POST", "/byoc/devices", { body: { joinToken: mintJoinToken("alice", SECRET), publicKey: a.pem, label: "alice-laptop" } });
    await req("POST", "/byoc/devices", { body: { joinToken: mintJoinToken("bob", SECRET), publicKey: b.pem, label: "bob-laptop" } });
    const res = await req("GET", "/byoc/devices", { owner: "alice" });
    const list = res.json as Array<{ label: string }>;
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe("alice-laptop");
  });

  it("GET /byoc/devices REFUSES an anonymous caller (device lists are per-user)", async () => {
    expect((await req("GET", "/byoc/devices")).status).toBe(401);
  });

  it("DELETE /byoc/devices/:id deregisters — and the key stops working", async () => {
    const dev = laptop();
    const reg = await req("POST", "/byoc/devices", { body: { joinToken: mintJoinToken("alice", SECRET), publicKey: dev.pem } });
    const deviceId = (reg.json as { deviceId: string }).deviceId;
    expect((await req("DELETE", `/byoc/devices/${deviceId}`, { owner: "alice" })).status).toBe(204);
    const { nonce } = (await req("GET", "/byoc/challenge")).json as { nonce: string };
    expect((await server.authorizeDevice(deviceId, nonce, dev.sign(nonce))).ok).toBe(false);
  });

  it("DELETE /byoc/devices/:id REFUSES an ANONYMOUS caller (401, and the device survives)", async () => {
    // This route sits on the same server as the unauthenticated ingress paths. Without an identity
    // check, anyone who learns a device id could revoke a stranger's laptop — a trivial DoS.
    const dev = laptop();
    const reg = await req("POST", "/byoc/devices", { body: { joinToken: mintJoinToken("alice", SECRET), publicKey: dev.pem } });
    const deviceId = (reg.json as { deviceId: string }).deviceId;
    expect((await req("DELETE", `/byoc/devices/${deviceId}`)).status).toBe(401);
    const { nonce } = (await req("GET", "/byoc/challenge")).json as { nonce: string };
    expect((await server.authorizeDevice(deviceId, nonce, dev.sign(nonce))).ok).toBe(true);
  });

  it("GET /byoc/devices returns EMPTY for an owner with no devices (not someone else's)", async () => {
    // Guards against the list being scoped to anything other than the CALLER — a hardcoded or
    // mis-threaded owner would leak one user's device inventory to another.
    const a = laptop();
    await req("POST", "/byoc/devices", { body: { joinToken: mintJoinToken("alice", SECRET), publicKey: a.pem, label: "alice-laptop" } });
    const res = await req("GET", "/byoc/devices", { owner: "carol" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual([]);
  });

  it("DELETE /byoc/devices/:id REFUSES to remove ANOTHER owner's device", async () => {
    const dev = laptop();
    const reg = await req("POST", "/byoc/devices", { body: { joinToken: mintJoinToken("alice", SECRET), publicKey: dev.pem } });
    const deviceId = (reg.json as { deviceId: string }).deviceId;
    await req("DELETE", `/byoc/devices/${deviceId}`, { owner: "mallory" });
    // Still alice's, still working.
    const { nonce } = (await req("GET", "/byoc/challenge")).json as { nonce: string };
    expect((await server.authorizeDevice(deviceId, nonce, dev.sign(nonce))).ok).toBe(true);
  });
});
