/**
 * Tier 1 contract — the /remote-agent/connect handshake: a real WS server (noServer) driven by a
 * real `ws` client, asserting a valid join token registers the owner + a bad one is rejected. This
 * is the cloud endpoint the BYO container dials. See remoteAgentConnect.ts.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";

import { createRemoteAgentConnectHandler } from "../../src/acp/remoteAgentConnect.js";
import { createRemoteAgentRegistry } from "../../src/acp/remoteAgentRegistry.js";
import { mintJoinToken } from "../../src/auth/remoteAgentToken.js";
import { REMOTE_PROTOCOL_VERSION } from "../../src/acp/remoteProtocol.js";

const SECRET = "connect-test-secret";

let server: Server | undefined;
const openClients = new Set<WebSocket>();
afterEach(async () => {
  // Force-close any lingering client sockets so server.close() doesn't wait on a live WS.
  for (const ws of openClients) ws.terminate();
  openClients.clear();
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

/** Stand up an http server with the connect handler on /remote-agent/connect; return its port +
 *  the registry it writes to. */
async function standUp() {
  const registry = createRemoteAgentRegistry();
  const handler = createRemoteAgentConnectHandler({ registry, joinSecret: SECRET });
  server = createServer();
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://x").pathname === "/remote-agent/connect") handler(req, socket, head);
    else socket.destroy();
  });
  const port = await new Promise<number>((resolve) => {
    server!.listen(0, () => {
      const a = server!.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
  return { registry, port };
}

/** Dial the endpoint, send a hello, and resolve with the first message received (or a close code). */
function dial(port: number, hello: unknown): Promise<{ msg?: unknown; closeCode?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/remote-agent/connect`);
    openClients.add(ws);
    ws.on("open", () => ws.send(JSON.stringify(hello)));
    ws.on("message", (d) => resolve({ msg: JSON.parse(d.toString()) }));
    ws.on("close", (code) => resolve({ closeCode: code }));
  });
}

describe("/remote-agent/connect handshake", () => {
  it("registers the owner on a valid hello (protocol + join token) and confirms connected", async () => {
    const { registry, port } = await standUp();
    const token = mintJoinToken("alice", SECRET);
    const r = await dial(port, { protocolVersion: REMOTE_PROTOCOL_VERSION, joinToken: token });
    expect(r.msg).toMatchObject({ type: "connected", payload: { owner: "alice" } });
    // A brief tick for the register() to land, then assert alice is routable.
    await new Promise((x) => setTimeout(x, 10));
    expect(registry.has("alice")).toBe(true);
  });

  it("rejects a bad join token (closes, does not register)", async () => {
    const { registry, port } = await standUp();
    const r = await dial(port, { protocolVersion: REMOTE_PROTOCOL_VERSION, joinToken: "garbage" });
    expect(r.closeCode).toBe(4004); // auth failure
    expect(registry.has("alice")).toBe(false);
  });

  it("rejects a protocol-version mismatch", async () => {
    const { port } = await standUp();
    const token = mintJoinToken("alice", SECRET);
    const r = await dial(port, { protocolVersion: 999, joinToken: token });
    expect(r.closeCode).toBe(4003);
  });
});
