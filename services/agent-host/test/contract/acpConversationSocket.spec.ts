import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";

import type { UserContext } from "../../src/auth/identity.js";
import { createAcpSocket } from "../../src/acp/conversationSocket.js";
import { createAccessCheck } from "../../src/session/access.js";
import type { SessionManager } from "../../src/session/manager.js";

const ID = "5a515e73-860b-49ba-bc3f-6ff8d5fda5ff";
const OWNER: UserContext = { id: "owner", anonymous: false };
const STRANGER: UserContext = { id: "stranger", anonymous: false };

let server: Server | undefined;
afterEach(() => server?.close());

/** A real HTTP server with only the ACP socket on it; the caller is `x-test-user`. */
async function serve(opts: { visibility: "shared" | "private"; sandboxDomain?: string; parentId?: string }) {
  const conv = { id: ID, threadId: ID, owner: OWNER.id, visibility: opts.visibility, parentId: opts.parentId };
  const sessions = {
    get: (id: string) => (id === ID ? conv : undefined),
    getBySandboxKey: async () => undefined,
    ensureReadable: async () => false,
  } as unknown as SessionManager;
  const users: Record<string, UserContext> = { owner: OWNER, stranger: STRANGER };
  const acp = createAcpSocket({
    sessions,
    events: { async *readEventsWithChecksum() {}, onAppend: () => () => {} },
    resolveUser: (req: IncomingMessage) => users[String(req.headers["x-test-user"])] ?? { id: "anonymous", anonymous: true },
    accessCheck: createAccessCheck({ memory: (id) => (id === ID ? { owner: conv.owner, visibility: conv.visibility } : undefined) }),
    answerInterrupt: async () => ({ ok: true }),
    sandboxDomain: opts.sandboxDomain,
  });
  server = createServer();
  server.on("upgrade", (req, socket, head) => {
    if (acp.matches(new URL(req.url ?? "/", "http://x").pathname)) void acp.handleUpgrade(req, socket, head);
    else socket.destroy();
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

/** Connect and run `initialize`; the HTTP status on refusal, else "ok". */
function connect(port: number, headers: Record<string, string>): Promise<number | "ok"> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/c/${ID}/_scooter/acp`, { headers });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("error", () => resolve(0));
    ws.on("open", () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }) + "\n"));
    ws.on("message", (d) => {
      const msg = JSON.parse(String(d));
      ws.close();
      resolve(msg.id === 1 && msg.result?.protocolVersion === 1 ? "ok" : 0);
    });
  });
}

const sameSite = { host: "scooter.test", origin: "https://scooter.test" };

describe("ACP socket access", () => {
  it("the owner can open their private conversation", async () => {
    const port = await serve({ visibility: "private" });
    expect(await connect(port, { ...sameSite, "x-test-user": "owner" })).toBe("ok");
  });

  it("anyone signed in can open a shared one; nobody else gets a private one", async () => {
    expect(await connect(await serve({ visibility: "shared" }), { ...sameSite, "x-test-user": "stranger" })).toBe("ok");
    server?.close();
    expect(await connect(await serve({ visibility: "private" }), { ...sameSite, "x-test-user": "stranger" })).toBe(404);
  });

  it("refuses another site's page, even for the owner", async () => {
    const port = await serve({ visibility: "private" });
    expect(await connect(port, { host: "scooter.test", origin: "https://evil.test", "x-test-user": "owner" })).toBe(403);
  });

  it("with sandbox hosts on, serves only the conversation's own host", async () => {
    const port = await serve({ visibility: "private", sandboxDomain: "sbx.test" });
    const host = { host: "5a515e73.sbx.test", origin: "https://5a515e73.sbx.test", "x-test-user": "owner" };
    expect(await connect(port, { ...sameSite, "x-test-user": "owner" })).toBe(404);
    expect(await connect(port, { ...host, "x-scooter-sandbox-host": "5a515e73" })).toBe("ok");
    expect(await connect(port, { ...host, "x-scooter-sandbox-host": "0badf00d" })).toBe(404);
  });

  it("a subagent has no socket of its own", async () => {
    const port = await serve({ visibility: "private", parentId: "root" });
    expect(await connect(port, { ...sameSite, "x-test-user": "owner" })).toBe(404);
  });
});
