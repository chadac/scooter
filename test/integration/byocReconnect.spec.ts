// A BYO conversation across the three real services on localhost.
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startController, type RunningController } from "../../services/byoc-controller/src/shell.js";
import { createMemoryDeviceStore, createMemorySessionStore } from "../../services/byoc-controller/src/sessionStore.js";
import {
  challengeNonceFrom,
  controllerHttpBase,
  registerDevice,
  runRemoteAgentClient,
  type RemoteAgentClient,
} from "../../services/remote-agent/src/remoteAgentClient.js";
import "../../services/remote-agent/src/echoBackend.js";
import { createSessionBridge, type SessionBridge } from "../../services/agent-host/src/bridge.js";
import { createRemotePersonalizedProvider } from "../../services/agent-host/src/acp/remoteAgentRegistry.js";
import { createSandboxExecBackend } from "../../services/agent-host/src/exec/sandboxExec.js";
import { createFakeSandboxApi } from "../../services/agent-host/test/fakes/fakeSandboxApi.js";

const SECRET = "integration-secret";
const OWNER = "alice";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** TCP forwarder: `blackhole` drops, `stall` delays, `cut` closes. */
async function forwarder(targetPort: number) {
  const live = new Set<{ client: Socket; upstream: Socket; dead: boolean }>();
  // Bytes held during a stall, flushed in order after.
  let held: Array<() => void> | undefined;
  const relay = (fn: () => void) => (held ? held.push(fn) : fn());
  const server = createServer((client) => {
    const pair = { client, upstream: connect(targetPort, "127.0.0.1"), dead: false };
    live.add(pair);
    client.on("data", (d) => pair.dead || relay(() => pair.upstream.write(d)));
    pair.upstream.on("data", (d) => pair.dead || relay(() => client.write(d)));
    const end = () => {
      live.delete(pair);
      if (pair.dead) return; // a dead path reports nothing
      client.destroy();
      pair.upstream.destroy();
    };
    client.on("close", end).on("error", end);
    pair.upstream.on("close", end).on("error", end);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  cleanup.push(
    () =>
      new Promise<void>((r) => {
        for (const p of live) {
          p.client.destroy();
          p.upstream.destroy();
        }
        server.close(() => r());
      }),
  );
  return {
    url: `http://127.0.0.1:${port}`,
    blackhole() {
      for (const p of live) p.dead = true;
    },
    cut() {
      for (const p of live) {
        p.client.destroy();
        p.upstream.destroy();
      }
    },
    async stall(ms: number) {
      held = [];
      await new Promise((r) => setTimeout(r, ms));
      const queued = held;
      held = undefined;
      for (const fn of queued) fn();
    },
  };
}

/** A controller whose stores outlive it, like production's Postgres. */
function controllerHost() {
  const store = createMemorySessionStore();
  const deviceStore = createMemoryDeviceStore();
  let running: RunningController | undefined;
  const host = {
    port: 0,
    get url() {
      return `http://127.0.0.1:${host.port}`;
    },
    async start(opts: { sseHeartbeatMs?: number; wsPingMs?: number } = {}) {
      running = await startController({ port: host.port, secret: SECRET, store, deviceStore, ...opts });
      host.port = running.port;
    },
    async stop() {
      await running?.close();
      running = undefined;
    },
    async status(): Promise<string | undefined> {
      const res = await fetch(`${host.url}/byoc/status?owner=${OWNER}`).catch(() => undefined);
      return res?.ok ? ((await res.json()) as { status?: string }).status : undefined;
    },
  };
  cleanup.push(() => host.stop());
  return host;
}

/** The container, registered as a device like the Settings one-liner. */
async function joinContainer(controllerUrl: string, opts: { pingTimeoutMs?: number } = {}): Promise<RemoteAgentClient> {
  const keyDir = mkdtempSync(join(tmpdir(), "byoc-device-"));
  const prevKeyPath = process.env.SCOOTER_DEVICE_KEY_PATH;
  process.env.SCOOTER_DEVICE_KEY_PATH = join(keyDir, "device-key.json");
  cleanup.push(() => {
    if (prevKeyPath === undefined) delete process.env.SCOOTER_DEVICE_KEY_PATH;
    else process.env.SCOOTER_DEVICE_KEY_PATH = prevKeyPath;
    rmSync(keyDir, { recursive: true, force: true });
  });
  const minted = await fetch(`${controllerUrl}/byoc/sessions`, {
    method: "POST",
    headers: { "x-forwarded-user": OWNER },
  });
  const { sessionId, token } = (await minted.json()) as { sessionId: string; token: string };
  const url = `${controllerUrl.replace("http", "ws")}/byoc/ws/${sessionId}`;
  const log = (m: string) => console.log(`[remote-agent] ${m}`);
  await registerDevice(controllerHttpBase(url), token, log);
  const client = runRemoteAgentClient({
    url,
    joinToken: token,
    challengeNonce: challengeNonceFrom(controllerHttpBase(url)),
    backend: "echo",
    log,
    ...opts,
  });
  cleanup.push(() => client.stop());
  return client;
}

/** A conversation bridge whose only provider is the owner's container. */
function byoConversation(controllerUrl: string, streamIdleMs?: number) {
  const exec = createSandboxExecBackend(createFakeSandboxApi());
  const bridge: SessionBridge = createSessionBridge({
    config: {
      cwd: "/workspace",
      skillsDir: "/skills",
      agent: { command: "unused", args: [], env: {} },
      sandbox: { name: "s", namespace: "ns" },
    },
    exec,
    owner: OWNER,
    acpProviders: [createRemotePersonalizedProvider({ controllerUrl, exec, streamIdleMs })],
    deathRetryBaseMs: 100,
    deathRetryCapMs: 500,
  });
  cleanup.push(() => bridge.stop());
  let text = "";
  bridge.onEvent((e) => {
    const delta = (e as { delta?: unknown }).delta;
    if (typeof delta === "string") text += delta;
  });
  return { bridge, said: () => text };
}

describe("BYOC reconnect", () => {
  it("answers after the controller restarts mid-turn", async () => {
    const ctl = controllerHost();
    await ctl.start();
    await joinContainer(ctl.url);
    await until("the container to attach", async () => (await ctl.status()) === "connected");

    const convo = byoConversation(ctl.url);
    const interrupted = convo.bridge.prompt({ threadId: "t1", text: "~sleep 5" });
    await until("the long turn to start", () => convo.said().includes("sleeping"));

    // What production saw: the stream under a live turn breaks.
    await ctl.stop();
    await ctl.start();
    await until("the container to re-attach", async () => (await ctl.status()) === "connected");
    await interrupted.catch(() => {});

    await convo.bridge.prompt({ threadId: "t1", text: "after the restart" });
    await until("the reply over a fresh connection", () => convo.said().includes("echo: after the restart"));
  }, 60_000);

  it("keeps a quiet turn, and recovers one whose stream goes silent", async () => {
    const ctl = controllerHost();
    await ctl.start({ sseHeartbeatMs: 200 });
    await joinContainer(ctl.url);
    await until("the container to attach", async () => (await ctl.status()) === "connected");
    const path = await forwarder(ctl.port);
    const convo = byoConversation(path.url, 1_000);

    // Quiet 3s past a 1s idle window: heartbeats keep it.
    await convo.bridge.prompt({ threadId: "t1", text: "~sleep 3" });
    await until("the quiet turn to finish", () => convo.said().includes("slept 3s"));
    expect(convo.said().split("sleeping 3s").length - 1, "a quiet turn was retried as dead").toBe(1);

    const interrupted = convo.bridge.prompt({ threadId: "t1", text: "~sleep 5" });
    await until("the long turn to start", () => convo.said().includes("sleeping 5s"));
    path.blackhole();
    await interrupted.catch(() => {});

    await convo.bridge.prompt({ threadId: "t1", text: "after the silence" });
    await until("the reply over a fresh stream", () => convo.said().includes("echo: after the silence"));
  }, 60_000);

  it("reconnects a container whose path to the controller goes silent", async () => {
    const ctl = controllerHost();
    await ctl.start({ wsPingMs: 200 });
    const path = await forwarder(ctl.port);
    await joinContainer(path.url, { pingTimeoutMs: 1_000 });
    await until("the container to attach", async () => (await ctl.status()) === "connected");

    path.blackhole();
    // The controller drops its side; the container must redial.
    await until("the controller to drop the silent socket", async () => (await ctl.status()) !== "connected");
    await until("the container to re-attach", async () => (await ctl.status()) === "connected");

    const convo = byoConversation(ctl.url);
    await convo.bridge.prompt({ threadId: "t1", text: "after the redial" });
    await until("the reply", () => convo.said().includes("echo: after the redial"));
  }, 60_000);

  it("finishes a turn whose container socket drops and comes straight back", async () => {
    const ctl = controllerHost();
    await ctl.start();
    const path = await forwarder(ctl.port);
    await joinContainer(path.url);
    await until("the container to attach", async () => (await ctl.status()) === "connected");

    const convo = byoConversation(ctl.url);
    const turn = convo.bridge.prompt({ threadId: "t1", text: "~sleep 3" });
    await until("the turn to start", () => convo.said().includes("sleeping 3s"));
    path.cut();
    await until("the controller to see the drop", async () => (await ctl.status()) !== "connected");
    await until("the container to re-attach", async () => (await ctl.status()) === "connected");
    await turn;

    expect(convo.said()).toContain("slept 3s");
    expect(convo.said().split("sleeping 3s").length - 1, "the turn died and was retried").toBe(1);
  }, 60_000);

  it("rides out a pause longer than one ping interval without failing the turn", async () => {
    const ctl = controllerHost();
    await ctl.start({ wsPingMs: 200 });
    const path = await forwarder(ctl.port);
    await joinContainer(path.url, { pingTimeoutMs: 5_000 });
    await until("the container to attach", async () => (await ctl.status()) === "connected");

    const convo = byoConversation(ctl.url);
    const turn = convo.bridge.prompt({ threadId: "t1", text: "~sleep 2" });
    await until("the turn to start", () => convo.said().includes("sleeping 2s"));
    let dropped = false;
    const watch = setInterval(() => void ctl.status().then((s) => (dropped ||= s !== "connected")), 50);
    // Two missed pongs is jitter, not a dead container.
    await path.stall(450);
    await turn;
    clearInterval(watch);

    expect(convo.said()).toContain("slept 2s");
    expect(dropped, "the controller dropped a socket that was only slow").toBe(false);
  }, 60_000);
});
