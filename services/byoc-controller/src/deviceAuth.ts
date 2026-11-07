/**
 * Device-key auth: long-lived BYOC connections without a long-lived secret. Registration is
 * short-lived and bearer (the join token plus a public key stores a trusted device);
 * authentication is long-lived and asymmetric (every later connect signs a server-issued
 * nonce, consumed on use, verified against the stored Ed25519 public key). The private key
 * never leaves the device.
 */

import { createPublicKey, randomUUID, verify as cryptoVerify } from "node:crypto";

import { verifyJoinToken } from "./joinToken.js";

/** Three devices per owner: a laptop, a desktop, and one spare. */
export const MAX_DEVICES_PER_OWNER = 3;

/** How long a challenge stays valid, long enough for a slow handshake and short enough that a captured nonce is useless. */
export const CHALLENGE_TTL_SECONDS = 120;

export interface DeviceRow {
  id: string;
  owner: string;
  /** SPKI/PEM, the only key material the cloud stores. */
  publicKey: string;
  label?: string;
  lastSeen: number;
}

export interface DeviceStore {
  add(device: DeviceRow): Promise<void>;
  listByOwner(owner: string): Promise<DeviceRow[]>;
  /** Look a device up by id, since the container knows its own id but not its owner. */
  getById(id: string): Promise<DeviceRow | undefined>;
  remove(id: string): Promise<void>;
  touch(id: string, at: number): Promise<void>;
  close(): Promise<void>;
}

/** What the settings page renders, with no key material. */
export interface DeviceSummary {
  id: string;
  label?: string;
  lastSeen: number;
}

export type RegisterResult = { ok: true; deviceId: string } | { ok: false; reason: string };
export type VerifyResult = { ok: true; owner: string; deviceId: string } | { ok: false; reason: string };

export interface DeviceAuthConfig {
  store: DeviceStore;
  /** HMAC secret for join tokens. */
  secret: string;
  /** Injectable clock (seconds) for tests. */
  now?: () => number;
}

export interface DeviceAuth {
  register(joinToken: string, publicKeyPem: string, label?: string): Promise<RegisterResult>;
  /** Issue a single-use challenge for a container to sign. */
  challenge(): { nonce: string; expiresAt: number };
  verify(deviceId: string, nonce: string, signatureB64: string): Promise<VerifyResult>;
  deregister(owner: string, deviceId: string): Promise<void>;
  listDevices(owner: string): Promise<DeviceSummary[]>;
  /** The owner a device id belongs to, for labelling an auth-failure event only and never as an authorization input. */
  ownerOf(deviceId: string): Promise<string | undefined>;
}

export function createDeviceAuth(config: DeviceAuthConfig): DeviceAuth {
  const { store, secret } = config;
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));
  // Issued, unconsumed challenges, in-memory so a nonce cannot be replayed across a restart.
  const pending = new Map<string, number>(); // nonce -> expiresAt
  // Join-token nonces already traded for a device, kept until the token expires.
  const redeemed = new Map<string, number>(); // nonce -> exp

  const sweep = (): void => {
    const t = now();
    for (const [nonce, exp] of pending) if (exp <= t) pending.delete(nonce);
    for (const [nonce, exp] of redeemed) if (exp <= t) redeemed.delete(nonce);
  };

  return {
    async register(joinToken, publicKeyPem, label) {
      const verified = verifyJoinToken(joinToken, secret);
      if (!verified.ok) return { ok: false, reason: `join token rejected: ${verified.reason}` };
      const owner = verified.claims.owner;

      // Parse before storing, or an unusable key consumes one of the owner's slots.
      try {
        const key = createPublicKey(publicKeyPem);
        if (key.asymmetricKeyType !== "ed25519") {
          return { ok: false, reason: `expected an ed25519 key, got ${key.asymmetricKeyType ?? "unknown"}` };
        }
      } catch {
        return { ok: false, reason: "unparseable public key" };
      }

      // One device per join token, tracked by its nonce.
      const { nonce, exp } = verified.claims;
      sweep();
      if (redeemed.has(nonce)) return { ok: false, reason: "join token rejected: already used to register a device" };
      // Claimed before any await, so concurrent registrations cannot both pass.
      redeemed.set(nonce, exp);

      // Enforce the cap by evicting the least-recently-seen device.
      const existing = await store.listByOwner(owner);
      if (existing.length >= MAX_DEVICES_PER_OWNER) {
        const evictable = [...existing].sort((a, b) => a.lastSeen - b.lastSeen);
        const drop = evictable.slice(0, existing.length - MAX_DEVICES_PER_OWNER + 1);
        for (const d of drop) await store.remove(d.id);
      }

      const deviceId = randomUUID();
      await store.add({ id: deviceId, owner, publicKey: publicKeyPem, label, lastSeen: now() });
      return { ok: true, deviceId };
    },

    challenge() {
      sweep();
      const nonce = randomUUID();
      const expiresAt = now() + CHALLENGE_TTL_SECONDS;
      pending.set(nonce, expiresAt);
      return { nonce, expiresAt };
    },

    async verify(deviceId, nonce, signatureB64) {
      sweep();
      const exp = pending.get(nonce);
      // Unknown covers both a never-issued nonce and an already-used one.
      if (exp === undefined) return { ok: false, reason: "unknown or already-used nonce" };
      if (exp <= now()) {
        pending.delete(nonce);
        return { ok: false, reason: "challenge expired" };
      }

      const row = await store.getById(deviceId);
      if (!row) return { ok: false, reason: "unknown device" };

      let valid = false;
      try {
        valid = cryptoVerify(
          null,
          Buffer.from(nonce),
          createPublicKey(row.publicKey),
          Buffer.from(signatureB64, "base64"),
        );
      } catch {
        valid = false;
      }
      // Consume the nonce whatever the outcome, so a failed attempt leaves no live challenge to guess against.
      pending.delete(nonce);
      if (!valid) return { ok: false, reason: "signature does not match the device key" };

      await store.touch(deviceId, now());
      return { ok: true, owner: row.owner, deviceId };
    },

    async deregister(owner, deviceId) {
      const row = await store.getById(deviceId);
      // One user must never be able to revoke another's device.
      if (!row || row.owner !== owner) return;
      await store.remove(deviceId);
    },

    async listDevices(owner) {
      const rows = await store.listByOwner(owner);
      // Project to a summary so no key material reaches the browser.
      return rows
        .map((r) => ({ id: r.id, label: r.label, lastSeen: r.lastSeen }))
        .sort((a, b) => b.lastSeen - a.lastSeen);
    },

    async ownerOf(deviceId) {
      const d = await store.getById(deviceId).catch(() => undefined);
      return d?.owner;
    },
  };
}
