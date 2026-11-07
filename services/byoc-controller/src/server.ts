/**
 * The BYOC controller's HTTP surface, a pure request->response function so every route and
 * rejection is contract-testable without sockets; shell.ts binds it to node:http and ws.
 *
 * The public surface, the only one the ingress reaches, serves the container's routes:
 *   GET  /byoc/ws/:id               connect; a join token or device signature is the gate
 *   POST /byoc/devices              register a device key with a join token
 *   GET  /byoc/challenge            a nonce for a device-signed connect
 *
 * The internal surface, reached only by the agent-host in-cluster, serves everything:
 *   POST /byoc/sessions             mint for the user the agent-host names
 *   POST /byoc/:id/prompt           an ACP request from any agent-host replica
 *   POST /byoc/:id/permission/:pid  unblocks a pending permission
 *   POST /byoc/:id/exec/:xid        a Channel B result
 *   GET  /byoc/:id/tunnel           the container-initiated tunnel stream (replies POST to it)
 *   GET  /byoc/status?owner=…       the UI badge and the routing check
 *   GET|DELETE /byoc/devices[/:id]  the user's registered devices
 *
 * Routes are matched exactly with no catch-all, so each surface 404s anything it does not
 * explicitly serve.
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
  /** The user the agent-host names, honoured only on the internal surface. */
  user?: { id: string };
  /** Which listener the request arrived on; defaults to internal. */
  surface?: "public" | "internal";
}

/** Whether a request is one the public, ingress-facing surface serves. */
export function isPublicRoute(method: string, path: string): boolean {
  const pathname = path.split("?")[0];
  return (
    (method === "POST" && pathname === "/byoc/devices") || (method === "GET" && pathname === "/byoc/challenge")
  );
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
  /** Device-key auth, optional so a deployment can run token-only. */
  devices?: DeviceAuth;
}

export interface ByocServer {
  handle(req: ByocRequest): Promise<ByocResponse>;
  /** Gate the WS upgrade on /byoc/ws/:id with a join token. */
  authorizeUpgrade(sessionId: string, token: string): { ok: true; owner: string } | { ok: false; reason: string };
  /** Gate a reconnect with a device signature, which needs no join token. */
  authorizeDevice(
    deviceId: string,
    nonce: string,
    signature: string,
  ): Promise<{ ok: true; owner: string } | { ok: false; reason: string }>;
  /** Record a rejected connection attempt for /byoc/status, with best-effort owner attribution that decodes an invalid token's claims unverified (a diagnostic label, never an authz input). */
  noteAuthFailure(info: { deviceId?: string | null; token?: string; reason: string }): Promise<void>;
  close(): void;
}

/** Decode a JWT's claims without verifying, for diagnostics only. */
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
  // owner -> the most recent rejected connection attempt, in-memory because it is diagnostic.
  const authFailures = new Map<string, { reason: string; at: string }>();
  // sessionId -> the waiting readers of that session's inbound tunnel stream, fed by one relay subscription.
  const tunnelReaders = new Map<string, Set<(f: WireFrame | null) => void>>();
  const tunnelQueues = new Map<string, WireFrame[]>();
  /** sessionId -> how many frames have been trimmed off the front of its queue, which a reader subtracts from its absolute cursor to index the array. */
  const tunnelTrimmed = new Map<string, number>();
  /** Frames kept per session, enough for in-flight MCP while bounding memory. */
  const TUNNEL_QUEUE_MAX = 512;
  // Queue first, then wake every reader: all of an owner's conversations share one session, and each reader ignores frames whose stream it does not own.
  relay.onTunnelFrame((sessionId, frame) => {
    const q = tunnelQueues.get(sessionId) ?? [];
    q.push(frame);
    // Keep a recent window only, since a reader this far behind has already timed out its stream.
    if (q.length > TUNNEL_QUEUE_MAX) {
      const drop = q.length - TUNNEL_QUEUE_MAX;
      q.splice(0, drop);
      tunnelTrimmed.set(sessionId, (tunnelTrimmed.get(sessionId) ?? 0) + drop);
    }
    tunnelQueues.set(sessionId, q);
    const waiting = tunnelReaders.get(sessionId);
    if (!waiting?.size) return;
    // Snapshot: a woken reader re-registers, and iterating the live set would re-wake it.
    for (const waiter of [...waiting]) {
      waiting.delete(waiter);
      waiter(undefined as never); // wake it; it drains the queue itself
    }
  });

  /** One session's inbound tunnel frames, as an async iterable the shell serves as SSE. */
  const tunnelStream = (sessionId: string): AsyncIterable<WireFrame> => ({
    async *[Symbol.asyncIterator]() {
      // Per-reader absolute sequence number, converted to an array index via `trimmed`.
      let seq = 0;
      // Set while parked, so `finally` can drop a reader that stopped iterating and would otherwise keep the process alive.
      let parked: ((f: WireFrame | null | undefined) => void) | undefined;
      try {
        for (;;) {
          const q = tunnelQueues.get(sessionId);
          const trimmed = tunnelTrimmed.get(sessionId) ?? 0;
          // Fell behind a trim: skip to the oldest frame still held rather than replay.
          if (seq < trimmed) seq = trimmed;
          if (q && seq - trimmed < q.length) {
            yield q[seq - trimmed]!;
            seq += 1;
            continue;
          }
          // Wait to be woken, then loop back to drain the queue.
          const woken = await new Promise<WireFrame | null | undefined>((resolve) => {
            parked = resolve;
            const set = tunnelReaders.get(sessionId) ?? new Set();
            set.add(resolve);
            tunnelReaders.set(sessionId, set);
          });
          parked = undefined;
          if (woken === null) return;
        }
      } finally {
        // Runs on break, return and throw.
        if (parked) tunnelReaders.get(sessionId)?.delete(parked);
      }
    },
  });

  return {
    async handle(req) {
      if (req.surface === "public") {
        if (!isPublicRoute(req.method, req.path)) return { status: 404, json: { error: "not found" } };
        // Public callers can set any header, so no identity crosses this surface.
        req = { ...req, user: undefined };
      }
      const [pathname, query = ""] = req.path.split("?");
      let parts: string[];
      try {
        // Ids arrive URL-encoded; a permission id contains a colon.
        parts = pathname.split("/").filter(Boolean).map(decodeURIComponent); // ["byoc", ...]
      } catch {
        return { status: 400, json: { error: "malformed path" } };
      }

      if (parts[0] !== "byoc") return { status: 404, json: { error: "not found" } };

      // POST /byoc/sessions: mint (internal).
      if (req.method === "POST" && parts.length === 2 && parts[1] === "sessions") {
        if (!req.user?.id) {
          return { status: 401, json: { error: "authentication required to mint a BYOC session" } };
        }
        const minted = await registry.mint(req.user.id);
        return { status: 200, json: minted };
      }

      // --- Device auth ---
      // POST /byoc/devices: register, public because the container has no browser session and the join token is the gate.
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

      // GET /byoc/challenge: a single-use nonce for a container to sign, unauthenticated because a nonce is useless without the matching private key.
      if (req.method === "GET" && parts.length === 2 && parts[1] === "challenge") {
        if (!devices) return { status: 404, json: { error: "device auth not enabled" } };
        return { status: 200, json: devices.challenge() };
      }

      // GET /byoc/devices: the per-user settings list (authed).
      if (req.method === "GET" && parts.length === 2 && parts[1] === "devices") {
        if (!devices) return { status: 404, json: { error: "device auth not enabled" } };
        if (!req.user?.id) return { status: 401, json: { error: "authentication required" } };
        const list: DeviceSummary[] = await devices.listDevices(req.user.id);
        return { status: 200, json: list };
      }

      // DELETE /byoc/devices/:id: deregister (authed, scoped to the caller's own devices).
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
        // "minted" (session exists, container not yet dialled in) is distinct from "disconnected" (nothing minted).
        return {
          status: 200,
          json: {
            sessionId: session.sessionId,
            status: session.online ? "connected" : "minted",
            // The most recent rejected attempt, so a disconnected status can say why.
            lastAuthFailure: authFailures.get(owner) ?? null,
          },
        };
      }

      // GET /byoc/:id/tunnel: the agent-host's inbound stream for container-initiated frames, one long-lived SSE per session, with replies via POST /byoc/:id/tunnel/:streamId.
      if (req.method === "GET" && parts.length === 3 && parts[2] === "tunnel") {
        const sessionId = parts[1];
        if (!registry.resolveBySession(sessionId)) {
          // A stream for an unknown session would leave the agent-host waiting on frames that can never arrive.
          return { status: 404, json: { error: "unknown session" } };
        }
        return { status: 200, stream: tunnelStream(sessionId) };
      }

      // Everything below is /byoc/:id/<verb>[/:subid].
      if (parts.length >= 3) {
        const sessionId = parts[1];
        const verb = parts[2];
        if (!registry.resolveBySession(sessionId)) {
          return { status: 404, json: { error: "unknown session" } };
        }

        // Every ACP request the agent-host makes comes through the "prompt" verb, and the frame carries its own `type`.
        if (req.method === "POST" && verb === "prompt" && parts.length === 3) {
          const session = registry.resolveBySession(sessionId);
          // A 503 becomes a closed transport that the bridge surfaces as RUN_ERROR, never a hang.
          if (!session?.online) return { status: 503, json: { error: "container not connected" } };
          // Forward the frame's own type and payload so initialize/new_session/cancel reach the container as themselves.
          const frame = req.body as { type?: string; id?: string; payload?: unknown };
          return {
            status: 200,
            // The caller's frame id passes through because the agent-host correlates the ack by it.
            stream: relay.request(sessionId, frame?.type ?? "prompt", (frame?.payload ?? {}) as never, frame?.id),
          };
        }

        if (req.method === "POST" && verb === "permission" && parts.length === 4) {
          const answer = (req.body as { payload?: PermissionAnswer })?.payload ?? (req.body as PermissionAnswer);
          const res = relay.answerPermission(sessionId, parts[3], answer);
          return res.ok ? { status: 204 } : { status: 409, json: { error: res.reason } };
        }

        // POST /byoc/:id/tunnel/:streamId: the agent-host's reply into a container-opened tunnel stream.
        if (req.method === "POST" && verb === "tunnel" && parts.length === 4) {
          const streamId = parts[3];
          const r = relay.answerTunnel(sessionId, streamId, req.body as WireFrame);
          if (!r.ok) return { status: 409, json: { error: r.reason } };
          return { status: 200, json: { ok: true } };
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
      // verifyJoinToken checks signature, expiry and audience.
      const verified = verifyJoinToken(token, secret);
      if (!verified.ok) return { ok: false, reason: verified.reason };
      // The token's owner must own this session, or a caller with a valid token of their own could attach to someone else's session.
      if (verified.claims.owner !== session.owner) return { ok: false, reason: "owner mismatch" };
      return { ok: true, owner: session.owner };
    },

    async noteAuthFailure(info) {
      const owner = info.deviceId
        ? await devices?.ownerOf(info.deviceId)
        : decodeClaimsUnverified(info.token ?? "")?.owner;
      if (!owner) return; // unattributable; the warn log still has the raw event
      authFailures.set(owner, { reason: info.reason, at: new Date().toISOString() });
    },

    async authorizeDevice(deviceId, nonce, signature) {
      if (!devices) return { ok: false, reason: "device auth not enabled" };
      const res = await devices.verify(deviceId, nonce, signature);
      if (!res.ok) return { ok: false, reason: res.reason };
      // The attach that follows is sync, so restore the owner's session first.
      await registry.recover(res.owner);
      return { ok: true, owner: res.owner };
    },

    close() {
      /* the transport owns sockets; nothing to release here */
    },
  };
}
