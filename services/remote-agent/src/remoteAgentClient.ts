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
import { createTunnelExecBackend } from "./tunnelExec.js";

export interface RemoteAgentClientDeps {
  /** wss URL (…/remote-agent/connect). */
  url: string;
  /** Owner-bound join token (from the UI one-liner). */
  joinToken: string;
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

export function runRemoteAgentClient(deps: RemoteAgentClientDeps): RemoteAgentClient {
  const log = deps.log ?? ((m: string) => console.log(`[remote-agent] ${m}`));
  let stopped = false;
  let ws: WebSocket | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));

  const connect = async () => {
    if (stopped) return;
    ws = new WebSocket(deps.url);
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
    const permissionWaiters = new Map<string, (ans: { optionId?: string; cancelled?: boolean }) => void>();
    sdk.onPermissionRequest((req) => {
      return new Promise((resolve) => {
        const id = req.toolCallId + ":" + Math.random().toString(36).slice(2);
        permissionWaiters.set(id, (ans) => resolve(ans.cancelled ? { cancelled: true } : { optionId: ans.optionId ?? "" }));
        send({ ch: "acp", type: "permission_request", id, payload: { request: req } });
      });
    });

    ws.on("open", () => {
      log(`connected → ${deps.url}; authenticating`);
      // The cloud's connect handler expects the FIRST message to be the hello (protocol + token).
      ws!.send(JSON.stringify({ protocolVersion: REMOTE_PROTOCOL_VERSION, joinToken: deps.joinToken }));
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
            return ack(frame.id, r);
          }
          case "prompt": {
            const p = frame.payload as { sessionId: string; prompt: never };
            const r = await sdk.prompt({ sessionId: p.sessionId, prompt: p.prompt });
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
            // A permission answer (the cloud replied to our permission_request id).
            const w = frame.id ? permissionWaiters.get(frame.id) : undefined;
            if (w && frame.id) {
              permissionWaiters.delete(frame.id);
              w((frame.payload as { result?: { optionId?: string; cancelled?: boolean } }).result ?? {});
            }
            return;
          }
        }
      } catch (err) {
        ack(frame.id, undefined, err instanceof Error ? err.message : String(err));
      }
    };

    ws.on("close", (code) => {
      log(`disconnected (code ${code})`);
      void sdk.close().catch(() => {});
      if (stopped) {
        resolveClosed();
        return;
      }
      // Reconnect after a short backoff (the join token may expire; a durable credential is a
      // follow-up — for now re-run the container to re-mint).
      setTimeout(() => void connect(), 3000);
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
