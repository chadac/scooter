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

    // Permission answers route by unique frame id, so ONE shared waiter map serves every
    // per-session client below.
    const permissionWaiters = new Map<string, (ans: { optionId: string } | { cancelled: true }) => void>();

    /** Build one SDK-backed brain. ONE PER ACP SESSION (i.e. per conversation): each client's
     *  outbound frames are STAMPED with its session id (`sid`), which is the only attribution
     *  exec frames have — their payloads carry no session, unlike session_update's. The relay
     *  routes by that stamp, which is what makes CONCURRENT conversations on one container
     *  safe: with a single shared client, exec requests were broadcast to every in-flight run
     *  and two conversations would each execute the other's tool calls in the wrong sandbox.
     *  The stamp is a mutable box because the session id only exists AFTER newSession returns;
     *  nothing tool-shaped flows before that. */
    const buildClient = async () => {
      const stamp: { sid?: string } = {};
      const stampedSend = (f: WireFrame) => send(stamp.sid ? { ...f, sid: stamp.sid } : f);
      const exec = createTunnelExecBackend({
        send: stampedSend,
        onFrame: (cb) => {
          frameCbs.add(cb);
          return () => frameCbs.delete(cb);
        },
      });
      const sdk = await createSdkAcpClient({
        oauthToken: deps.oauthToken,
        model: deps.model ?? "claude-sonnet-4-5",
        exec, // the provider's OWN ExecBackend type — a contract drift is now a compile error
        systemPrompt: deps.systemPrompt ?? "You are Scooter, a helpful agent.",
        claudeCodePath: deps.claudeCodePath,
      });
      // Route the SDK's notifications UP the wire, stamped. session_update carries its session
      // in the payload too (that has been true since day one — the relay uses it as a fallback
      // for old containers); the stamp makes every frame uniform.
      sdk.onSessionUpdate((sessionId, update) =>
        send({ ch: "acp", type: "session_update", sid: sessionId, payload: { sessionId, update } }));
      sdk.onTerminalCreated((terminalId, command, args) => stampedSend({ ch: "acp", type: "terminal_created", payload: { terminalId, command, args } }));
      sdk.onPermissionRequest((req) => {
        return new Promise<{ optionId: string } | { cancelled: true }>((resolve) => {
          const id = req.toolCallId + ":" + Math.random().toString(36).slice(2);
          permissionWaiters.set(id, resolve);
          send({ ch: "acp", type: "permission_request", id, sid: req.sessionId, payload: { request: req } });
        });
      });
      return { sdk, stamp };
    };

    // The PRIMARY client answers `initialize` (which precedes any session) and serves legacy
    // dispatches; every `new_session` gets its OWN client so concurrent conversations have
    // isolated brains and attributable tool calls.
    const primary = await buildClient();
    const sdk = primary.sdk;
    const clients = new Map<string, { sdk: typeof primary.sdk; stamp: { sid?: string } }>();

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
            // ONE CLIENT PER SESSION (see buildClient): the returned session id becomes both the
            // routing key for later prompts and the sid stamped on this client's tool frames.
            const client = await buildClient();
            const r = await client.sdk.newSession((frame.payload as { params: never }).params);
            const sid = (r as { sessionId?: string }).sessionId;
            if (sid) {
              client.stamp.sid = sid;
              clients.set(sid, client);
            }
            log(`new_session -> acp session ${sid ?? "?"}`);
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
            // STRICT: a session id this instance never issued means the container RESTARTED
            // since the cloud established it (per-session clients die with the process). The
            // old fallback served such prompts from the blank primary client — no history, no
            // error, an agent "with no context" (observed live: the session predated the
            // container's own start time, zero new_session calls in its log). Refusing loudly
            // lets the cloud drop its cached session, re-establish on THIS instance, and
            // re-seed the transcript.
            const owner = clients.get(p.sessionId)?.sdk;
            if (!owner) {
              log(`prompt for unknown acp-session=${p.sessionId} — refusing (container restarted since it was created)`);
              return ack(frame.id, undefined, `unknown session ${p.sessionId} (container restarted)`);
            }
            const r = await owner.prompt({ sessionId: p.sessionId, prompt: p.prompt as never });
            log(`prompt DONE acp-session=${p.sessionId} stopReason=${(r as { stopReason?: string }).stopReason ?? "?"} in ${Date.now() - started}ms`);
            return ack(frame.id, r);
          }
          case "cancel": {
            // Cancelling a session this instance never issued is a NO-OP success: whatever ran
            // there died with the previous container, which is the outcome a cancel wants.
            const sid = (frame.payload as { sessionId: string }).sessionId;
            await clients.get(sid)?.sdk.cancel(sid);
            return ack(frame.id, {});
          }
          case "kill_terminals": {
            // The cloud does not say WHICH session's terminals — kill across every client, same
            // blast radius the single-client world had.
            await Promise.all([sdk, ...[...clients.values()].map((c) => c.sdk)].map((c) => c.killActiveTerminals().catch(() => {})));
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
      for (const c of clients.values()) void c.sdk.close().catch(() => {});
      clients.clear();
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
