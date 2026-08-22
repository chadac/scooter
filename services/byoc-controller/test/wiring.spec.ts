/**
 * Tier 1 — the ENTRYPOINT's composition (not the components).
 *
 * WHY THIS FILE EXISTS. Every other test in this service builds its own server:
 *
 *     createServer({ registry, relay, secret, devices })
 *
 * which proves the feature works GIVEN correct wiring. Nothing checked that index.ts actually
 * passes `devices` — and it did not. All 69 tests passed while the deployed controller answered
 * every registration with `{"error":"device auth not enabled"}`, because the single composition
 * production uses was the only one with no coverage.
 *
 * So this asserts on index.ts's SOURCE. That is unusual, and deliberate: importing index.ts would
 * start a real HTTP server and open a Postgres pool, which is not something a unit test should do.
 * The properties below are exactly the ones whose absence produced a silently non-functional
 * deployment, and each is a single grep-able fact rather than a brittle whole-file snapshot.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts"),
  "utf8",
);

describe("controller entrypoint wiring", () => {
  it("constructs deviceAuth", () => {
    // Absent => /byoc/devices answers "device auth not enabled" and a laptop can never register,
    // so §P's whole reconnect-after-sleep story silently does not exist.
    expect(SRC).toMatch(/createDeviceAuth\s*\(/);
  });

  it("PASSES devices into createServer — not just constructs it", () => {
    // The failure mode was subtler than "forgot to import": the server can be built without
    // `devices` and everything still starts, listens, and serves the run path.
    const call = SRC.match(/createServer\s*\(\{[^}]*\}\)/s);
    expect(call, "createServer(...) call not found").toBeTruthy();
    expect(call![0]).toMatch(/\bdevices\b/);
  });

  it("builds a device store (durable when a DSN exists, in-memory otherwise)", () => {
    expect(SRC).toMatch(/createPgDeviceStore/);
    expect(SRC).toMatch(/createMemoryDeviceStore/);
  });

  it("accepts a device signature on the WS upgrade, not only a join token", () => {
    // Without this a REGISTERED container still has to present a join token, which is precisely
    // the 10-minute expiry §P removes.
    expect(SRC).toMatch(/authorizeDevice/);
  });

  it("attaches an authenticated container WITHOUT re-verifying a join token", () => {
    // registry.attach() re-verifies the token; a device-authenticated container has none, so using
    // it here would reject the very reconnect this feature exists to enable.
    expect(SRC).toMatch(/attachAuthenticated/);
  });

  it("CONFIRMS an attach to the container (the `connected` frame)", () => {
    // Absent => the client's "registered as owner … — ready" waits for a frame that never
    // comes: a fully-authenticated container looks, from the laptop, like a hung auth.
    expect(SRC).toMatch(/"connected"/);
  });

  it("closes a rejected attach WITH a code + reason, never bare", () => {
    // A bare ws.close() reaches the client as the opaque `disconnected (code 1005)` and it
    // retries forever with nothing in either log saying why.
    expect(SRC).toMatch(/ws\.close\(4\d{3}/);
  });

  it("wires the relay to the session ACTUALLY attached, not the URL's", () => {
    // A device re-attach can land on a different session than the (stale) URL id; routing
    // frames by the URL id would feed a dead session.
    expect(SRC).toMatch(/liveSessionId/);
  });

  it("refuses to start without a signing key", () => {
    // A controller with no BYOC_JOIN_SECRET would accept unsigned junk; exiting loudly is the
    // only safe behaviour.
    expect(SRC).toMatch(/BYOC_JOIN_SECRET/);
    expect(SRC).toMatch(/process\.exit\(1\)/);
  });

  it("assembles the DSN from DB parts (the platform writes `password`, never a `dsn` key)", () => {
    // Asking for a `dsn` key left the pod in CreateContainerConfigError:
    // "couldn't find key dsn in Secret agent-sandbox/agent-pg-byoc".
    expect(SRC).toMatch(/DB_HOST/);
    expect(SRC).toMatch(/DB_PASSWORD/);
  });

  it("closes both stores on shutdown", () => {
    expect(SRC).toMatch(/store\.close\(\)/);
    expect(SRC).toMatch(/deviceStore\.close\(\)/);
  });
});
