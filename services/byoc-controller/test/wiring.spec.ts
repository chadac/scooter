/**
 * Tier 1: the entrypoint's composition, asserted on index.ts's source because importing it
 * would start a real HTTP server and open a Postgres pool. Every other test builds its own
 * server, so only this one proves production's wiring; each property is a single grep-able
 * fact rather than a whole-file snapshot.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The entrypoint plus the network shell it starts.
const SRC = ["index.ts", "shell.ts"]
  .map((f) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", f), "utf8"))
  .join("\n");

describe("controller entrypoint wiring", () => {
  it("constructs deviceAuth", () => {
    // Without it /byoc/devices answers "device auth not enabled" and a device can never register.
    expect(SRC).toMatch(/createDeviceAuth\s*\(/);
  });

  it("PASSES devices into createServer — not just constructs it", () => {
    // The server can be built without `devices` and still start, listen and serve the run path.
    const call = SRC.match(/createServer\s*\(\{[^}]*\}\)/s);
    expect(call, "createServer(...) call not found").toBeTruthy();
    expect(call![0]).toMatch(/\bdevices\b/);
  });

  it("builds a device store (durable when a DSN exists, in-memory otherwise)", () => {
    expect(SRC).toMatch(/createPgDeviceStore/);
    expect(SRC).toMatch(/createMemoryDeviceStore/);
  });

  it("accepts a device signature on the WS upgrade, not only a join token", () => {
    // Without this a registered container still has to present a join token.
    expect(SRC).toMatch(/authorizeDevice/);
  });

  it("attaches an authenticated container WITHOUT re-verifying a join token", () => {
    // registry.attach() re-verifies the token, which a device-authenticated container does not have.
    expect(SRC).toMatch(/attachAuthenticated/);
  });

  it("CONFIRMS an attach to the container (the `connected` frame)", () => {
    // The client waits for this frame before logging ready.
    expect(SRC).toMatch(/"connected"/);
  });

  it("closes a rejected attach WITH a code + reason, never bare", () => {
    // A bare ws.close() reaches the client as an opaque 1005 with nothing saying why.
    expect(SRC).toMatch(/ws\.close\(4\d{3}/);
  });

  it("wires the relay to the session ACTUALLY attached, not the URL's", () => {
    // A device re-attach can land on a different session than the stale URL id.
    expect(SRC).toMatch(/liveSessionId/);
  });

  it("starts the public listener from PUBLIC_PORT", () => {
    // Without it the ingress-facing port is never opened and containers cannot connect.
    expect(SRC).toMatch(/publicPort:\s*PUBLIC_PORT/);
  });

  it("refuses to start without a signing key", () => {
    // A controller with no BYOC_JOIN_SECRET would accept unsigned junk.
    expect(SRC).toMatch(/BYOC_JOIN_SECRET/);
    expect(SRC).toMatch(/process\.exit\(1\)/);
  });

  it("assembles the DSN from DB parts (the platform writes `password`, never a `dsn` key)", () => {
    // The platform's secret carries only a password.
    expect(SRC).toMatch(/DB_HOST/);
    expect(SRC).toMatch(/DB_PASSWORD/);
  });

  it("closes both stores on shutdown", () => {
    expect(SRC).toMatch(/store\.close\(\)/);
    expect(SRC).toMatch(/deviceStore\.close\(\)/);
  });
});
