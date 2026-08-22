/**
 * The BYOC controller's HTTP surface — routing only, no transport specifics.
 *
 * Kept as a pure request->response function (rather than an http.Server) so every route, and in
 * particular every REJECTION, is contract-testable without sockets or ports. index.ts binds this to
 * node:http + ws.
 *
 * THE AUTH SPLIT (§L Q3) is the thing to get right here:
 *
 *   POST /byoc/sessions             MINT — AUTHED. Needs a resolved user; a session must be
 *                                   owner-bound or resolve-by-owner has no key and anyone could
 *                                   mint. Served from the authed UI surface, NOT the /byoc/ ingress.
 *   GET  /byoc/ws/:id               CONNECT — UNAUTHENTICATED at the ingress, because the user's
 *                                   container cannot carry a browser session. Its only defence is
 *                                   the join token: signature, expiry, audience, and owner-matches-
 *                                   session. Same model as the webhooks receiver, which is
 *                                   deliberately unauthenticated and verifies an HMAC instead.
 *   POST /byoc/:id/prompt           in-cluster, from any agent-host replica
 *   POST /byoc/:id/permission/:pid  ditto — unblocks a pending permission
 *   POST /byoc/:id/exec/:xid        ditto — Channel B result
 *   GET  /byoc/status?owner=…       the UI badge
 *
 * Routes are matched EXACTLY, with no catch-all: an unauthenticated surface should 404 anything it
 * does not explicitly serve rather than fall through to a handler that assumes it was reached
 * through the authed path.
 */

import type { SessionRegistry } from "./sessionRegistry.js";
import type { RunRelay, PermissionAnswer } from "./runRelay.js";
import { verifyJoinToken } from "./joinToken.js";
import type { DeviceAuth, DeviceSummary } from "./deviceAuth.js";
import type { WireFrame } from "./remoteProtocol.js";

export interface ByocRequest {
  method: string;
  path: string;
  body?: unknown;
  /** The resolved user, present ONLY on the authed surface (the UI's mint call). */
  user?: { id: string };
}

export interface ByocResponse {
  status: number;
  json?: unknown;
  /** Set for the prompt route: the caller streams these frames back as SSE. */
  stream?: AsyncIterable<WireFrame>;
}

export interface ByocServerConfig {
  registry: SessionRegistry;
  relay: RunRelay;
  secret: string;
  /** Device-key auth (§P). Optional so a deployment can run token-only during rollout. */
  devices?: DeviceAuth;
}

export interface ByocServer {
  handle(req: ByocRequest): Promise<ByocResponse>;
  /** Gate the WS upgrade on /byoc/ws/:id with a JOIN TOKEN (first connect / no device yet). */
  authorizeUpgrade(sessionId: string, token: string): { ok: true; owner: string } | { ok: false; reason: string };
  /** Gate a reconnect with a DEVICE SIGNATURE (§P) — no join token, valid indefinitely. */
  authorizeDevice(
    deviceId: string,
    nonce: string,
    signature: string,
  ): Promise<{ ok: true; owner: string } | { ok: false; reason: string }>;
  /** Record a REJECTED connection attempt so the Settings UI can show it (via /byoc/status).
   *  The observed failure mode: a container's token auth failed and NOTHING said so on either
   *  end — the container fast-looped in silence and the UI showed a clean "disconnected".
   *  Owner attribution is best-effort: a device id maps through the store; an invalid token's
   *  claims are decoded UNVERIFIED — acceptable for a diagnostic label, never for authz. */
  noteAuthFailure(info: { deviceId?: string | null; token?: string; reason: string }): Promise<void>;
  close(): void;
}

/** Decode a JWT's claims WITHOUT verifying — diagnostics only (see noteAuthFailure). */
function decodeClaimsUnverified(token: string): { owner?: string } | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, "base64url").toString()) as { owner?: string };
  } catch {
    return null;
  }
}

export function createServer(config: ByocServerConfig): ByocServer {
  const { registry, relay, secret, devices } = config;
  // owner -> the most recent rejected connection attempt. In-memory on purpose: this is a
  // diagnostic surface (like the socket itself), not durable state; a controller restart
  // clearing it is fine — the container will either connect or fail again within minutes.
  const authFailures = new Map<string, { reason: string; at: string }>();

  return {
    async handle(req) {
      const [pathname, query = ""] = req.path.split("?");
      const parts = pathname.split("/").filter(Boolean); // ["byoc", ...]

      if (parts[0] !== "byoc") return { status: 404, json: { error: "not found" } };

      // POST /byoc/sessions — MINT (authed).
      if (req.method === "POST" && parts.length === 2 && parts[1] === "sessions") {
        if (!req.user?.id) {
          return { status: 401, json: { error: "authentication required to mint a BYOC session" } };
        }
        const minted = await registry.mint(req.user.id);
        return { status: 200, json: minted };
      }

      // --- Device auth (§P) ---
      // POST /byoc/devices — REGISTER. On the unauthenticated ingress on purpose: the container
      // has no browser session, and the short-lived join token is the gate.
      if (req.method === "POST" && parts.length === 2 && parts[1] === "devices") {
        if (!devices) return { status: 404, json: { error: "device auth not enabled" } };
        const body = req.body as { joinToken?: string; publicKey?: string; label?: string };
        if (!body?.joinToken || !body?.publicKey) {
          return { status: 400, json: { error: "joinToken and publicKey required" } };
        }
        const res = await devices.register(body.joinToken, body.publicKey, body.label);
        return res.ok
          ? { status: 200, json: { deviceId: res.deviceId } }
          : { status: 401, json: { error: res.reason } };
      }

      // GET /byoc/challenge — a single-use nonce for a container to sign. Unauthenticated: a nonce
      // is useless without the matching private key, and issuing one leaks nothing.
      if (req.method === "GET" && parts.length === 2 && parts[1] === "challenge") {
        if (!devices) return { status: 404, json: { error: "device auth not enabled" } };
        return { status: 200, json: devices.challenge() };
      }

      // GET /byoc/devices — the settings list. AUTHED: a device list is per-user.
      if (req.method === "GET" && parts.length === 2 && parts[1] === "devices") {
        if (!devices) return { status: 404, json: { error: "device auth not enabled" } };
        if (!req.user?.id) return { status: 401, json: { error: "authentication required" } };
        const list: DeviceSummary[] = await devices.listDevices(req.user.id);
        return { status: 200, json: list };
      }

      // DELETE /byoc/devices/:id — deregister. AUTHED, and scoped to the caller's own devices.
      if (req.method === "DELETE" && parts.length === 3 && parts[1] === "devices") {
        if (!devices) return { status: 404, json: { error: "device auth not enabled" } };
        if (!req.user?.id) return { status: 401, json: { error: "authentication required" } };
        await devices.deregister(req.user.id, parts[2]);
        return { status: 204 };
      }

      // GET /byoc/status?owner=…
      if (req.method === "GET" && parts.length === 2 && parts[1] === "status") {
        const owner = new URLSearchParams(query).get("owner") ?? req.user?.id;
        if (!owner) return { status: 400, json: { error: "owner required" } };
        const session = registry.resolveByOwner(owner);
        if (!session) {
          return { status: 200, json: { status: "disconnected", lastAuthFailure: authFailures.get(owner) ?? null } };
        }
        // THREE states, not two: "minted" (session exists, container has not dialled in yet) is
        // distinct from "disconnected" (nothing minted). The UI needs the difference to say
        // "waiting for your container" rather than "not set up".
        return {
          status: 200,
          json: {
            sessionId: session.sessionId,
            status: session.online ? "connected" : "minted",
            // The most recent REJECTED attempt, so "connected: false" can say WHY instead of
            // looking identical to "the user never started a container".
            lastAuthFailure: authFailures.get(owner) ?? null,
          },
        };
      }

      // Everything below is /byoc/:id/<verb>[/:subid].
      if (parts.length >= 3) {
        const sessionId = parts[1];
        const verb = parts[2];
        if (!registry.resolveBySession(sessionId)) {
          return { status: 404, json: { error: "unknown session" } };
        }

        // Every ACP REQUEST the agent-host makes — initialize, new_session, prompt, cancel,
        // kill_terminals — comes through here. They are NOT all prompts: routing them all to a
        // "prompt" verb was fine on the wire (the frame carries its own `type`), but only if the
        // relay forwards the WHOLE frame. It used to forward `payload` under a hardcoded
        // type:"prompt", so an initialize/new_session arrived at the container as a prompt with
        // no sessionId and no text — `prompt acp-session=undefined text=""` — and the ACP
        // handshake never completed, so no run could start.
        if (req.method === "POST" && verb === "prompt" && parts.length === 3) {
          const session = registry.resolveBySession(sessionId);
          // 503, never a hang: the agent-host transport turns a non-OK into a CLOSED transport,
          // which the bridge surfaces as RUN_ERROR ("your Claude is offline") instead of leaving
          // the user watching a spinner on a run that can never finish.
          if (!session?.online) return { status: 503, json: { error: "container not connected" } };
          // Forward the frame's own type + payload, so initialize/new_session/cancel reach the
          // container as themselves rather than as an empty prompt.
          const frame = req.body as { type?: string; payload?: unknown };
          return {
            status: 200,
            stream: relay.request(sessionId, frame?.type ?? "prompt", (frame?.payload ?? {}) as never),
          };
        }

        if (req.method === "POST" && verb === "permission" && parts.length === 4) {
          const answer = (req.body as { payload?: PermissionAnswer })?.payload ?? (req.body as PermissionAnswer);
          const res = relay.answerPermission(sessionId, parts[3], answer);
          return res.ok ? { status: 204 } : { status: 409, json: { error: res.reason } };
        }

        if (req.method === "POST" && verb === "exec" && parts.length === 4) {
          const payload = (req.body as { payload?: unknown })?.payload ?? req.body;
          const res = relay.answerExec(sessionId, parts[3], (payload ?? {}) as never);
          return res.ok ? { status: 204 } : { status: 409, json: { error: res.reason } };
        }
      }

      return { status: 404, json: { error: "not found" } };
    },

    authorizeUpgrade(sessionId, token) {
      const session = registry.resolveBySession(sessionId);
      if (!session) return { ok: false, reason: "unknown session" };
      // verifyJoinToken checks signature (constant-time), expiry, AND audience — the audience being
      // `byoc` is what stops a token minted for the retired webhooks bridge from working here.
      const verified = verifyJoinToken(token, secret);
      if (!verified.ok) return { ok: false, reason: verified.reason };
      // And the token's owner must own THIS session: /byoc/ws/:id is reachable by anyone, so a
      // caller holding a valid token of their own must not attach to someone else's session.
      if (verified.claims.owner !== session.owner) return { ok: false, reason: "owner mismatch" };
      return { ok: true, owner: session.owner };
    },

    async noteAuthFailure(info) {
      const owner = info.deviceId
        ? await devices?.ownerOf(info.deviceId)
        : decodeClaimsUnverified(info.token ?? "")?.owner;
      if (!owner) return; // unattributable — the warn log still has the raw event
      authFailures.set(owner, { reason: info.reason, at: new Date().toISOString() });
    },

    async authorizeDevice(deviceId, nonce, signature) {
      if (!devices) return { ok: false, reason: "device auth not enabled" };
      const res = await devices.verify(deviceId, nonce, signature);
      return res.ok ? { ok: true, owner: res.owner } : { ok: false, reason: res.reason };
    },

    close() {
      /* the transport owns sockets; nothing to release here */
    },
  };
}
