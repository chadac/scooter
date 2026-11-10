#!/usr/bin/env node
/**
 * scooter-vscode-ahp: an Agent Host Protocol server exposing this sandbox's conversation (and
 * its VS Code sessions) to code-server, which connects via `--agent-host-bridge-port` on loopback.
 *
 * Env: CONVERSATION_ID (pod env), SCOOTER_SELF_URL + SCOOTER_SELF_TOKEN_PATH (router
 * self-access), CONVERSATION_URL (link back to the web UI), AHP_PORT (default 8765),
 * AHP_STATE_DIR (default /run/scooter-vscode-ahp; the minted bridge token is written to
 * <dir>/bridge-token for code-server to pass as --agent-host-bridge-connection-token).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ScooterBackend } from "./scooterBackend.js";
import { ensureSettings } from "./settings.js";
import { routerApi } from "./routerApi.js";
import { ProtocolCore } from "./vendor/hydra-ahp/protocol/core.js";
import { AhpListener } from "./vendor/hydra-ahp/server/listener.js";
import { TokenRegistry } from "./vendor/hydra-ahp/store/tokens.js";
import { setDebug } from "./vendor/hydra-ahp/util/log.js";

// `scooter-vscode-ahp ensure-settings <user settings.json>`: add the VS Code settings Scooter needs, then exit.
if (process.argv[2] === "ensure-settings") {
  const path = process.argv[3];
  if (!path) {
    console.error("usage: scooter-vscode-ahp ensure-settings <settings.json>");
    process.exit(2);
  }
  console.error(`scooter-vscode-ahp: settings ${ensureSettings(path)}: ${path}`);
  process.exit(0);
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`scooter-vscode-ahp: ${name} is not set`);
    process.exit(1);
  }
  return v;
}

const conversationId = required("CONVERSATION_ID");
const selfUrl = required("SCOOTER_SELF_URL");
const tokenPath = required("SCOOTER_SELF_TOKEN_PATH");
const port = Number(process.env.AHP_PORT ?? 8765);
const stateDir = process.env.AHP_STATE_DIR ?? "/run/scooter-vscode-ahp";
// Outlives restarts, unlike stateDir: VS Code keeps its session URIs across them.
const sessionsPath = process.env.AHP_SESSIONS_PATH ?? join(stateDir, "sessions.json");
setDebug(process.env.AHP_DEBUG === "1");

const backend = new ScooterBackend({
  conversationId,
  title: process.env.CONVERSATION_TITLE ?? "Scooter conversation",
  workspaceUri: process.env.WORKSPACE_URI ?? "file:///workspace",
  conversationUrl: process.env.CONVERSATION_URL,
  api: routerApi(selfUrl, conversationId, tokenPath),
  statePath: sessionsPath,
  log: (m) => console.error(m),
});
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
mkdirSync(dirname(sessionsPath), { recursive: true, mode: 0o700 });
const core = new ProtocolCore({ backend, detachGraceMs: 5000 });
await core.start();

// A fresh bridge token per start: only code-server (same pod, loopback) should ever connect.
const tokens = new TokenRegistry({ path: join(stateDir, "tokens.json") });
const minted = tokens.mint("code-server");
writeFileSync(join(stateDir, "bridge-token"), minted.token, { mode: 0o600 });

const listener = new AhpListener({ core, tokens, port, host: "127.0.0.1" });
await listener.listen();
console.error(`scooter-vscode-ahp: conversation ${conversationId} on ws://127.0.0.1:${port}`);

const stop = async () => {
  backend.stop();
  await listener.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
