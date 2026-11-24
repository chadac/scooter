/** A rejected k8s exec becomes an Error whose message carries the Status, never `[object Object]`. */

import net from "node:net";
import http from "node:http";
import https from "node:https";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { K8sExecError, boundAgentConnect, openExecWithRetry, toExecError } from "../../src/exec/k8sExec.js";

/** How client-node rejects a refused ws upgrade. */
const refused = (code: number) => ({ error: new Error(`Unexpected server response: ${code}`) });

/** How a failed TCP connect, e.g. a dropped SYN, arrives. */
const connectFailed = (code: string) => ({
  error: Object.assign(new Error(`connect ${code} 10.43.0.1:443`), { code, syscall: "connect" }),
});

describe("toExecError", () => {
  it("serializes a bare k8s Status", () => {
    const e = toExecError({
      kind: "Status",
      status: "Failure",
      reason: "NotFound",
      message: 'pods "conv-abc" not found',
      code: 404,
    });
    expect(e).toBeInstanceOf(K8sExecError);
    expect(e.message).toBe('k8s exec failed: NotFound: pods "conv-abc" not found (code 404)');
    expect(e.status?.code).toBe(404);
    expect(String(e)).not.toContain("[object Object]");
  });

  it("reads the Status out of an ApiException body, JSON or parsed", () => {
    const body = { kind: "Status", status: "Failure", reason: "Forbidden", message: "nope", code: 403 };
    expect(toExecError({ body: JSON.stringify(body) }).message).toContain("Forbidden: nope (code 403)");
    expect(toExecError(Object.assign(new Error("HTTP 403"), { body })).message).toContain("Forbidden: nope");
  });

  it("unwraps a ws ErrorEvent and keeps the close frame", () => {
    const e = toExecError({ error: new Error("socket hang up") }, { code: 1006, reason: "" });
    expect(e.message).toBe("k8s exec failed: socket hang up (ws close 1006)");
  });

  it("never prints [object Object] for an opaque value", () => {
    expect(toExecError({ weird: { nested: 1 } }).message).toBe('k8s exec failed: {"weird":{"nested":1}}');
    expect(toExecError({}).message).toBe("k8s exec failed: no error detail");
  });

  it("exposes a refused upgrade's HTTP status", () => {
    expect(toExecError(refused(404)).httpStatus).toBe(404);
    expect(toExecError({ error: new Error("socket hang up") }).httpStatus).toBeUndefined();
  });
});

describe("openExecWithRetry", () => {
  const noSleep = async () => {};

  it("retries a 5xx upgrade until it opens", async () => {
    let calls = 0;
    const ws = await openExecWithRetry(async () => {
      if (++calls < 3) throw refused(500);
      return "ws";
    }, noSleep);
    expect(ws).toBe("ws");
    expect(calls).toBe(3);
  });

  it("gives up on a 5xx after three attempts", async () => {
    let calls = 0;
    const p = openExecWithRetry(async () => {
      calls++;
      throw refused(500);
    }, noSleep);
    await expect(p).rejects.toMatchObject({ httpStatus: 500 });
    expect(calls).toBe(3);
  });

  it("does not retry a 404, the pod is gone", async () => {
    let calls = 0;
    const p = openExecWithRetry(async () => {
      calls++;
      throw refused(404);
    }, noSleep);
    await expect(p).rejects.toMatchObject({ httpStatus: 404 });
    expect(calls).toBe(1);
  });

  it("retries a connect that timed out, then opens", async () => {
    let calls = 0;
    const ws = await openExecWithRetry(async () => {
      if (++calls === 1) throw connectFailed("ETIMEDOUT");
      return "ws";
    }, noSleep);
    expect(ws).toBe("ws");
    expect(calls).toBe(2);
  });

  it("retries a refused connect", async () => {
    let calls = 0;
    const ws = await openExecWithRetry(async () => {
      if (++calls === 1) throw connectFailed("ECONNREFUSED");
      return "ws";
    }, noSleep);
    expect(ws).toBe("ws");
  });

  it("does not retry a reset after connect, the command may have started", async () => {
    let calls = 0;
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", syscall: "read" });
    const p = openExecWithRetry(async () => {
      calls++;
      throw { error: reset };
    }, noSleep);
    await expect(p).rejects.toThrow("read ECONNRESET");
    expect(calls).toBe(1);
  });
});

describe("boundAgentConnect", () => {
  // Accepts TCP but never answers, like a stuck API server.
  let server: net.Server;
  let port: number;
  const accepted: net.Socket[] = [];
  beforeEach(async () => {
    server = net.createServer((s) => accepted.push(s));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as net.AddressInfo).port;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const s of accepted.splice(0)) s.destroy();
    await new Promise((r) => server.close(r));
  });

  it("fails an unanswered TLS connect as a retryable connect ETIMEDOUT", async () => {
    const agent = new https.Agent();
    boundAgentConnect(agent, 5_000);
    const req = https.request({ host: "127.0.0.1", port, agent });
    const failed = new Promise<NodeJS.ErrnoException>((r) => req.once("error", r));
    req.end();
    vi.advanceTimersByTime(5_000);
    const err = await failed;
    expect(err).toMatchObject({ code: "ETIMEDOUT", syscall: "connect" });
    let calls = 0;
    const open = async () => (++calls === 1 ? Promise.reject({ error: err }) : "ws");
    await expect(openExecWithRetry(open, async () => {})).resolves.toBe("ws");
  });

  it("leaves a connected socket alone", async () => {
    const agent = new http.Agent();
    boundAgentConnect(agent, 5_000);
    const req = http.request({ host: "127.0.0.1", port, agent });
    req.on("error", () => {});
    req.end();
    const sock = await new Promise<net.Socket>((r) => req.once("socket", (s) => s.once("connect", () => r(s))));
    vi.advanceTimersByTime(60_000);
    expect(sock.destroyed).toBe(false);
    req.destroy();
  });

  it("leaves proxy agents alone, their sockets arrive connected", () => {
    class ProxyAgent extends https.Agent {}
    const agent = new ProxyAgent();
    const before = (agent as unknown as { createConnection: unknown }).createConnection;
    boundAgentConnect(agent);
    expect((agent as unknown as { createConnection: unknown }).createConnection).toBe(before);
  });
});
