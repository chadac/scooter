/**
 * Contract — the marimo client against a REAL fake marimo http.Server that emits
 * the exact /api/sessions JSON + /api/kernel/execute SSE frames verified from
 * marimo-pair. Highest-fidelity: exercises the real node:http path, headers, and
 * SSE fold — not a stubbed fetch.
 */

import { AddressInfo } from "node:net";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMarimoClient } from "./client.js";
import { MarimoError } from "./types.js";

/** A configurable fake marimo. `sessions` is the /api/sessions payload; `onExecute`
 *  returns the SSE body (and can assert the received headers/body). */
interface FakeOpts {
  sessions?: Record<string, { path?: string; filename?: string }>;
  sessionsStatus?: number;
  executeStatus?: number;
  onExecute?: (req: IncomingMessage, body: string, headers: Record<string, string | string[] | undefined>) => string;
}

function fakeMarimo(opts: FakeOpts = {}): Promise<{ server: Server; baseUrl: string; lastExec?: { sessionId?: string; code?: string } }> {
  const state: { lastExec?: { sessionId?: string; code?: string } } = {};
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === "/api/sessions") {
        res.writeHead(opts.sessionsStatus ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(opts.sessions ?? {}));
        return;
      }
      if (req.url === "/api/kernel/execute" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          state.lastExec = {
            sessionId: req.headers["marimo-session-id"] as string | undefined,
            code: (() => { try { return JSON.parse(body).code; } catch { return undefined; } })(),
          };
          const status = opts.executeStatus ?? 200;
          if (status !== 200) {
            res.writeHead(status, { "content-type": "text/plain" });
            res.end("boom");
            return;
          }
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(opts.onExecute ? opts.onExecute(req, body, req.headers) : doneOk("ok"));
        });
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ...state }),
    );
  });
}

const sse = (lines: string[]) => lines.join("\n");
const doneOk = (output: string) =>
  sse(["event: stdout", 'data: {"data":""}', "", "event: done", `data: {"success":true,"output":{"data":${JSON.stringify(output)}}}`, ""]);

describe("MarimoClient", () => {
  let fake: Awaited<ReturnType<typeof fakeMarimo>>;
  afterEach(() => fake?.server.close());

  describe("resolveSession", () => {
    it("returns the single open session", async () => {
      fake = await fakeMarimo({ sessions: { s1: { path: "/w/a.py" } } });
      const client = createMarimoClient({ baseUrl: fake.baseUrl });
      expect(await client.resolveSession()).toBe("s1");
    });

    it("throws no-session when none are open", async () => {
      fake = await fakeMarimo({ sessions: {} });
      const client = createMarimoClient({ baseUrl: fake.baseUrl });
      await expect(client.resolveSession()).rejects.toMatchObject({ kind: "no-session" });
    });

    it("throws multiple-sessions when >1 open and no file given", async () => {
      fake = await fakeMarimo({ sessions: { s1: { path: "/w/a.py" }, s2: { path: "/w/b.py" } } });
      const client = createMarimoClient({ baseUrl: fake.baseUrl });
      await expect(client.resolveSession()).rejects.toMatchObject({ kind: "multiple-sessions" });
    });

    it("targets a session by file when several are open", async () => {
      fake = await fakeMarimo({ sessions: { s1: { path: "/w/a.py" }, s2: { path: "/w/b.py" } } });
      const client = createMarimoClient({ baseUrl: fake.baseUrl });
      expect(await client.resolveSession({ file: "/w/b.py" })).toBe("s2");
    });

    it("an explicit sessionId short-circuits the lookup", async () => {
      fake = await fakeMarimo({ sessionsStatus: 500 /* would fail if hit */ });
      const client = createMarimoClient({ baseUrl: fake.baseUrl });
      expect(await client.resolveSession({ sessionId: "explicit" })).toBe("explicit");
    });
  });

  describe("execute", () => {
    it("runs code in the resolved session and folds the SSE result", async () => {
      fake = await fakeMarimo({
        sessions: { s1: {} },
        onExecute: () =>
          sse([
            "event: stdout",
            'data: {"data":"hi\\n"}',
            "",
            "event: done",
            'data: {"success":true,"output":{"data":"7"}}',
            "",
          ]),
      });
      const client = createMarimoClient({ baseUrl: fake.baseUrl });
      const r = await client.execute("print('hi'); 3+4");
      expect(r).toMatchObject({ success: true, stdout: "hi\n", output: "7" });
    });

    it("sends the Marimo-Session-Id header + {code} body", async () => {
      let seen: { sessionId?: string; code?: string } = {};
      fake = await fakeMarimo({
        sessions: { the_session: {} },
        onExecute: (_req, body, headers) => {
          seen = { sessionId: headers["marimo-session-id"] as string, code: JSON.parse(body).code };
          return doneOk("");
        },
      });
      const client = createMarimoClient({ baseUrl: fake.baseUrl });
      await client.execute("2+2");
      expect(seen).toEqual({ sessionId: "the_session", code: "2+2" });
    });

    it("surfaces a Python failure (success:false) without throwing", async () => {
      fake = await fakeMarimo({
        sessions: { s1: {} },
        onExecute: () =>
          sse(["event: stderr", 'data: {"data":"NameError\\n"}', "", "event: done", 'data: {"success":false,"output":{}}', ""]),
      });
      const client = createMarimoClient({ baseUrl: fake.baseUrl });
      const r = await client.execute("boom");
      expect(r.success).toBe(false);
      expect(r.stderr).toContain("NameError");
    });

    it("throws http-error on a non-200 execute", async () => {
      fake = await fakeMarimo({ sessions: { s1: {} }, executeStatus: 500 });
      const client = createMarimoClient({ baseUrl: fake.baseUrl });
      await expect(client.execute("x")).rejects.toMatchObject({ kind: "http-error" });
    });

    it("throws incomplete-stream when the stream has no done frame", async () => {
      fake = await fakeMarimo({
        sessions: { s1: {} },
        onExecute: () => sse(["event: stdout", 'data: {"data":"partial"}', ""]),
      });
      const client = createMarimoClient({ baseUrl: fake.baseUrl });
      await expect(client.execute("x")).rejects.toMatchObject({ kind: "incomplete-stream" });
    });
  });

  describe("listSessions", () => {
    it("returns the id->info map", async () => {
      fake = await fakeMarimo({ sessions: { s1: { path: "/w/a.py" } } });
      const client = createMarimoClient({ baseUrl: fake.baseUrl });
      expect(await client.listSessions()).toEqual({ s1: { path: "/w/a.py" } });
    });

    it("throws http-error on a non-200", async () => {
      fake = await fakeMarimo({ sessionsStatus: 503 });
      const client = createMarimoClient({ baseUrl: fake.baseUrl });
      await expect(client.listSessions()).rejects.toBeInstanceOf(MarimoError);
    });
  });

  it("rejects unreachable when the server is down", async () => {
    // Point at a closed port (start then immediately close).
    fake = await fakeMarimo({});
    const url = fake.baseUrl;
    await new Promise<void>((r) => fake.server.close(() => r()));
    const client = createMarimoClient({ baseUrl: url });
    await expect(client.listSessions()).rejects.toMatchObject({ kind: "unreachable" });
  });
});
