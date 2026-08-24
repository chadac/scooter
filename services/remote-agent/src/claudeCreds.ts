/**
 * The user's Claude subscription token, stored ONLY in the container's volume. We do NOT run the
 * OAuth flow ourselves — that authorize step is gated by a browser-minted hCaptcha attestation
 * (proven via HAR 2026-08-19: POST claude.ai/v1/oauth/{org}/authorize carries
 * client_attestation.hcaptcha_token, which no headless client can produce). Instead the USER runs
 * `claude setup-token` on their own machine (real browser does the hCaptcha OAuth) and pastes the
 * resulting `sk-ant-oat01-…` token into our /login page; we persist it here. The SDK consumes it as
 * CLAUDE_CODE_OAUTH_TOKEN (createSdkAcpClient sets it in the claude subprocess env). Token never
 * touches scooter. See todo/done/BYO_CLAUDE_REMOTE_AGENT.md §H.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

/** Long-lived setup tokens are prefixed `sk-ant-oat…`. Loosely validate a pasted value. */
export function looksLikeSetupToken(raw: string): boolean {
  return /^sk-ant-oat\d*-/.test(raw.trim());
}

/** Where we persist the pasted token (a plain file in the mounted volume). */
export function tokenPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "setup-token");
}

/** Read the persisted setup token, or an override from the env (CLAUDE_CODE_OAUTH_TOKEN). */
export async function readToken(): Promise<string | undefined> {
  const fromEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = (await readFile(tokenPath(), "utf8")).trim();
    if (raw) return raw;
  } catch {
    /* absent → not logged in */
  }
  return undefined;
}

/** Persist the pasted setup token to the volume (0600). */
export async function writeToken(token: string): Promise<void> {
  const p = tokenPath();
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, token.trim() + "\n", { mode: 0o600 });
}
