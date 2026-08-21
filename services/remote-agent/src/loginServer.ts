/**
 * Local token-entry server on 127.0.0.1:34579. We do NOT run Claude's OAuth (the authorize step is
 * gated by a browser-minted hCaptcha attestation — see claudeCreds.ts). Instead the page instructs
 * the user to run `claude setup-token` on their OWN machine and paste the resulting `sk-ant-oat01-…`
 * token; we persist it to the volume. The SDK then consumes it as CLAUDE_CODE_OAUTH_TOKEN. The token
 * stays on the user's machine — it never reaches scooter. See todo/docs/BYO_CLAUDE_REMOTE_AGENT.md §H.
 */

import { createServer, type Server } from "node:http";

import { looksLikeSetupToken, writeToken } from "./claudeCreds.js";

const PORT = Number(process.env.LOGIN_PORT ?? 34579);

const page = (title: string, inner: string): string =>
  `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">` +
  `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem}` +
  `button{background:#d77757;color:#fff;border:0;border-radius:.4rem;padding:.6rem 1rem;font-size:1rem;cursor:pointer}` +
  `input{width:100%;box-sizing:border-box;padding:.6rem;font-size:1rem;border:1px solid #ccc;border-radius:.4rem;margin:.5rem 0}` +
  `code,pre{background:#f4f4f4;padding:.15rem .4rem;border-radius:.3rem}pre{padding:.6rem;white-space:pre-wrap;word-break:break-all}` +
  `</style><h2>${title}</h2>${inner}`;

const loginPage = (): string =>
  page(
    "Connect your Claude account",
    `<p>On <b>your own machine</b> (where you're signed in to Claude), run:</p>` +
      `<pre>claude setup-token</pre>` +
      `<p>Approve in the browser, then copy the token it prints (starts with <code>sk-ant-oat</code>) and paste it here:</p>` +
      `<form method=POST action=/submit>` +
      `<input name=token placeholder="sk-ant-oat01-…" autofocus autocomplete=off spellcheck=false>` +
      `<button type=submit>Connect</button></form>` +
      `<p style="color:#888;font-size:.9rem">The token stays in this container on your machine; it never reaches Scooter.</p>`
  );

export interface LoginServer {
  /** Resolves once the user submits a valid token (persisted). */
  done: Promise<void>;
  url: string;
  close(): void;
}

/** Start the token-entry server; resolves `done` when the user pastes a valid setup token. */
export function startLoginServer(log: (m: string) => void = console.log): LoginServer {
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

    if (req.method === "POST" && url.pathname === "/submit") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const token = (new URLSearchParams(raw).get("token") ?? "").trim();
      if (!looksLikeSetupToken(token)) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(page("Not a setup token", `<p>That doesn't look like a <code>sk-ant-oat…</code> token. <a href=/login>Try again</a>.</p>`));
        return;
      }
      try {
        await writeToken(token);
        log("Setup token saved — connecting.");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(page("Connected ✓", `<p>Your Claude token is saved. You can close this tab; the agent is starting.</p>`));
        resolveDone();
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(page("Save failed", `<pre>${err instanceof Error ? err.message : String(err)}</pre><p><a href=/login>Try again</a></p>`));
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
    log(`token-entry server on http://localhost:${PORT}/login — paste your \`claude setup-token\` output there`);
  });

  return {
    done,
    url: `http://localhost:${PORT}/login`,
    close: () => server.close(),
  };
}
