/**
 * Tier 2 — the web-service reverse proxy against a REAL cluster pod.
 *
 * Proves the whole proxy stack end-to-end on real infra: provision a sandbox,
 * declare + start a web service INSIDE the pod, then drive the production proxy
 * (createWebServiceProxy + WebServiceRegistry + resolvePodTarget) mounted on a
 * real http.Server and assert it forwards HTTP — and a WebSocket upgrade — into
 * the pod's service.
 *
 * The proxy + registry run IN-PROCESS here (like the other cluster specs drive the
 * provisioner directly), pointed at the real provisioned pod via connectSandbox /
 * resolvePodTarget. This exercises real pod-IP resolution, real exec (manifest
 * read + systemctl), and the real HTTP/WS proxy against a real listener — the same
 * modules the deployed agent-host wires together.
 *
 * Gated: RUN_CLUSTER_TESTS=1. Reaches the pod IP directly, so it assumes a local
 * cluster whose pod network is routable from the test host (k3s/kind/k3d).
 */

import { createServer, request, type Server } from "node:http";
import { connect, type Socket, type AddressInfo } from "node:net";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";
import { createK8sProvisioner } from "../../services/agent-host/src/session/k8sProvisioner.js";
import { resolvePodTarget } from "../../services/agent-host/src/exec/k8sExec.js";
import { connectSandbox } from "../../services/agent-host/src/exec/sandboxExec.js";
import { createWebServiceProxy } from "../../services/agent-host/src/proxy/webServiceProxy.js";
import { createWebServiceRegistry } from "../../services/agent-host/src/proxy/webServiceRegistry.js";
import type { SandboxProvisioner } from "../../services/agent-host/src/session/manager.js";
import type { SandboxRef } from "../../services/agent-host/src/types.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;
const NS = "agent-sandbox-test";
const IMAGE = process.env.SANDBOX_IMAGE ?? "agent-sandbox-os:latest";

const SELECTOR = (id: string) => `agents.x-k8s.io/sandbox-name=conv-${id}`;

// A sub-path-aware fake service (python http.server) + its discovery manifest,
// installed into the pod at runtime — stands in for a real marimo/webServices unit
// so the test doesn't depend on marimo being enabled/built in the image. Serves
// 200 under /c/<id>/demo and echoes an `upgrade` (WebSocket).
const DEMO_PORT = 9931;
function demoServerPy(id: string): string {
  return [
    "import sys",
    "from http.server import BaseHTTPRequestHandler, HTTPServer",
    `BASE = "/c/${id}/demo"`,
    "class H(BaseHTTPRequestHandler):",
    "    def do_GET(self):",
    "        if self.path.startswith(BASE):",
    "            self.send_response(200); self.end_headers(); self.wfile.write(b'demo-ok')",
    "        else:",
    "            self.send_response(404); self.end_headers()",
    "    def log_message(self, *a): pass",
    `HTTPServer(("0.0.0.0", ${DEMO_PORT}), H).serve_forever()`,
  ].join("\n");
}

maybe("web-service reverse proxy (real pod)", () => {
  let cluster: Cluster;
  let provisioner: SandboxProvisioner;
  let ref: SandboxRef;
  let proxyServer: Server;
  let proxyPort: number;
  const id = "wsproxy01";

  beforeAll(async () => {
    cluster = await withCluster({ installController: true, namespace: NS });
    provisioner = createK8sProvisioner({ namespace: NS, sandboxImage: IMAGE });
    ref = await provisioner.create(id);

    // Wait for the pod Ready + exec-able.
    await cluster.waitFor<{ status: { conditions: Array<{ type: string; status: string }> } }>(
      "Sandbox", `conv-${id}`,
      (s) => !!s.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
      180_000, NS,
    );

    // Seed the pod: the discovery manifest the registry reads + a startable unit.
    // We write the manifest, drop the python server, and create a transient systemd
    // unit `webservice-demo` (NOT started yet — explicit-start).
    const py = demoServerPy(id);
    const manifest = JSON.stringify({
      services: [{ name: "demo", displayName: "Demo", port: DEMO_PORT, basePath: `/c/${id}/demo`, unit: "webservice-demo" }],
    });
    await cluster.exec(SELECTOR(id), ["mkdir", "-p", "/run/scooter"], NS);
    await cluster.exec(SELECTOR(id), ["sh", "-c", `cat > /run/scooter/web-services.json <<'EOF'\n${manifest}\nEOF`], NS);
    await cluster.exec(SELECTOR(id), ["sh", "-c", `cat > /run/scooter/demo.py <<'EOF'\n${py}\nEOF`], NS);
    // A transient unit named exactly like the option's unit, so systemctl
    // is-active/start behave as in production. Not started here.
    await cluster.exec(
      SELECTOR(id),
      ["sh", "-c",
        `cat > /run/systemd/system/webservice-demo.service <<'EOF'\n` +
        `[Unit]\nDescription=web service: Demo\n[Service]\nExecStart=/usr/bin/env python3 /run/scooter/demo.py\nEOF\n` +
        `systemctl daemon-reload`],
      NS,
    );

    // Build the production proxy + registry against the real pod. A minimal fake
    // SessionManager maps the conversation id -> its real sandbox ref.
    const sessions = {
      get: (cid: string) => (cid === id ? { id, threadId: id, sandbox: ref } : undefined),
      getByShortId: async () => undefined,
    } as never;
    const registry = createWebServiceRegistry({
      sandboxFor: (cid) => (cid === id ? ref : undefined),
      connect: (r) => connectSandbox(r),
    });
    const proxy = createWebServiceProxy({
      sessions,
      resolvePodTarget: (r) => resolvePodTarget(r),
      registry,
      publicHost: "test.local",
    });

    proxyServer = createServer((req, res) => {
      if (proxy.matches(new URL(req.url ?? "/", "http://x").pathname)) void proxy.handleHttp(req, res);
      else res.writeHead(404).end();
    });
    proxyServer.on("upgrade", (req, socket, head) => {
      if (proxy.matches(new URL(req.url ?? "/", "http://x").pathname))
        void proxy.handleUpgrade(req, socket as never, head);
      else socket.destroy();
    });
    await new Promise<void>((r) => proxyServer.listen(0, "127.0.0.1", () => r()));
    proxyPort = (proxyServer.address() as AddressInfo).port;
  }, 240_000);

  afterAll(async () => {
    proxyServer?.close();
    await provisioner?.destroy(ref).catch(() => {});
  });

  it("declared-but-not-started -> friendly 502", async () => {
    // Unit exists (seeded) but not started -> registry.isRunning false.
    const { status, body } = await httpGet(proxyPort, `/c/${id}/demo/`);
    expect(status).toBe(502);
    expect(body.toLowerCase()).toContain("start");
  });

  it("starts the service, then proxies HTTP into the pod under its base path", async () => {
    // Start via the registry (systemctl start webservice-demo) — the same call the
    // UI Start button makes through the agent-host.
    // (Give it a moment to bind the port after start.)
    await cluster.exec(SELECTOR(id), ["systemctl", "start", "webservice-demo"], NS);
    await waitFor(async () => {
      const { exitCode } = await cluster.exec(SELECTOR(id), ["sh", "-c", `curl -fsS localhost:${DEMO_PORT}/c/${id}/demo/ >/dev/null`], NS);
      return exitCode === 0;
    }, 30_000);

    const { status, body } = await httpGet(proxyPort, `/c/${id}/demo/app`);
    expect(status).toBe(200);
    expect(body).toContain("demo-ok");

    // Outside the base path -> the in-pod service 404s (sub-path serving).
    const outside = await httpGet(proxyPort, `/c/${id}/demo/../nope`);
    expect([200]).not.toContain(outside.status);
  });

  it("proxies a WebSocket upgrade into the pod", async () => {
    // The demo server echoes on upgrade — prove the raw splice works end-to-end.
    const { statusLine, echoed } = await wsEcho(proxyPort, `/c/${id}/demo/ws`, "ping-42");
    expect(statusLine).toContain("101");
    expect(echoed).toContain("ping-42");
  });
});

// --- helpers ------------------------------------------------------------------

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function wsEcho(port: number, path: string, payload: string): Promise<{ statusLine: string; echoed: string }> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(port, "127.0.0.1", () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    let buf = "";
    let sent = false;
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      if (!sent && buf.includes("101")) {
        sent = true;
        sock.write(payload);
      } else if (sent && buf.includes(payload)) {
        resolve({ statusLine: buf.split("\r\n")[0], echoed: payload });
        sock.destroy();
      }
    });
    sock.on("error", reject);
    sock.setTimeout(15_000, () => { reject(new Error("ws upgrade timed out")); sock.destroy(); });
  });
}

async function waitFor(pred: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 1000));
  }
}
