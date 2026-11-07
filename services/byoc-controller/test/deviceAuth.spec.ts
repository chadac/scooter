/**
 * Tier 1 contract for device-key auth: registration is short-lived and bearer (a join token
 * plus a public key stores a trusted device), authentication is long-lived and asymmetric
 * (signing a single-use server nonce), and the cap of three devices per owner evicts the
 * least-recently-seen.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import { createDeviceAuth, type DeviceAuth, type DeviceStore, MAX_DEVICES_PER_OWNER } from "../src/deviceAuth.js";
import { mintJoinToken } from "../src/joinToken.js";

const SECRET = "test-secret";

/** A device: an Ed25519 keypair that can sign a challenge. */
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

  it("REFUSES a second registration with the same join token", async () => {
    const token = mintJoinToken("alice", SECRET);
    expect((await auth.register(token, fakeDevice().publicKeyPem)).ok).toBe(true);
    const again = await auth.register(token, fakeDevice().publicKeyPem);
    expect(again.ok).toBe(false);
    expect(await store.listByOwner("alice")).toHaveLength(1);
  });

  it("a fresh join token registers another device", async () => {
    expect((await auth.register(mintJoinToken("alice", SECRET), fakeDevice().publicKeyPem)).ok).toBe(true);
    expect((await auth.register(mintJoinToken("alice", SECRET), fakeDevice().publicKeyPem)).ok).toBe(true);
    expect(await store.listByOwner("alice")).toHaveLength(2);
  });

  it("REFUSES a malformed public key rather than storing junk", async () => {
    // A row whose key cannot verify anything would still consume one of the owner's slots.
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

    // 30 days later, long past any join token's life.
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
    // A signature captured off the wire and replayed must fail.
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
    now += 3600;
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
    // dev-0 registered first but is used most recently; dev-1 has gone quiet.
    now += 100;
    const c = auth.challenge();
    await auth.verify(devices[0].id, c.nonce, devices[0].d.sign(c.nonce));

    now += 10;
    const fresh = fakeDevice("new-laptop");
    expect((await auth.register(mintJoinToken("alice", SECRET), fresh.publicKeyPem, fresh.label)).ok).toBe(true);

    const rows = await store.listByOwner("alice");
    expect(rows).toHaveLength(MAX_DEVICES_PER_OWNER);
    expect(rows.map((r) => r.label)).toContain("dev-0"); // recently used, kept
    expect(rows.map((r) => r.label)).toContain("new-laptop");
    expect(rows.map((r) => r.label)).not.toContain("dev-1"); // least-recently-seen, evicted
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
    // The device cannot re-register without a fresh join token, which needs an authenticated session.
    expect((await auth.verify(deviceId, c.nonce, dev.sign(c.nonce))).ok).toBe(false);
  });

  it("an owner cannot deregister ANOTHER owner's device", async () => {
    const dev = fakeDevice();
    const reg = await auth.register(mintJoinToken("alice", SECRET), dev.publicKeyPem);
    const deviceId = reg.ok ? reg.deviceId : "";
    await auth.deregister("mallory", deviceId); // not mallory's to remove
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
