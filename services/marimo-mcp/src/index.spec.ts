/** Contract — the MCP registration: the tools show up on the server and dispatch to
 *  the handlers. Drives the real McpServer via an in-memory client/server transport
 *  pair, against a fake marimo http.Server. */

import { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMarimoMcpServer } from "./index.js";

const doneOk = (output: string) =>
  ["event: stdout", 'data: {"data":""}', "", "event: done", `data: {"success":true,"output":{"data":${JSON.stringify(output)}}}`, ""].join("\n");

function fakeMarimo(sessions: Record<string, unknown>, exec: () => string): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === "/api/sessions") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(sessions));
      } else if (req.url === "/api/kernel/execute") {
        let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res.writeHead(200).end(exec()));
      } else res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

async function connectedClient(baseUrl: string): Promise<Client> {
  const server = createMarimoMcpServer({ baseUrl });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return client;
}

describe("marimo MCP server", () => {
  let fake: Awaited<ReturnType<typeof fakeMarimo>>;
  afterEach(() => fake?.server.close());

  it("exposes the notebook tools", async () => {
    fake = await fakeMarimo({ s1: {} }, () => doneOk(""));
    const client = await connectedClient(fake.baseUrl);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "marimo_create_cell",
      "marimo_embed",
      "marimo_execute",
      "marimo_install",
      "marimo_list_cells",
      "marimo_list_sessions",
      "marimo_run_cell",
    ]);
  });

  it("marimo_execute runs end-to-end through the server against a fake marimo", async () => {
    fake = await fakeMarimo({ s1: {} }, () => doneOk("42"));
    const client = await connectedClient(fake.baseUrl);
    const res = await client.callTool({ name: "marimo_execute", arguments: { code: "6*7" } });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("=> 42");
    expect(res.isError).toBeFalsy();
  });

  it("marimo_list_sessions lists the open notebook", async () => {
    fake = await fakeMarimo({ sess_a: { path: "/w/n.py" } }, () => doneOk(""));
    const client = await connectedClient(fake.baseUrl);
    const res = await client.callTool({ name: "marimo_list_sessions", arguments: {} });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("sess_a");
    expect(text).toContain("/w/n.py");
  });

  it("surfaces a no-session error as an isError result", async () => {
    fake = await fakeMarimo({}, () => doneOk("")); // no open sessions
    const client = await connectedClient(fake.baseUrl);
    const res = await client.callTool({ name: "marimo_execute", arguments: { code: "1" } });
    expect(res.isError).toBe(true);
  });
});
