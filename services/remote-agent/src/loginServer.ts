/**
 * Local Claude login server on 127.0.0.1:1717 — the DIY loopback OAuth flow. `/login` redirects the
 * user's browser to Anthropic's authorize URL (PKCE, redirect_uri=http://127.0.0.1:1717/callback,
 * the public Claude Code client_id); Anthropic redirects the code back to `/callback`; we exchange
 * it (no client secret) and write ~/.claude/.credentials.json. All on the user's machine — the token
 * never reaches scooter. See todo/docs/BYO_CLAUDE_REMOTE_AGENT.md §H.
 */

import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";

import {
  AUTHORIZE_URL,
  TOKEN_URL,
  CLAUDE_CLIENT_ID,
  SCOPES,
  writeCreds,
  type ClaudeCredsFile,
} from "./claudeCreds.js";

const PORT = Number(process.env.LOGIN_PORT ?? 1717);
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

const b64url = (b: Buffer): string => b.toString("base64url");

/** Build the PKCE + state for a login attempt. */
function newPkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));
  return { verifier, challenge, state };
}

function authorizeUrl(challenge: string, state: string): string {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", CLAUDE_CLIENT_ID);
  u.searchParams.set("redirect_uri", REDIRECT_URI);
  u.searchParams.set("scope", SCOPES);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  return u.toString();
}

/** Exchange the authorization code for tokens (PKCE, public client — no secret). */
async function exchangeCode(code: string, verifier: string): Promise<ClaudeCredsFile> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLAUDE_CLIENT_ID,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  const body = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; scope?: string };
  return {
    claudeAiOauth: {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + body.expires_in * 1000,
      scopes: (body.scope ?? SCOPES).split(" "),
    },
  };
}

export interface LoginServer {
  /** Resolves once the user completes login (creds written). */
  done: Promise<void>;
  url: string;
  close(): void;
}

/** Start the login server; resolves `done` when the user finishes the browser flow. */
export function startLoginServer(log: (m: string) => void = console.log): LoginServer {
  let pkce = newPkce();
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    if (url.pathname === "/login") {
      pkce = newPkce(); // fresh per attempt
      res.writeHead(302, { Location: authorizeUrl(pkce.challenge, pkce.state) });
      res.end();
      return;
    }
    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || state !== pkce.state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h3>Login failed</h3><p>Missing or invalid code. Return to /login and try again.</p>");
        return;
      }
      try {
        const creds = await exchangeCode(code, pkce.verifier);
        await writeCreds(creds);
        log("Claude login complete — credentials saved.");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h3>Connected ✓</h3><p>Your Claude account is linked. You can close this tab; the agent is starting.</p>");
        resolveDone();
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(`<h3>Login failed</h3><pre>${err instanceof Error ? err.message : String(err)}</pre>`);
      }
      return;
    }
    // Landing page → send them to /login.
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<h3>Connect your Claude account</h3><p><a href="/login">Sign in with Claude →</a></p>`);
  });

  server.listen(PORT, "0.0.0.0", () => {
    log(`login server on http://localhost:${PORT}/login — open it to sign in to Claude`);
  });

  return {
    done,
    url: `http://localhost:${PORT}/login`,
    close: () => server.close(),
  };
}
