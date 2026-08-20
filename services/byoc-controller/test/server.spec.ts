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

const SECRET = "test-secret";

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

  beforeEach(() => {
    registry = createSessionRegistry({ store: fakeStore(), secret: SECRET });
    relay = createRunRelay({ registry });
    server = createServer({ registry, relay, secret: SECRET });
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

  it("the WS upgrade REJECTS a token minted for the OLD remote-agent audience", async () => {
    // The retired webhooks bridge minted `aud: "remote-agent"`. Since /byoc/ is unauthenticated,
    // accepting it would make every old token a valid key to the new controller.
    const mint = (await req("POST", "/byoc/sessions", { owner: "alice" })).json as { sessionId: string };
    const legacy = mintJoinToken("alice", SECRET).split(".");
    const claims = JSON.parse(Buffer.from(legacy[1], "base64url").toString());
    claims.aud = "remote-agent";
    const tampered = `${legacy[0]}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${legacy[2]}`;
    expect(server.authorizeUpgrade(mint.sessionId, tampered).ok).toBe(false);
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
});
