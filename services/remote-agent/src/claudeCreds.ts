/**
 * The user's Claude subscription credentials — read/write ~/.claude/.credentials.json (the format
 * Claude Code reads) + refresh when the short-lived access token expires. The token lives ONLY in
 * the container's volume; it never leaves the user's machine. See todo/docs/BYO_CLAUDE_REMOTE_AGENT.md §H.
 *
 * Constants (public Claude Code client) confirmed from reverse-engineering write-ups; verify against
 * the current CLI if Anthropic rotates hosts/scopes.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// Values captured from the real `claude setup-token` flow (claude-code 2.1.172). This is the
// setup-CODE variant: Claude redirects to a CONSOLE callback that DISPLAYS a `code#state` string
// the user copies back — there is no loopback port. Matching the CLI exactly (host, redirect,
// code=true, scope) is what makes claude.com/cai/oauth/authorize accept the request; verify against
// the current CLI if Anthropic rotates any of these.
export const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
// The console callback that renders the copy-paste code (NOT a loopback redirect).
export const CONSOLE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
export const SCOPES = "user:inference";

/** The ~/.claude/.credentials.json shape Claude Code reads. expiresAt is ms-since-epoch. */
export interface ClaudeCredsFile {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
  };
}

export function credsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), ".credentials.json");
}

export async function readCreds(): Promise<ClaudeCredsFile | undefined> {
  try {
    const raw = await readFile(credsPath(), "utf8");
    const parsed = JSON.parse(raw) as ClaudeCredsFile;
    if (parsed?.claudeAiOauth?.accessToken) return parsed;
  } catch {
    /* absent / unreadable → not logged in */
  }
  return undefined;
}

export async function writeCreds(creds: ClaudeCredsFile): Promise<void> {
  const p = credsPath();
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

/** A ~60s skew: treat a token as expired slightly early so we refresh before a call fails. */
const SKEW_MS = 60_000;

export function isExpired(creds: ClaudeCredsFile, now = Date.now()): boolean {
  return !creds.claudeAiOauth.expiresAt || creds.claudeAiOauth.expiresAt - SKEW_MS <= now;
}

/** Exchange a refresh token for a fresh access token (+ rotated refresh token). Writes the result. */
export async function refreshCreds(creds: ClaudeCredsFile): Promise<ClaudeCredsFile> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: creds.claudeAiOauth.refreshToken,
      client_id: CLAUDE_CLIENT_ID,
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed: HTTP ${res.status}`);
  const body = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
  const next: ClaudeCredsFile = {
    claudeAiOauth: {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? creds.claudeAiOauth.refreshToken,
      expiresAt: Date.now() + body.expires_in * 1000,
      scopes: (body.scope ?? SCOPES).split(" "),
    },
  };
  await writeCreds(next);
  return next;
}

/** Return a VALID access token (refreshing if needed), or undefined if not logged in. */
export async function getValidAccessToken(): Promise<string | undefined> {
  let creds = await readCreds();
  if (!creds) return undefined;
  if (isExpired(creds)) {
    try {
      creds = await refreshCreds(creds);
    } catch {
      return undefined; // refresh failed → treat as logged out (re-login)
    }
  }
  return creds.claudeAiOauth.accessToken;
}
