/**
 * Local Claude login server on 127.0.0.1:1717 — the setup-CODE flow (mirrors `claude setup-token`).
 * `/login` shows the Anthropic authorize URL (PKCE, code=true, the CONSOLE callback); the user opens
 * it, Anthropic DISPLAYS a `code#state` string, the user PASTES it back into our form; we exchange it
 * (no client secret) and write ~/.claude/.credentials.json. There is NO loopback callback — we don't
 * stand up a fake redirect endpoint, so we're not impersonating the CLI's callback. All on the user's
 * machine — the token never reaches scooter. See todo/docs/BYO_CLAUDE_REMOTE_AGENT.md §H.
 */

import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";

import {
  AUTHORIZE_URL,
  TOKEN_URL,
  CONSOLE_REDIRECT_URI,
  CLAUDE_CLIENT_ID,
  SCOPES,
  writeCreds,
  type ClaudeCredsFile,
} from "./claudeCreds.js";

const PORT = Number(process.env.LOGIN_PORT ?? 1717);

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
  u.searchParams.set("code", "true"); // setup-code: show a copy-paste code instead of redirecting
  u.searchParams.set("client_id", CLAUDE_CLIENT_ID);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", CONSOLE_REDIRECT_URI);
  u.searchParams.set("scope", SCOPES);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  return u.toString();
}

/** The pasted code is `code#state` (Anthropic appends the state after a '#'). Split it. */
function parsePastedCode(pasted: string): { code: string; state?: string } {
  const trimmed = pasted.trim();
  const hash = trimmed.indexOf("#");
  if (hash === -1) return { code: trimmed };
  return { code: trimmed.slice(0, hash), state: trimmed.slice(hash + 1) };
}

/** Exchange the authorization code for tokens (PKCE, public client — no secret). */
async function exchangeCode(code: string, verifier: string, state: string): Promise<ClaudeCredsFile> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      state,
      redirect_uri: CONSOLE_REDIRECT_URI,
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

const page = (title: string, inner: string): string =>
  `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">` +
  `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}` +
  `a.btn,button{display:inline-block;background:#d77757;color:#fff;border:0;border-radius:.4rem;` +
  `padding:.6rem 1rem;font-size:1rem;text-decoration:none;cursor:pointer}input{width:100%;` +
  `box-sizing:border-box;padding:.6rem;font-size:1rem;border:1px solid #ccc;border-radius:.4rem;margin:.5rem 0}` +
  `code{background:#f4f4f4;padding:.1rem .3rem;border-radius:.2rem;word-break:break-all}</style>` +
  `<h2>${title}</h2>${inner}`;

export interface LoginServer {
  /** Resolves once the user completes login (creds written). */
  done: Promise<void>;
  url: string;
  close(): void;
}

/** Start the login server; resolves `done` when the user pastes a valid code and we save the creds. */
export function startLoginServer(log: (m: string) => void = console.log): LoginServer {
  let pkce = newPkce();
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const loginPage = () => {
    pkce = newPkce(); // fresh PKCE + state per visit to /login
    const authUrl = authorizeUrl(pkce.challenge, pkce.state);
    return page(
      "Connect your Claude account",
      `<p>1. Open the Anthropic sign-in page and approve access:</p>` +
        `<p><a class=btn href="${authUrl}" target=_blank rel=noopener>Sign in with Claude →</a></p>` +
        `<p>2. Anthropic will show you a code. Copy it and paste it here:</p>` +
        `<form method=POST action=/submit>` +
        `<input name=code placeholder="paste the code (looks like abc123#xyz)" autofocus autocomplete=off>` +
        `<button type=submit>Connect</button></form>` +
        `<p style="color:#888;font-size:.9rem">The code + token stay on this machine; they never reach Scooter.</p>`
    );
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

    if (req.method === "POST" && url.pathname === "/submit") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const params = new URLSearchParams(raw);
      const pasted = params.get("code") ?? "";
      const { code, state } = parsePastedCode(pasted);
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(page("Login failed", `<p>No code provided. <a href=/login>Try again</a>.</p>`));
        return;
      }
      // Anthropic appends the state to the displayed code; if present it must match ours.
      if (state && state !== pkce.state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(page("Login failed", `<p>State mismatch (stale code?). <a href=/login>Start over</a>.</p>`));
        return;
      }
      try {
        const creds = await exchangeCode(code, pkce.verifier, state ?? pkce.state);
        await writeCreds(creds);
        log("Claude login complete — credentials saved.");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(page("Connected ✓", `<p>Your Claude account is linked. You can close this tab; the agent is starting.</p>`));
        resolveDone();
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(page("Login failed", `<pre>${err instanceof Error ? err.message : String(err)}</pre><p><a href=/login>Try again</a></p>`));
      }
      return;
    }

    if (url.pathname === "/login" || url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(loginPage());
      return;
    }

    res.writeHead(404, { "Content-Type": "text/html" });
    res.end(page("Not found", `<p><a href=/login>Go to login</a></p>`));
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
