/**
 * The container's device identity — an Ed25519 keypair that lives ONLY on this machine (§P).
 *
 * Why this exists: the join token is a 10-minute bearer credential pasted into a copy-paste
 * one-liner. The container runs on a LAPTOP with `--restart always`, so it must survive every
 * sleep/wake cycle — and with only the bearer token, reconnects past ten minutes die 4004 forever
 * (~30,000 failed attempts over 25h on the real container, §N).
 *
 * So the join token is used ONCE, to register this device's PUBLIC key. Every later connect signs a
 * server-issued nonce with the private key, which never leaves the volume. The cloud stores only
 * the public half, so a database compromise yields nothing that can authenticate.
 *
 * Persisted next to the Claude setup-token in the same volume (`scooter-claude:/root/.claude`) at
 * mode 0600 — the volume is already the trust boundary for this container's secrets.
 */

import { generateKeyPairSync, createPrivateKey, sign as cryptoSign } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

/** Where the device identity lives. Same directory as the Claude token, same volume. */
export function deviceKeyPath(): string {
  return process.env.SCOOTER_DEVICE_KEY_PATH ?? join(homedir(), ".claude", "device-key.json");
}

export interface DeviceIdentity {
  /** Assigned by the controller at registration. */
  deviceId: string;
  /** PKCS#8 PEM — the secret. Never sent anywhere. */
  privateKeyPem: string;
  /** SPKI PEM — what the cloud stores. */
  publicKeyPem: string;
}

/** A freshly generated keypair, not yet registered (no deviceId). */
export interface UnregisteredKey {
  privateKeyPem: string;
  publicKeyPem: string;
}

export function generateDeviceKey(): UnregisteredKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/** Load the stored identity, or undefined if this container has never registered. */
export async function loadDeviceIdentity(): Promise<DeviceIdentity | undefined> {
  try {
    const raw = await readFile(deviceKeyPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<DeviceIdentity>;
    if (!parsed.deviceId || !parsed.privateKeyPem || !parsed.publicKeyPem) return undefined;
    // Validate the key actually parses. A corrupt file must fall back to re-registration rather
    // than crash-looping the container on every start.
    createPrivateKey(parsed.privateKeyPem);
    return parsed as DeviceIdentity;
  } catch {
    return undefined;
  }
}

export async function saveDeviceIdentity(identity: DeviceIdentity): Promise<void> {
  const p = deviceKeyPath();
  await mkdir(dirname(p), { recursive: true });
  // 0600: the private key is the whole credential. Same posture as the Claude setup-token.
  await writeFile(p, JSON.stringify(identity, null, 2) + "\n", { mode: 0o600 });
}

/** Sign a server-issued challenge nonce. Ed25519 takes the key directly — no digest argument. */
export function signChallenge(privateKeyPem: string, nonce: string): string {
  return cryptoSign(null, Buffer.from(nonce), createPrivateKey(privateKeyPem)).toString("base64");
}
