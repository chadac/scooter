/**
 * Tier 1: the container's connect URL. The controller authorizes the WS upgrade before any
 * application message can be sent, so the credentials must ride on the URL.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";

import { buildConnectUrl } from "../src/remoteAgentClient.js";
import { generateDeviceKey, saveDeviceIdentity } from "../src/deviceKey.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "connect-url-"));
  process.env.SCOOTER_DEVICE_KEY_PATH = join(dir, "device-key.json");
});
afterEach(() => {
  delete process.env.SCOOTER_DEVICE_KEY_PATH;
  rmSync(dir, { recursive: true, force: true });
});

const base = { url: "ws://cloud/byoc/ws/sess-1", oauthToken: "t" };

describe("container connect URL", () => {
  it("a FIRST-TIME container carries the join token", async () => {
    const u = new URL(await buildConnectUrl({ ...base, joinToken: "join-abc" }));
    expect(u.searchParams.get("token")).toBe("join-abc");
    expect(u.searchParams.get("deviceId")).toBeNull();
  });

  it("a REGISTERED container carries deviceId + nonce + signature, NOT the token", async () => {
    const key = generateDeviceKey();
    await saveDeviceIdentity({ deviceId: "dev-1", ...key });
    const u = new URL(
      await buildConnectUrl({ ...base, joinToken: "join-abc", challengeNonce: async () => "nonce-xyz" }),
    );
    expect(u.searchParams.get("deviceId")).toBe("dev-1");
    expect(u.searchParams.get("nonce")).toBe("nonce-xyz");
    // The signature must verify against the stored public half, as the controller checks.
    const sig = u.searchParams.get("signature") ?? "";
    expect(
      cryptoVerify(null, Buffer.from("nonce-xyz"), createPublicKey(key.publicKeyPem), Buffer.from(sig, "base64")),
    ).toBe(true);
    // The bearer token is not sent once a device key exists.
    expect(u.searchParams.get("token")).toBeNull();
  });

  it("a registered container whose CHALLENGE fetch fails falls back to the join token", async () => {
    // Degrading to the short-lived token beats refusing to connect.
    await saveDeviceIdentity({ deviceId: "dev-1", ...generateDeviceKey() });
    const u = new URL(
      await buildConnectUrl({
        ...base,
        joinToken: "join-abc",
        challengeNonce: async () => {
          throw new Error("503");
        },
      }),
    );
    expect(u.searchParams.get("token")).toBe("join-abc");
    expect(u.searchParams.get("deviceId")).toBeNull();
  });

  it("a registered container with NO challenge fn (old cloud) falls back to the join token", async () => {
    await saveDeviceIdentity({ deviceId: "dev-1", ...generateDeviceKey() });
    const u = new URL(await buildConnectUrl({ ...base, joinToken: "join-abc" }));
    expect(u.searchParams.get("token")).toBe("join-abc");
  });

  it("preserves the path and any existing query on the URL", async () => {
    const u = new URL(await buildConnectUrl({ ...base, url: "ws://cloud/byoc/ws/sess-1?x=1", joinToken: "j" }));
    expect(u.pathname).toBe("/byoc/ws/sess-1");
    expect(u.searchParams.get("x")).toBe("1");
  });

  it("a fresh nonce is signed each time (two connects do not reuse one signature)", async () => {
    const key = generateDeviceKey();
    await saveDeviceIdentity({ deviceId: "dev-1", ...key });
    let n = 0;
    const mk = () => buildConnectUrl({ ...base, joinToken: "j", challengeNonce: async () => `nonce-${++n}` });
    const a = new URL(await mk());
    const b = new URL(await mk());
    expect(a.searchParams.get("nonce")).not.toBe(b.searchParams.get("nonce"));
    expect(a.searchParams.get("signature")).not.toBe(b.searchParams.get("signature"));
  });
});

/**
 * Wiring: the client must actually dial the URL buildConnectUrl builds. This asserts on
 * the source, as services/byoc-controller/test/wiring.spec.ts does, because importing the
 * module would open a real socket.
 */
describe("client wiring", () => {
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "remoteAgentClient.ts"),
    "utf8",
  );

  it("dials the URL from buildConnectUrl, not deps.url directly", () => {
    expect(SRC).toMatch(/new WebSocket\(\s*connectUrl\s*\)/);
    expect(SRC, "a bare new WebSocket(deps.url) skips the device credentials").not.toMatch(
      /new WebSocket\(\s*deps\.url\s*\)/,
    );
  });

  it("does NOT put device credentials in the hello frame", () => {
    // The controller reads query params at the upgrade, so a deviceId in the hello is dead code that looks like working auth.
    const hello = SRC.match(/sock\.send\(JSON\.stringify\(\{[^}]*protocolVersion[^}]*\}\)\)/s);
    expect(hello, "hello frame not found").toBeTruthy();
    expect(hello![0]).not.toMatch(/deviceId/);
  });
});
