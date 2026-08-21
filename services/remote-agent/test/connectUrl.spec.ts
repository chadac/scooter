/**
 * Tier 1 — the container's connect URL (§P).
 *
 * WHY THIS FILE EXISTS. The controller authorizes the WS UPGRADE, before any application message
 * can be sent, so credentials must ride on the URL. The first wiring put them in a hello FRAME —
 * the controller read query params, the container sent a message, and device auth silently never
 * engaged: every reconnect quietly fell back to the join token and died once it expired. Both
 * sides were individually correct; the SEAM was wrong. Exactly the failure mode that has bitten
 * this project twice already.
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
    // The signature must actually verify against the stored public half — the controller will.
    const sig = u.searchParams.get("signature") ?? "";
    expect(
      cryptoVerify(null, Buffer.from("nonce-xyz"), createPublicKey(key.publicKeyPem), Buffer.from(sig, "base64")),
    ).toBe(true);
    // The bearer token is NOT sent once a device key exists — that is the point of §P.
    expect(u.searchParams.get("token")).toBeNull();
  });

  it("a registered container whose CHALLENGE fetch fails falls back to the join token", async () => {
    // Controller mid-rollout. Degrading to the (short-lived) token beats refusing to connect.
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
 * WIRING — does the client actually USE buildConnectUrl?
 *
 * The tests above prove buildConnectUrl builds the right URL. They do NOT prove the client dials
 * it: a rebase reverted `new WebSocket(connectUrl)` back to `new WebSocket(deps.url)` and every
 * one of them still passed, because they call the builder directly. Device auth would have
 * silently never engaged — credentials in a hello frame the controller never reads, since it
 * authorizes the UPGRADE before any message exists.
 *
 * Same shape as services/byoc-controller/test/wiring.spec.ts: assert on the source, because the
 * composition is the thing that broke and importing the module would open a real socket.
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
    // The controller reads query params at the upgrade; a deviceId in the hello is dead code that
    // looks like working auth.
    const hello = SRC.match(/ws!\.send\(JSON\.stringify\(\{[^}]*protocolVersion[^}]*\}\)\)/s);
    expect(hello, "hello frame not found").toBeTruthy();
    expect(hello![0]).not.toMatch(/deviceId/);
  });
});
