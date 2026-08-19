/**
 * scooter-remote-agent entrypoint (bring-your-own-Claude container).
 *
 *   scooter-remote-agent login                         one-time interactive Claude login (serves
 *                                                       127.0.0.1:1717, exits when done)
 *   scooter-remote-agent --url <wss> --join <token>    run: ensure Claude login (serving :1717 if
 *                                                       needed), then connect + drive
 *
 * The Claude subscription token lives ONLY in the mounted volume (~/.claude); it never reaches
 * scooter. The join token (--join) authenticates the container TO scooter. See §H of the doc.
 */

import { getValidAccessToken, readCreds } from "./claudeCreds.js";
import { startLoginServer } from "./loginServer.js";
import { runRemoteAgentClient } from "./remoteAgentClient.js";

const log = (m: string) => console.log(`[remote-agent] ${m}`);

function parseArgs(argv: string[]): { cmd?: string; url?: string; join?: string; model?: string } {
  const out: { cmd?: string; url?: string; join?: string; model?: string } = {};
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith("--")) out.cmd = rest.shift();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--url") out.url = rest[++i];
    else if (a === "--join") out.join = rest[++i];
    else if (a === "--model") out.model = rest[++i];
  }
  return out;
}

/** Ensure a valid Claude login: if none, start the login server + wait for the browser flow. */
async function ensureLogin(): Promise<string> {
  let token = await getValidAccessToken();
  if (token) return token;
  const srv = startLoginServer(log);
  log(`Not logged in to Claude. Open ${srv.url} in your browser to sign in.`);
  await srv.done;
  srv.close();
  token = await getValidAccessToken();
  if (!token) throw new Error("login completed but no valid token — check ~/.claude");
  return token;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.cmd === "login") {
    if (await readCreds()) {
      log("Already logged in to Claude (credentials present).");
      return;
    }
    const srv = startLoginServer(log);
    log(`Open ${srv.url} to sign in to Claude.`);
    await srv.done;
    srv.close();
    log("Done. You can now run the agent.");
    return;
  }

  if (!args.url || !args.join) {
    console.error("usage: scooter-remote-agent --url <wss://.../remote-agent/connect> --join <token>");
    console.error("   or: scooter-remote-agent login");
    process.exit(2);
  }

  const oauthToken = await ensureLogin();
  log(`Claude ready. Connecting to ${args.url} …`);
  const client = runRemoteAgentClient({
    url: args.url,
    joinToken: args.join,
    oauthToken,
    model: args.model,
    log,
  });
  process.on("SIGTERM", () => client.stop());
  process.on("SIGINT", () => client.stop());
  await client.closed;
}

void main().catch((err) => {
  console.error(`[remote-agent] fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
