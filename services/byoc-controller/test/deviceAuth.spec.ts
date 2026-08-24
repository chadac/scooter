/**
 * Tier 1 contract — device-key auth (§P of todo/done/BYO_CLAUDE_REMOTE_AGENT.md).
 *
 * WHY THIS EXISTS. The join token is a BEARER credential with a 10-minute TTL, pasted into a
 * copy-paste one-liner (so it lands in shell history, screenshots, chat logs). The container runs on
 * a LAPTOP with `--restart always`: it should serve turns while the laptop is open and let the cloud
 * fall back to Bedrock/goose when it sleeps. The fallback works; the RETURN does not — after ten
 * minutes every reconnect dies 4004 forever and only a manual re-mint recovers it (~30,000 failed
 * attempts over 25h on the real container, see §N).
 *
 * Extending the TTL is the wrong fix: it extends the blast radius of a credential that leaks by
 * design. Instead, split REGISTRATION (short-lived, bearer) from AUTHENTICATION (long-lived,
 * asymmetric):
 *
 *   first connect  join token + public key  -> the cloud stores the PUBLIC key as a trusted device
 *   every later    sign a server NONCE      -> verified against the stored key, valid indefinitely
 *
 * The private key never leaves the laptop, so a database compromise yields nothing usable.
 *
 * THE NONCE IS LOAD-BEARING. Signing a client-chosen timestamp would be replayable by anyone who
 * captures one signature — and `/byoc/ws/:id` is the deliberately UNAUTHENTICATED ingress (§L Q3),
 * which is exactly where replay matters most.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import { createDeviceAuth, type DeviceAuth, type DeviceStore, MAX_DEVICES_PER_OWNER } from "../src/deviceAuth.js";
import { mintJoinToken } from "../src/joinToken.js";

const SECRET = "test-secret";

/** A laptop: an Ed25519 keypair that can sign a challenge. */
function fakeDevice(label = "laptop") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    label,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    sign: (nonce: string) => cryptoSign(null, Buffer.from(nonce), privateKey).toString("base64"),
  };
}

function memoryDeviceStore(): DeviceStore {
  const rows: Array<{ id: string; owner: string; publicKey: string; label?: string; lastSeen: number }> = [];
  return {
    async add(d) { rows.push({ ...d }); },
    async listByOwner(owner) { return rows.filter((r) => r.owner === owner).map((r) => ({ ...r })); },
    async getById(id) { const r = rows.find((x) => x.id === id); return r ? { ...r } : undefined; },
    async remove(id) {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
    },
    async touch(id, at) { const r = rows.find((x) => x.id === id); if (r) r.lastSeen = at; },
    async close() {},
  };
}

describe("BYOC device-key auth", () => {
  let store: DeviceStore;
  let auth: DeviceAuth;
  let now: number;

  beforeEach(() => {
    store = memoryDeviceStore();
    now = 1_000_000;
    auth = createDeviceAuth({ store, secret: SECRET, now: () => now });
  });

  // --- Registration -----------------------------------------------------------------------

  it("registers a device with a VALID join token and returns a device id", async () => {
    const dev = fakeDevice();
    const res = await auth.register(mintJoinToken("alice", SECRET), dev.publicKeyPem, dev.label);
    expect(res.ok).toBe(true);
    expect(res.ok && res.deviceId).toMatch(/\S/);
    expect(await store.listByOwner("alice")).toHaveLength(1);
  });

  it("REFUSES registration with an expired join token (the 10-minute window is the gate)", async () => {
    const dev = fakeDevice();
    const res = await auth.register(mintJoinToken("alice", SECRET, { ttlSeconds: -1 }), dev.publicKeyPem);
    expect(res.ok).toBe(false);
    expect(await store.listByOwner("alice")).toHaveLength(0);
  });

  it("REFUSES registration with a forged join token", async () => {
    const dev = fakeDevice();
    const res = await auth.register(mintJoinToken("alice", "wrong-secret"), dev.publicKeyPem);
    expect(res.ok).toBe(false);
  });

  it("REFUSES a malformed public key rather than storing junk", async () => {
    // A row whose key cannot verify anything is a permanently-failing device that still consumes
    // one of the owner's three slots.
    const res = await auth.register(mintJoinToken("alice", SECRET), "not-a-key");
    expect(res.ok).toBe(false);
    expect(await store.listByOwner("alice")).toHaveLength(0);
  });

  // --- Authentication ---------------------------------------------------------------------

  it("authenticates a registered device by signing the server's nonce", async () => {
    const dev = fakeDevice();
    const reg = await auth.register(mintJoinToken("alice", SECRET), dev.publicKeyPem);
    const deviceId = reg.ok ? reg.deviceId : "";

    const challenge = auth.challenge();
    const res = await auth.verify(deviceId, challenge.nonce, dev.sign(challenge.nonce));
    expect(res.ok).toBe(true);
    expect(res.ok && res.owner).toBe("alice");
  });

  it("authenticates INDEFINITELY — long after the join token would have expired", async () => {
    const dev = fakeDevice();
    const reg = await auth.register(mintJoinToken("alice", SECRET), dev.publicKeyPem);
    const deviceId = reg.ok ? reg.deviceId : "";

    // 30 days later: the laptop has slept and woken many times. THE ENTIRE POINT — with the old
    // bearer token this reconnect died 4004 and never recovered.
    now += 30 * 24 * 3600;
    const challenge = auth.challenge();
    expect((await auth.verify(deviceId, challenge.nonce, dev.sign(challenge.nonce))).ok).toBe(true);
  });

  it("REJECTS a signature from a DIFFERENT key (the device did not sign this)", async () => {
    const dev = fakeDevice();
    const impostor = fakeDevice("impostor");
    const reg = await auth.register(mintJoinToken("alice", SECRET), dev.publicKeyPem);
    const deviceId = reg.ok ? reg.deviceId : "";

    const challenge = auth.challenge();
    expect((await auth.verify(deviceId, challenge.nonce, impostor.sign(challenge.nonce))).ok).toBe(false);
  });

  it("REJECTS a REPLAYED signature — a nonce is single-use", async () => {
    const dev = fakeDevice();
    const reg = await auth.register(mintJoinToken("alice", SECRET), dev.publicKeyPem);
    const deviceId = reg.ok ? reg.deviceId : "";

    const challenge = auth.challenge();
    const sig = dev.sign(challenge.nonce);
    expect((await auth.verify(deviceId, challenge.nonce, sig)).ok).toBe(true);
    // Captured off the wire and replayed against the UNAUTHENTICATED /byoc/ws/ ingress — must fail.
    expect((await auth.verify(deviceId, challenge.nonce, sig)).ok).toBe(false);
  });

  it("REJECTS a nonce this server never issued (no client-chosen challenges)", async () => {
    const dev = fakeDevice();
    const reg = await auth.register(mintJoinToken("alice", SECRET), dev.publicKeyPem);
    const deviceId = reg.ok ? reg.deviceId : "";
    const forged = "i-made-this-nonce-up";
    expect((await auth.verify(deviceId, forged, dev.sign(forged))).ok).toBe(false);
  });

  it("REJECTS an EXPIRED nonce (a challenge is not valid forever)", async () => {
    const dev = fakeDevice();
    const reg = await auth.register(mintJoinToken("alice", SECRET), dev.publicKeyPem);
    const deviceId = reg.ok ? reg.deviceId : "";
    const challenge = auth.challenge();
    now += 3600; // an hour later
    expect((await auth.verify(deviceId, challenge.nonce, dev.sign(challenge.nonce))).ok).toBe(false);
  });

  it("REJECTS an unknown device id", async () => {
    const dev = fakeDevice();
    const challenge = auth.challenge();
    expect((await auth.verify("no-such-device", challenge.nonce, dev.sign(challenge.nonce))).ok).toBe(false);
  });

  // --- The three-device cap ---------------------------------------------------------------

  it("allows up to MAX_DEVICES_PER_OWNER devices", async () => {
    for (let i = 0; i < MAX_DEVICES_PER_OWNER; i++) {
      const d = fakeDevice(`dev-${i}`);
      now += 10;
      expect((await auth.register(mintJoinToken("alice", SECRET), d.publicKeyPem, d.label)).ok).toBe(true);
    }
    expect(await store.listByOwner("alice")).toHaveLength(MAX_DEVICES_PER_OWNER);
  });

  it("registering one MORE evicts the LEAST-RECENTLY-SEEN device, not the oldest-registered", async () => {
    const devices = [];
    for (let i = 0; i < MAX_DEVICES_PER_OWNER; i++) {
      const d = fakeDevice(`dev-${i}`);
      now += 10;
      const r = await auth.register(mintJoinToken("alice", SECRET), d.publicKeyPem, d.label);
      devices.push({ d, id: r.ok ? r.deviceId : "" });
    }
    // dev-0 registered FIRST but is used most recently; dev-1 has gone quiet. A laptop in daily
    // use must not lose its slot to one that has not connected in months.
    now += 100;
    const c = auth.challenge();
    await auth.verify(devices[0].id, c.nonce, devices[0].d.sign(c.nonce));

    now += 10;
    const fresh = fakeDevice("new-laptop");
    expect((await auth.register(mintJoinToken("alice", SECRET), fresh.publicKeyPem, fresh.label)).ok).toBe(true);

    const rows = await store.listByOwner("alice");
    expect(rows).toHaveLength(MAX_DEVICES_PER_OWNER);
    expect(rows.map((r) => r.label)).toContain("dev-0"); // recently used — kept
    expect(rows.map((r) => r.label)).toContain("new-laptop");
    expect(rows.map((r) => r.label)).not.toContain("dev-1"); // least-recently-seen — evicted
  });

  it("the cap is PER OWNER — one user's devices do not evict another's", async () => {
    for (let i = 0; i < MAX_DEVICES_PER_OWNER; i++) {
      const d = fakeDevice(`a-${i}`);
      now += 10;
      await auth.register(mintJoinToken("alice", SECRET), d.publicKeyPem, d.label);
    }
    const b = fakeDevice("bob-laptop");
    await auth.register(mintJoinToken("bob", SECRET), b.publicKeyPem, b.label);
    expect(await store.listByOwner("alice")).toHaveLength(MAX_DEVICES_PER_OWNER);
    expect(await store.listByOwner("bob")).toHaveLength(1);
  });

  // --- Deregistration (the settings page) -------------------------------------------------

  it("deregistering a device makes its key stop working immediately", async () => {
    const dev = fakeDevice();
    const reg = await auth.register(mintJoinToken("alice", SECRET), dev.publicKeyPem);
    const deviceId = reg.ok ? reg.deviceId : "";

    await auth.deregister("alice", deviceId);
    const c = auth.challenge();
    // Complete revocation: the laptop cannot re-register without a FRESH join token, which needs
    // an authenticated session.
    expect((await auth.verify(deviceId, c.nonce, dev.sign(c.nonce))).ok).toBe(false);
  });

  it("an owner cannot deregister ANOTHER owner's device", async () => {
    const dev = fakeDevice();
    const reg = await auth.register(mintJoinToken("alice", SECRET), dev.publicKeyPem);
    const deviceId = reg.ok ? reg.deviceId : "";
    await auth.deregister("mallory", deviceId); // not alice's to remove
    expect(await store.listByOwner("alice")).toHaveLength(1);
  });

  it("listDevices returns what the settings page renders (label + last seen), never the key", async () => {
    const dev = fakeDevice("chadac's laptop");
    await auth.register(mintJoinToken("alice", SECRET), dev.publicKeyPem, dev.label);
    const list = await auth.listDevices("alice");
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe("chadac's laptop");
    expect(list[0]).not.toHaveProperty("publicKey"); // no key material to the browser
  });
});
