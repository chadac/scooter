/**
 * RemoteAgentClient, the container's core. It dials the cloud WS, sends the hello, then
 * bridges Channel A to a local SdkAcpClient: ACP requests from the cloud drive the local
 * Claude, its updates and permission requests go back up, and its tool calls tunnel to
 * the cloud sandbox over Channel B. The Claude subscription token stays local.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { WebSocket } from "ws";
import { pruneSkillDirs, writeSkillPayloads } from "./skills.js";
// The SDK-backed AcpClient, the same package the agent-host imports cloud-side.
import { selectBackend } from "./agentBackend.js";
import "./echoBackend.js"; // self-registers

import { REMOTE_PROTOCOL_VERSION, type WireFrame } from "./protocol.js";
import { parsePermissionAnswer, type PermissionAnswer } from "./permissionAnswer.js";
import { CLOSE_AUTH_REJECTED, CLOSE_SUPERSEDED, closeDisposition } from "./reconnect.js";
import { LINK_GRACE_MS, LINK_ID_PARAM, LINK_SEQ_PARAM, Link, type LinkResume } from "./link.js";
import { generateDeviceKey, loadDeviceIdentity, saveDeviceIdentity, signChallenge } from "./deviceKey.js";
import { createTunnelExecBackend } from "./tunnelExec.js";
import { startMcpProxies } from "./mcpProxy.js";

export interface RemoteAgentClientDeps {
  /** wss URL (…/remote-agent/connect). */
  url: string;
  /** Owner-bound join token from the UI one-liner, used once to register this device. */
  joinToken: string;
  /** Fetch a fresh challenge nonce from the controller; absent means token-only mode. */
  challengeNonce?: () => Promise<string>;
  /** The user's Claude subscription OAuth token, which stays local. Absent for a
   *  backend that needs no Claude auth (see selectBackend). */
  oauthToken?: string;
  /** Which agent to drive; defaults to the Claude SDK. */
  backend?: string;
  /** Model for the SDK query(). */
  model?: string;
  /** Agent identity/skills as the system prompt. */
  systemPrompt?: string;
  /** Path to a glibc `claude` CLI. */
  claudeCodePath?: string;
  /** Log sink, defaulting to console. */
  log?: (msg: string) => void;
  /** Redial when the controller's pings stop this long. */
  pingTimeoutMs?: number;
}

/** The controller pings every 20s. */
export const PING_TIMEOUT_MS = 45_000;

export interface RemoteAgentClient {
  /** Resolves when the connection closes and reconnect attempts stop. */
  closed: Promise<void>;
  stop(): void;
}

const CONTROLLER_HTTP_TIMEOUT_MS = 10_000;

/** The controller's HTTP base: ws://host/byoc/ws/<id> minus the `/ws/<id>` tail. */
export function controllerHttpBase(wsUrl: string): string {
  return wsUrl.replace(/^ws/, "http").replace(/\/ws\/[^/]*\/?$/, "");
}

/** Trade the join token for a device key, once. */
export async function registerDevice(httpBase: string, joinToken: string, log: (m: string) => void): Promise<void> {
  const key = generateDeviceKey();
  try {
    const res = await fetch(`${httpBase}/devices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ joinToken, publicKey: key.publicKeyPem, label: hostname() }),
      signal: AbortSignal.timeout(CONTROLLER_HTTP_TIMEOUT_MS),
    });
    if (res.ok) {
      const { deviceId } = (await res.json()) as { deviceId: string };
      await saveDeviceIdentity({ deviceId, ...key });
      log(`registered this device as ${deviceId} — future reconnects need no join token`);
    } else {
      log(`device registration failed (${res.status}); falling back to the join token`);
    }
  } catch (err) {
    log(`device registration unreachable (${String(err)}); falling back to the join token`);
  }
}

/** A fresh challenge nonce for a device-signed connect. */
export function challengeNonceFrom(httpBase: string): () => Promise<string> {
  return async () => {
    // A pooled connection can be dead without erroring.
    const r = await fetch(`${httpBase}/challenge`, { signal: AbortSignal.timeout(CONTROLLER_HTTP_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`challenge ${r.status}`);
    return ((await r.json()) as { nonce: string }).nonce;
  };
}

/**
 * The WS URL to dial, carrying whatever credential this container has: a registered
 * device signs a fresh server nonce, and a first-time container falls back to the join
 * token. Both travel as query params because the controller authorizes the upgrade
 * itself, before any message exists.
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
      // No challenge endpoint reachable: fall back to the join token for this attempt.
    }
  }
  if (deps.joinToken) url.searchParams.set("token", deps.joinToken);
  return url.toString();
}

/** The connect URL plus the link to resume. */
export function withLink(url: string, link: Link): string {
  const u = new URL(url);
  u.searchParams.set(LINK_ID_PARAM, link.id);
  u.searchParams.set(LINK_SEQ_PARAM, String(link.received));
  return u.toString();
}

/** Agent state for one link, outliving any single socket. */
interface AgentState {
  link: Link;
  dispatch(frame: WireFrame): void;
  /** Close every brain and fail its waiters. */
  teardown(): void;
}

export function runRemoteAgentClient(deps: RemoteAgentClientDeps): RemoteAgentClient {
  const log = deps.log ?? ((m: string) => console.log(`[remote-agent] ${m}`));
  let stopped = false;
  let attempt = 0;
  let ws: WebSocket | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));

  // Live sessions' skill dirs, which pruning must keep.
  const liveSkillDirs = new Set<string>();

  let state: AgentState | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  let droppedAt = 0;
  // Serialized so no frame overtakes a state rebuild.
  let inbound: Promise<void> = Promise.resolve();

  const endState = (why: string) => {
    clearTimeout(graceTimer);
    graceTimer = undefined;
    if (!state) return;
    log(`dropping agent sessions: ${why}`);
    state.teardown();
    state = undefined;
  };

  const createState = async (linkId: string): Promise<AgentState> => {
    const link = new Link(linkId);
    let dead = false;
    const frameCbs = new Set<(f: WireFrame) => void>();
    const send = (f: WireFrame) => {
      if (dead) return;
      link.send(f);
      // Disconnected with an unreplayable outbox: the state is lost.
      if (link.overflowed && !link.attached) {
        queueMicrotask(() => {
          if (state?.link === link) endState("outbox overflowed while disconnected");
        });
      }
    };

    // Permission answers route by unique frame id, so one shared waiter map serves every per-session client.
    const permissionWaiters = new Map<string, (ans: PermissionAnswer) => void>();

    /** Build one SDK-backed brain per ACP session, stamping its outbound frames with the session id (known only after newSession returns) so the relay can route concurrent conversations on one container. */
    const buildClient = async (
      model?: string,
      mcpServers?: Array<{ name?: string }>,
      skills?: ReadonlyArray<{ name: string; content: string }>,
      systemPrompt?: string,
    ) => {
      const stamp: { sid?: string } = {};
      const stampedSend = (f: WireFrame) => send(stamp.sid ? { ...f, sid: stamp.sid } : f);
      const exec = createTunnelExecBackend({
        send: stampedSend,
        onFrame: (cb) => {
          frameCbs.add(cb);
          return () => frameCbs.delete(cb);
        },
      });
      // Start a local proxy per offered MCP server (they live on the agent-host's loopback) and write the cloud-sent skills locally so the SDK discovers them.
      let skillCwd: string | undefined;
      if (skills?.length) {
        // Skills are an enhancement, so a write failure must not take the conversation down.
        try {
          const { mkdtempSync, mkdirSync } = await import("node:fs");
          const { join } = await import("node:path");
          // This image has no /tmp, so use the mounted config dir and create the parent.
          const parent = join(process.env.CLAUDE_CONFIG_DIR ?? "/root/.claude", "sessions");
          mkdirSync(parent, { recursive: true });
          // The volume is persistent, so keep only the most recent few session dirs.
          pruneSkillDirs(parent, 5, liveSkillDirs);
          skillCwd = mkdtempSync(join(parent, "skills-"));
          liveSkillDirs.add(skillCwd);
          const written = writeSkillPayloads(skillCwd, skills);
          log(`skills: wrote ${written} to ${skillCwd}/.claude/skills`);
        } catch (err) {
          skillCwd = undefined;
          log(`skills: NOT available (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      const offered = (mcpServers ?? []).filter((m): m is { name: string } => typeof m?.name === "string");
      const mcp = offered.length
        ? await startMcpProxies(offered, {
            send: stampedSend,
            onFrame: (cb) => {
              frameCbs.add(cb);
              return () => frameCbs.delete(cb);
            },
            sessionId: undefined, // set below once newSession returns (stamp.sid)
            trace: (m) => log(`mcp ${m}`),
          })
        : undefined;
      if (mcp) log(`MCP: ${mcp.servers.map((s) => s.name).join(", ")} proxied over the tunnel`);
      // The prompt carries the agent's identity AND its titling contract, so falling back to the
      // backend's stub is a silent feature loss worth one line in the container's log.
      const prompt = systemPrompt ?? deps.systemPrompt;
      log(
        prompt
          ? `system prompt: ${prompt.length} chars from ${systemPrompt ? "the cloud" : "this container"}`
          : "system prompt: NONE sent — running the backend's stub identity (no skills, no <title>)",
      );
      // The backend decides WHICH agent runs; every one returns the same AcpClient.
      const sdk = await selectBackend(deps.backend).create({
        oauthToken: deps.oauthToken,
        mcpServers: mcp?.servers.map((m) => ({ name: m.name, url: m.url })),
        // The per-session model sent by the cloud in new_session, then the container's --model flag.
        model: model ?? deps.model,
        exec,
        // The cloud's identity/behaviour prompt for this session (it owns the agent's persona and
        // its <title> contract), then the container's own override.
        systemPrompt: prompt,
        claudeCodePath: deps.claudeCodePath,
        // Without settingSources the SDK loads no filesystem settings, and without `skills` the Skill tool is left out of allowedTools.
        ...(skillCwd ? { cwd: skillCwd, settingSources: ["project" as const], skills: "all" as const } : {}),
        log: deps.log,
      });
      // Route the SDK's notifications up the wire, stamped.
      sdk.onSessionUpdate((sessionId, update) =>
        send({ ch: "acp", type: "session_update", sid: sessionId, payload: { sessionId, update } }));
      sdk.onTerminalCreated((terminalId, command, args) => stampedSend({ ch: "acp", type: "terminal_created", payload: { terminalId, command, args } }));
      sdk.onPermissionRequest((req) => {
        return new Promise<PermissionAnswer>((resolve) => {
          const id = req.toolCallId + ":" + Math.random().toString(36).slice(2);
          permissionWaiters.set(id, resolve);
          send({ ch: "acp", type: "permission_request", id, sid: req.sessionId, payload: { request: req } });
        });
      });
      return { sdk, stamp, closeMcp: mcp?.close };
    };

    // The primary client answers `initialize`, which precedes any session; every `new_session` gets its own client.
    const primary = await buildClient();
    const sdk = primary.sdk;
    const clients = new Map<string, { sdk: typeof primary.sdk; stamp: { sid?: string }; closeMcp?: () => Promise<void> }>();

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
            // The returned session id becomes both the routing key for later prompts and the sid stamped on this client's tool frames.
            const params = (frame.payload as {
              params?: {
                model?: string;
                mcpServers?: Array<{ name?: string }>;
                skills?: Array<{ name: string; content: string }>;
                systemPrompt?: string;
              };
            })?.params;
            const client = await buildClient(
              params?.model,
              params?.mcpServers,
              params?.skills,
              params?.systemPrompt,
            );
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
            // Log the prompt so it is provable from the outside that this container served the turn.
            const preview = (p.prompt ?? [])
              .map((b) => (typeof b?.text === "string" ? b.text : ""))
              .join(" ")
              .replace(/\s+/g, " ")
              .slice(0, 80);
            log(`prompt acp-session=${p.sessionId} text="${preview}"`);
            const started = Date.now();
            // A session id this instance never issued means the container restarted since the cloud established it; refusing lets the cloud re-establish the session here.
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
            // Cancelling a session this instance never issued is a no-op success.
            const sid = (frame.payload as { sessionId: string }).sessionId;
            await clients.get(sid)?.sdk.cancel(sid);
            return ack(frame.id, {});
          }
          case "kill_terminals": {
            // Killing terminals interrupts the session's query, so a scoped kill must leave the container's other conversations alone; unscoped is a legacy cloud.
            const sid = (frame.payload as { sessionId?: string } | undefined)?.sessionId;
            const targets = sid
              ? [clients.get(sid)?.sdk].filter((c) => c !== undefined)
              : [sdk, ...[...clients.values()].map((c) => c.sdk)];
            await Promise.all(targets.map((c) => c.killActiveTerminals().catch(() => {})));
            return ack(frame.id, {});
          }
          case "ack": {
            // A permission answer to our permission_request id; parsePermissionAnswer fails closed on anything unrecognised.
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


    return {
      link,
      dispatch(frame) {
        // Exec results and MCP replies go to the tunnel waiters.
        if (frame.ch === "exec" || frame.ch === "tunnel") {
          for (const cb of frameCbs) cb(frame);
          return;
        }
        // Channel A: drive the SDK.
        if (frame.ch === "acp") void handleAcp(frame);
      },
      teardown() {
        dead = true;
        link.dispose();
        // Cancel every parked permission, or the local SDK waits forever on an approval that can never arrive.
        for (const [id, waiter] of [...permissionWaiters]) {
          permissionWaiters.delete(id);
          waiter({ cancelled: true });
        }
        void sdk.close().catch(() => {});
        for (const c of clients.values()) {
          void c.sdk.close().catch(() => {});
          // A stale proxy pointing at a dead session would hang the SDK instead of failing it.
          void c.closeMcp?.().catch(() => {});
        }
        clients.clear();
      },
    };
  };

  const connect = async () => {
    if (stopped) return;
    state ??= await createState(randomUUID());
    const current = state;
    // The controller authorizes at the upgrade, so credentials ride on the URL.
    const connectUrl = withLink(await buildConnectUrl(deps), current.link);
    const sock = new WebSocket(connectUrl);
    ws = sock;
    const write = (raw: string) => sock.send(raw);

    // A path dying without FIN shows only as missing pings.
    const pingTimeoutMs = deps.pingTimeoutMs ?? PING_TIMEOUT_MS;
    let pingWatch: NodeJS.Timeout | undefined;
    const armPingWatch = () => {
      clearTimeout(pingWatch);
      pingWatch = setTimeout(() => {
        log(`no ping from the controller for ${pingTimeoutMs}ms; reconnecting`);
        sock.terminate();
      }, pingTimeoutMs);
    };
    sock.on("ping", armPingWatch);

    sock.on("open", () => {
      armPingWatch();
      attempt = 0; // a successful connect resets the backoff window
      // Grace expired while dialing, so this link id is stale.
      if (state !== current) {
        sock.terminate();
        return;
      }
      // Auth already happened at the upgrade; the hello only negotiates the protocol version.
      sock.send(JSON.stringify({ protocolVersion: REMOTE_PROTOCOL_VERSION, joinToken: deps.joinToken }));
      // Nothing to replay, so don't wait for the resume answer.
      if (!current.link.used) current.link.attach(write, 0);
    });

    /** Apply the resume answer; absent means a controller without links. */
    const handshake = async (resume: LinkResume | undefined) => {
      let s = state;
      if (!s || ws !== sock) return;
      clearTimeout(graceTimer);
      graceTimer = undefined;
      if (!resume) {
        if (s.link.used && !s.link.attached) {
          endState("the controller cannot resume links");
          s = state = await createState(randomUUID());
        }
        s.link.attachLegacy(write);
        return;
      }
      if (s.link.attached) return;
      if (resume.resumed) {
        s.link.attach(write, resume.seq);
        log(`link resumed after ${Date.now() - droppedAt}ms, replaying ${s.link.pending} frames`);
        return;
      }
      // The controller already failed this link's runs.
      endState("the controller could not resume the link");
      s = state = await createState(s.link.id);
      s.link.attach(write, 0);
    };

    const onFrame = async (frame: WireFrame) => {
      // Server confirmations.
      if (frame.type === "connected") {
        const payload = frame.payload as { owner?: string; link?: LinkResume } | undefined;
        log(`registered as owner ${payload?.owner ?? "?"} — ready`);
        await handshake(payload?.link);
        return;
      }
      const s = state;
      if (!s || ws !== sock || !s.link.receive(frame)) return;
      s.dispatch(frame);
    };

    sock.on("message", (data) => {
      let frame: WireFrame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      inbound = inbound.then(() => onFrame(frame)).catch((err) => log(`frame handling failed: ${String(err)}`));
    });

    // Set when the upgrade itself was rejected, so the meaningless 1006 close that follows terminate() takes the auth disposition.
    let upgradeAuthRejected = false;
    sock.on("close", (code, reasonBuf) => {
      clearTimeout(pingWatch);
      // The controller uses application close codes for conditions a container must react to differently than a network blip.
      const disposition = upgradeAuthRejected
        ? closeDisposition(4001, "rejected at the WebSocket upgrade (HTTP 401)", attempt + 1)
        : closeDisposition(code, reasonBuf?.toString() ?? "", attempt + 1);
      if (!upgradeAuthRejected) log(disposition.message ?? `disconnected (code ${code})`);
      const s = state;
      if (ws === sock) s?.link.detach();
      if (stopped) {
        endState("stopped");
        resolveClosed();
        return;
      }
      // Rejected or superseded: there is nothing to resume.
      if (upgradeAuthRejected || code === CLOSE_AUTH_REJECTED || code === CLOSE_SUPERSEDED) {
        endState(`closed with ${upgradeAuthRejected ? 4001 : code}`);
      } else if (s?.link.overflowed) {
        endState("outbox overflowed");
      } else if (s?.link.used && !graceTimer) {
        droppedAt = Date.now();
        log(`holding agent sessions for ${LINK_GRACE_MS}ms while reconnecting`);
        graceTimer = setTimeout(() => endState(`no reconnect within ${LINK_GRACE_MS}ms`), LINK_GRACE_MS);
      }
      // Exponential backoff with jitter (see reconnect.ts).
      attempt += 1;
      const delay = disposition.delayMs;
      log(`reconnecting in ${delay}ms (attempt ${attempt})`);
      setTimeout(() => void connect(), delay);
    });
    // A non-101 upgrade response, which the ws lib would otherwise surface as a generic error.
    sock.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 401) {
        upgradeAuthRejected = true;
        log(
          "AUTHENTICATION FAILED: the server rejected this container's credentials at the upgrade " +
            "(HTTP 401). This will not fix itself — get a fresh docker command from the Settings page.",
        );
      } else {
        log(`unexpected server response ${res.statusCode ?? "?"} during connect`);
      }
      // terminate() fires the close handler, which schedules the retry.
      sock.terminate();
    });
    sock.on("error", (e) => log(`ws error: ${(e as Error).message}`));
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
