/**
 * RemoteAgentClient — the container's core. Dials the cloud WS, sends the hello (protocol + join
 * token), then bridges Channel A to a local SdkAcpClient (@scooter/claude-sdk-provider, the SAME
 * driver the cloud uses on Bedrock): ACP requests from the cloud drive the local Claude; its
 * updates/permission requests go back up; its tool calls tunnel to the cloud sandbox (Channel B via
 * the tunnel ExecBackend). The Claude subscription token stays LOCAL. See
 * todo/docs/BYO_CLAUDE_REMOTE_AGENT.md.
 */

import { WebSocket } from "ws";
// The SDK-backed AcpClient — the same package the agent-host imports cloud-side.
import { createSdkAcpClient } from "@scooter/claude-sdk-provider";

import { REMOTE_PROTOCOL_VERSION, type WireFrame } from "./protocol.js";
import { parsePermissionAnswer } from "./permissionAnswer.js";
import { nextReconnectDelay, closeDisposition } from "./reconnect.js";
import { loadDeviceIdentity, signChallenge } from "./deviceKey.js";
import { createTunnelExecBackend } from "./tunnelExec.js";

export interface RemoteAgentClientDeps {
  /** wss URL (…/remote-agent/connect). */
  url: string;
  /** Owner-bound join token (from the UI one-liner). Used ONCE, to register this device. */
  joinToken: string;
  /** Fetch a fresh challenge nonce from the controller (§P). Absent => token-only mode. */
  challengeNonce?: () => Promise<string>;
  /** The user's Claude subscription OAuth token (from ~/.claude — stays local). */
  oauthToken: string;
  /** Model for the SDK query(). Defaults to a sensible current model. */
  model?: string;
  /** Agent identity/skills as the system prompt. */
  systemPrompt?: string;
  /** Path to a glibc `claude` CLI (the SDK bundles a musl one). */
  claudeCodePath?: string;
  /** Log sink (defaults to console). */
  log?: (msg: string) => void;
}

export interface RemoteAgentClient {
  /** Resolves when the connection closes (after any reconnect attempts stop). */
  closed: Promise<void>;
  stop(): void;
}

/**
 * The WS URL to dial, carrying whatever credential this container has.
 *
 * A REGISTERED device signs a fresh server nonce (§P) — that is what survives a laptop sleeping
 * past the join token's ten-minute life. A first-time container falls back to the join token. Both
 * travel as query params because the controller authorizes the UPGRADE itself, before any message
 * exists.
 */
export async function buildConnectUrl(deps: RemoteAgentClientDeps): Promise<string> {
  const url = new URL(deps.url);
  const identity = await loadDeviceIdentity();
  if (identity && deps.challengeNonce) {
    try {
      const nonce = await deps.challengeNonce();
      url.searchParams.set("deviceId", identity.deviceId);
      url.searchParams.set("nonce", nonce);
      url.searchParams.set("signature", signChallenge(identity.privateKeyPem, nonce));
      return url.toString();
    } catch {
      // Controller mid-rollout or no challenge endpoint: fall back to the join token for this
      // attempt; the jittered backoff retries.
    }
  }
  if (deps.joinToken) url.searchParams.set("token", deps.joinToken);
  return url.toString();
}

export function runRemoteAgentClient(deps: RemoteAgentClientDeps): RemoteAgentClient {
  const log = deps.log ?? ((m: string) => console.log(`[remote-agent] ${m}`));
  let stopped = false;
  let attempt = 0;
  let ws: WebSocket | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));

  const connect = async () => {
    if (stopped) return;
    // The controller authorizes at the UPGRADE, before any application message can be sent, so
    // credentials must ride on the URL. An earlier cut sent them in the hello FRAME: the controller
    // read query params, the container sent a message, and device auth silently NEVER ENGAGED —
    // every reconnect quietly fell back to the join token and died once it expired.
    const connectUrl = await buildConnectUrl(deps);
    ws = new WebSocket(connectUrl);
    const frameCbs = new Set<(f: WireFrame) => void>();
    const send = (f: WireFrame) => {
      if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(f));
    };

    // The SDK-backed brain, driving the LOCAL Claude with the user's token; its tools tunnel to the
    // cloud sandbox via the exec backend. createSdkAcpClient is async (spawns the claude subprocess
    // lazily on first use), so await it before wiring handlers.
    const exec = createTunnelExecBackend({
      send,
      onFrame: (cb) => {
        frameCbs.add(cb);
        return () => frameCbs.delete(cb);
      },
    });
    const sdk = await createSdkAcpClient({
      oauthToken: deps.oauthToken,
      model: deps.model ?? "claude-sonnet-4-5",
      exec: exec as never, // structurally identical ExecBackend
      systemPrompt: deps.systemPrompt ?? "You are Scooter, a helpful agent.",
      claudeCodePath: deps.claudeCodePath,
    });

    // Route the SDK's notifications UP the wire.
    sdk.onSessionUpdate((sessionId, update) => send({ ch: "acp", type: "session_update", payload: { sessionId, update } }));
    sdk.onTerminalCreated((terminalId, command, args) => send({ ch: "acp", type: "terminal_created", payload: { terminalId, command, args } }));
    // Permission requests: ask the cloud (which raises the UI interrupt), await the answer over id.
    const permissionWaiters = new Map<string, (ans: { optionId: string } | { cancelled: true }) => void>();
    sdk.onPermissionRequest((req) => {
      return new Promise((resolve) => {
        const id = req.toolCallId + ":" + Math.random().toString(36).slice(2);
        permissionWaiters.set(id, resolve);
        send({ ch: "acp", type: "permission_request", id, payload: { request: req } });
      });
    });

    ws.on("open", () => {
      void (async () => {
        attempt = 0; // a successful connect resets the backoff window
        // Auth already happened at the UPGRADE (see buildConnectUrl). The hello now only
        // negotiates the protocol version, so a mismatch fails clean rather than mid-conversation.
        ws!.send(JSON.stringify({ protocolVersion: REMOTE_PROTOCOL_VERSION, joinToken: deps.joinToken }));
      })();
    });

    ws.on("message", (data) => {
      let frame: WireFrame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      // Server confirmations.
      if (frame.type === "connected") {
        log(`registered as owner ${(frame.payload as { owner?: string })?.owner ?? "?"} — ready`);
        return;
      }
      // Channel B exec_result → the tunnel backend's waiters.
      if (frame.ch === "exec") {
        for (const cb of frameCbs) cb(frame);
        return;
      }
      // Channel A: drive the SDK.
      if (frame.ch === "acp") void handleAcp(frame);
    });

    const ack = (id: string | undefined, result: unknown, error?: string) => {
      if (id) send({ ch: "acp", type: "ack", id, payload: error ? { error } : { result } });
    };

    const handleAcp = async (frame: WireFrame) => {
      try {
        switch (frame.type) {
          case "initialize": {
            const r = await sdk.initialize((frame.payload as { params: never }).params);
            return ack(frame.id, r);
          }
          case "new_session": {
            const r = await sdk.newSession((frame.payload as { params: never }).params);
            log(`new_session -> acp session ${(r as { sessionId?: string }).sessionId ?? "?"}`);
            return ack(frame.id, r);
          }
          case "prompt": {
            const p = frame.payload as { sessionId: string; prompt: Array<{ type?: string; text?: string }> };
            // Prove WHICH agent served a turn. Without this there is no way to tell from the
            // outside whether a reply came from THIS container or from the cloud-side provider —
            // the cloud falls back silently when the container is offline, so an answer arriving
            // is NOT evidence the container produced it.
            const preview = (p.prompt ?? [])
              .map((b) => (typeof b?.text === "string" ? b.text : ""))
              .join(" ")
              .replace(/\s+/g, " ")
              .slice(0, 80);
            log(`prompt acp-session=${p.sessionId} text="${preview}"`);
            const started = Date.now();
            const r = await sdk.prompt({ sessionId: p.sessionId, prompt: p.prompt as never });
            log(`prompt DONE acp-session=${p.sessionId} stopReason=${(r as { stopReason?: string }).stopReason ?? "?"} in ${Date.now() - started}ms`);
            return ack(frame.id, r);
          }
          case "cancel": {
            await sdk.cancel((frame.payload as { sessionId: string }).sessionId);
            return ack(frame.id, {});
          }
          case "kill_terminals": {
            await sdk.killActiveTerminals();
            return ack(frame.id, {});
          }
          case "ack": {
            // A permission answer (the cloud replied to our permission_request id). The payload is
            // FLAT from the BYOC controller ({optionId}) but was nested ({result:{optionId}}) on the
            // old webhooks bridge; parsePermissionAnswer accepts both and fails CLOSED on anything
            // else. The previous `?? {}` turned an unrecognised answer into an empty selection,
            // which the SDK would act on — a tool call running without an approval.
            const w = frame.id ? permissionWaiters.get(frame.id) : undefined;
            if (w && frame.id) {
              permissionWaiters.delete(frame.id);
              w(parsePermissionAnswer(frame.payload));
            }
            return;
          }
        }
      } catch (err) {
        ack(frame.id, undefined, err instanceof Error ? err.message : String(err));
      }
    };

    // Set when the UPGRADE itself was rejected (non-101): the socket never opened, so the
    // close event that follows terminate() carries a meaningless 1006 — this flag makes that
    // close use the AUTH disposition (slow retry) instead of the fast network-blip schedule.
    let upgradeAuthRejected = false;
    ws.on("close", (code, reasonBuf) => {
      // Interpret the close CODE — the controller uses application codes for conditions a
      // container must react to differently than a network blip. The observed failure: token
      // auth rejected, a generic "disconnected (code 1005)", and a fast retry loop forever —
      // the machine looked fine while permanently unauthenticated.
      const disposition = upgradeAuthRejected
        ? closeDisposition(4001, "rejected at the WebSocket upgrade (HTTP 401)", attempt + 1)
        : closeDisposition(code, reasonBuf?.toString() ?? "", attempt + 1);
      if (!upgradeAuthRejected) log(disposition.message ?? `disconnected (code ${code})`);
      // FAIL EVERY PARKED PERMISSION. `permissionWaiters` lives inside connect(), so a disconnect
      // used to abandon its promises: the local SDK would wait forever on an approval that can
      // never arrive, wedging the agent until the container was restarted by hand. Cancelling is
      // the safe resolution — the tool call is refused, not silently allowed.
      for (const [id, waiter] of [...permissionWaiters]) {
        permissionWaiters.delete(id);
        waiter({ cancelled: true });
      }
      void sdk.close().catch(() => {});
      if (stopped) {
        resolveClosed();
        return;
      }
      // Exponential backoff WITH JITTER (see reconnect.ts). The old fixed 3s meant every container
      // in the fleet retried on the same tick after a rollout, a synchronised herd against the
      // single-replica controller.
      attempt += 1;
      const delay = disposition.delayMs;
      log(`reconnecting in ${delay}ms (attempt ${attempt})`);
      setTimeout(() => void connect(), delay);
    });
    // A NON-101 upgrade response (an older controller rejects with a raw 401 before any WS
    // exists). Without this handler the ws lib emits a generic error and the fast retry loop —
    // the same silent-auth-failure shape as an uncoded close.
    ws.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 401) {
        upgradeAuthRejected = true;
        log(
          "AUTHENTICATION FAILED: the server rejected this container's credentials at the upgrade " +
            "(HTTP 401). This will not fix itself — get a fresh docker command from the Settings page.",
        );
      } else {
        log(`unexpected server response ${res.statusCode ?? "?"} during connect`);
      }
      // terminate() fires the close handler, which schedules the retry (slow, via the flag).
      ws?.terminate();
    });
    ws.on("error", (e) => log(`ws error: ${(e as Error).message}`));
  };

  void connect();
  return {
    closed,
    stop() {
      stopped = true;
      ws?.close();
    },
  };
}
