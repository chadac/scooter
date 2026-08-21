/**
 * Device-key auth — long-lived BYOC connections without a long-lived secret (§P).
 *
 * The join token is a BEARER credential with a 10-minute TTL, pasted into a copy-paste one-liner, so
 * it ends up in shell history, screenshots, and chat logs. But the container runs on a LAPTOP with
 * `--restart always`: it must serve turns while the laptop is open and reconnect cleanly after every
 * sleep/wake. With only the bearer token, reconnects past ten minutes die `4004` FOREVER and just
 * spin (~30,000 failed attempts over 25h on the real container, §N).
 *
 * Extending the TTL would be the wrong fix — it extends the blast radius of a credential that leaks
 * by design. So: split REGISTRATION (short-lived, bearer) from AUTHENTICATION (long-lived,
 * asymmetric).
 *
 *   first connect   join token + PUBLIC key   -> stored as a trusted device
 *   every later     sign a server NONCE       -> verified against the stored key, valid indefinitely
 *
 * The private key never leaves the laptop, so the cloud holds nothing worth stealing: a database
 * compromise yields public keys only.
 *
 * WHY A SERVER NONCE, not a client-chosen timestamp: a timestamp signature is replayable by anyone
 * who captures it once. The nonce binds the signature to ONE connection attempt and is consumed on
 * use — which matters most here, because `/byoc/ws/:id` is the deliberately UNAUTHENTICATED ingress
 * (§L Q3).
 *
 * Ed25519 (locked with the user): in `node:crypto` with no external dependency, 32-byte keys, and
 * sign/verify take the key directly with no digest argument to get wrong.
 */

import { createPublicKey, randomUUID, verify as cryptoVerify } from "node:crypto";

import { verifyJoinToken } from "./joinToken.js";

/** Three devices per owner (locked with the user): a laptop, a desktop, and one spare. Unbounded
 *  rows are a slow leak, and every extra key is another way in. */
export const MAX_DEVICES_PER_OWNER = 3;

/** How long a challenge stays valid. Long enough for a slow handshake, short enough that a captured
 *  nonce is useless by the time it could be replayed. */
export const CHALLENGE_TTL_SECONDS = 120;

export interface DeviceRow {
  id: string;
  owner: string;
  /** SPKI/PEM. The cloud stores ONLY this — never anything that could sign. */
  publicKey: string;
  label?: string;
  lastSeen: number;
}

export interface DeviceStore {
  add(device: DeviceRow): Promise<void>;
  listByOwner(owner: string): Promise<DeviceRow[]>;
  /** Look a device up by id — the container knows its own id but not its owner. */
  getById(id: string): Promise<DeviceRow | undefined>;
  remove(id: string): Promise<void>;
  touch(id: string, at: number): Promise<void>;
  close(): Promise<void>;
}

/** What the settings page renders. Deliberately NO key material. */
export interface DeviceSummary {
  id: string;
  label?: string;
  lastSeen: number;
}

export type RegisterResult = { ok: true; deviceId: string } | { ok: false; reason: string };
export type VerifyResult = { ok: true; owner: string; deviceId: string } | { ok: false; reason: string };

export interface DeviceAuthConfig {
  store: DeviceStore;
  /** HMAC secret for join tokens (registration only). */
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
}

export function createDeviceAuth(config: DeviceAuthConfig): DeviceAuth {
  const { store, secret } = config;
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));
  // Issued, unconsumed challenges. In-memory on purpose: a nonce is meaningful only for the seconds
  // between issue and use, and persisting it would create a way to replay across a restart.
  const pending = new Map<string, number>(); // nonce -> expiresAt

  const sweep = (): void => {
    const t = now();
    for (const [nonce, exp] of pending) if (exp <= t) pending.delete(nonce);
  };

  return {
    async register(joinToken, publicKeyPem, label) {
      const verified = verifyJoinToken(joinToken, secret);
      if (!verified.ok) return { ok: false, reason: `join token rejected: ${verified.reason}` };
      const owner = verified.claims.owner;

      // Parse BEFORE storing. A row whose key cannot verify anything is a permanently-failing
      // device that still consumes one of the owner's three slots.
      try {
        const key = createPublicKey(publicKeyPem);
        if (key.asymmetricKeyType !== "ed25519") {
          return { ok: false, reason: `expected an ed25519 key, got ${key.asymmetricKeyType ?? "unknown"}` };
        }
      } catch {
        return { ok: false, reason: "unparseable public key" };
      }

      // Enforce the cap by evicting the LEAST-RECENTLY-SEEN device, not the oldest-registered: a
      // laptop in daily use must not lose its slot to one that has not connected in months.
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
      // Unknown covers both "we never issued this" (a client-chosen nonce) and "already used" —
      // consumed below, so a captured signature cannot be replayed.
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
      // Consume the nonce whatever the outcome: a failed attempt must not leave a live challenge
      // for an attacker to keep guessing against.
      pending.delete(nonce);
      if (!valid) return { ok: false, reason: "signature does not match the device key" };

      await store.touch(deviceId, now());
      return { ok: true, owner: row.owner, deviceId };
    },

    async deregister(owner, deviceId) {
      const row = await store.getById(deviceId);
      // Ownership check: one user must never be able to revoke another's device.
      if (!row || row.owner !== owner) return;
      await store.remove(deviceId);
    },

    async listDevices(owner) {
      const rows = await store.listByOwner(owner);
      // Project to a summary — no key material reaches the browser, even though a PUBLIC key would
      // be harmless. Keeping key handling entirely server-side means no future UI change can leak
      // something that matters.
      return rows
        .map((r) => ({ id: r.id, label: r.label, lastSeen: r.lastSeen }))
        .sort((a, b) => b.lastSeen - a.lastSeen);
    },
  };
}
