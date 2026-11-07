/**
 * The network shell's two listeners: the public one the ingress targets serves only the
 * container's routes and ignores identity headers; the internal one serves everything.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { startController, type RunningController } from "../src/shell.js";
import { createMemorySessionStore, createMemoryDeviceStore } from "../src/sessionStore.js";

describe("controller listeners", () => {
  let ctl: RunningController;
  const at = (port: number, path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
  const mint = (port: number) =>
    at(port, "/byoc/sessions", { method: "POST", headers: { "x-auth-request-user": "alice" } });

  beforeAll(async () => {
    ctl = await startController({
      port: 0,
      publicPort: 0,
      secret: "test-secret",
      store: createMemorySessionStore(),
      deviceStore: createMemoryDeviceStore(),
    });
  });
  afterAll(() => ctl.close());

  it("the public listener refuses a mint, whatever identity header it carries", async () => {
    expect((await mint(ctl.publicPort!)).status).toBe(404);
    const status = await at(ctl.publicPort!, "/byoc/status?owner=alice");
    expect(status.status).toBe(404);
  });

  it("the public listener serves the challenge and health check", async () => {
    expect((await at(ctl.publicPort!, "/byoc/challenge")).status).toBe(200);
    expect((await at(ctl.publicPort!, "/healthz")).status).toBe(200);
  });

  it("the internal listener mints for the named user", async () => {
    const res = await mint(ctl.port);
    expect(res.status).toBe(200);
    const { sessionId } = (await res.json()) as { sessionId: string };
    const status = (await (await at(ctl.port, "/byoc/status?owner=alice")).json()) as { sessionId: string };
    expect(status.sessionId).toBe(sessionId);
  });
});
