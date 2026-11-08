/**
 * Fake backend orchestrator: boots the kube-less server stack the fast-e2e / dev harness
 * drives the UI against, as one Playwright webServer process (ephemeral Postgres → atlas
 * migrate → agent-host with the fake agent → conversation-router in ROUTER_DEV_MODE). The
 * router owns the conversation list, its events stream and create, served from Postgres,
 * and proxies everything else to the single agent-host; Playwright waits on the router's
 * /healthz, so when this process reports ready the whole chain is up. Teardown stops the
 * chain in reverse, including the detached Postgres that pg_ctl daemonized.
 *
 * Plain .mjs so it runs as a bare `node` webServer command. Requires on PATH:
 * `conversation-router`, postgres tools (initdb/pg_ctl/createdb), `atlas`, and node. Env
 * (all optional):
 *   E2E_ROUTER_PORT (8080)  E2E_AGENT_HOST_PORT (8079)  E2E_AGENT_HOST_REPLICA_PORT (8078)
 *   E2E_PG_PORT (55432)
 *   ROUTER_BIN (else `conversation-router` on PATH)
 *   LOCAL_STATE_PATH, MIRROR_STATE_PATH, GOOSE_MODEL, AGENT_AVAILABLE_MODELS
 *   E2E_AGENT_BIN (else the bundled fake agent)
 */

import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

// E2E_-prefixed so they cannot collide with the k8s service env a dev container inside k8s
// gets injected (AGENT_HOST_PORT=tcp://…).
const ROUTER_PORT = process.env.E2E_ROUTER_PORT ?? "8080";
const AGENT_HOST_PORT = process.env.E2E_AGENT_HOST_PORT ?? "8079";
const REPLICA_PORT = process.env.E2E_AGENT_HOST_REPLICA_PORT ?? "8078";
const PG_PORT = process.env.E2E_PG_PORT ?? "55432";
const REPO_ROOT = new URL("../../..", import.meta.url).pathname;
const PG_EPHEMERAL = join(REPO_ROOT, "scripts/pg-ephemeral.sh");
const DSN = `postgres://postgres@127.0.0.1:${PG_PORT}/agent_host?sslmode=disable`;
// The webhooks DB owns the resource_links table, which agent-host writes and the router
// reads, so both must point at the same DB.
const WEBHOOKS_DSN = `postgres://postgres@127.0.0.1:${PG_PORT}/webhooks?sslmode=disable`;

const log = (msg) => console.log(`[fakeBackend] ${msg}`);
const fail = (msg) => {
  console.error(`[fakeBackend] FATAL: ${msg}`);
  cleanup();
  process.exit(1);
};

let pgDir;
/** @type {import('node:child_process').ChildProcess[]} */
const children = [];

/** Run a setup command to completion; fail the whole stack on non-zero (nothing works without it). */
function must(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} exited ${r.status ?? r.signal}`);
}

async function waitForHealth(url, name, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        log(`${name} healthy (${url})`);
        return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  fail(`${name} did not become healthy within ${timeoutMs}ms (${url})`);
}

function cleanup() {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  if (pgDir) {
    // pg_ctl daemonizes postgres detached from this process, so it must be stopped explicitly.
    spawnSync(PG_EPHEMERAL, ["stop", pgDir], { stdio: "ignore" });
    pgDir = undefined;
  }
}

// ---- boot sequence -----------------------------------------------------------------------------

log(`starting Postgres on 127.0.0.1:${PG_PORT}`);
const pg = spawnSync(PG_EPHEMERAL, ["start", PG_PORT], { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
if (pg.status !== 0) fail(`pg-ephemeral.sh start exited ${pg.status ?? pg.signal}`);
pgDir = pg.stdout.trim();

log("createdb agent_host");
must("createdb", ["-h", "127.0.0.1", "-p", PG_PORT, "-U", "postgres", "agent_host"]);

log("atlas migrate apply (agent_host)");
must("atlas", ["migrate", "apply", "--dir", "file://agent_host/migrations", "--url", DSN], {
  cwd: join(REPO_ROOT, "lib/sql"),
});

// A locked folder for the anonymous user, as services make.
must("psql", [DSN, "-q", "-c",
  `INSERT INTO conversation_folders (id, owner, name, icon, locked, conversation_lifetime_hours, position, created_at)
   VALUES ('e2e-design', '', 'Design', 'palette', true, 0, -1, 0)`]);

log("createdb webhooks");
must("createdb", ["-h", "127.0.0.1", "-p", PG_PORT, "-U", "postgres", "webhooks"]);

log("atlas migrate apply (webhooks)");
must("atlas", ["migrate", "apply", "--dir", "file://webhooks/migrations", "--url", WEBHOOKS_DSN], {
  cwd: join(REPO_ROOT, "lib/sql"),
});

// ask-user's database backs the sidebar's "!" (awaiting-input); both services find it by name.
const AWAITING_DB = "contrib_ask_user";
log(`createdb ${AWAITING_DB}`);
must("createdb", ["-h", "127.0.0.1", "-p", PG_PORT, "-U", "postgres", AWAITING_DB]);

log(`atlas migrate apply (${AWAITING_DB})`);
must("atlas", ["migrate", "apply", "--dir", "file://migrations", "--url",
  `postgres://postgres@127.0.0.1:${PG_PORT}/${AWAITING_DB}?sslmode=disable`], {
  cwd: join(REPO_ROOT, "contrib/ask-user/sql"),
});

// Spawn a long-lived child and tear the whole stack down if it dies unexpectedly, so
// Playwright fails fast rather than hanging.
function spawnService(name, cmd, args, env) {
  log(`starting ${name}: ${cmd} ${args.join(" ")}`);
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (!shuttingDown) fail(`${name} exited unexpectedly (code=${code} signal=${signal})`);
  });
  children.push(child);
  return child;
}

let shuttingDown = false;

// Replicas share Postgres but not local state, as pods do.
const spawnAgentHost = (name, port, statePath, mirrorPath) =>
  spawnService(name, "node", [join(REPO_ROOT, "services/agent-host/dist/index.js")], {
    PORT: port,
    // E2E_AGENT_BIN swaps in another ACP agent, e.g. scooter-demos' replay agent.
    GOOSE_BIN: process.env.E2E_AGENT_BIN || "fake",
    // Force the fake sandbox (noop provisioner, no k8s) rather than letting agent-host infer it
    // from the environment.
    FAKE_SANDBOX: "1",
    LOCAL_STATE_PATH: statePath,
    // Production's two-store topology (mirroredConversationStore only exists with MIRROR_STATE_PATH).
    MIRROR_STATE_PATH: mirrorPath,
    // The repo's own skills stand in for the deployment ConfigMap, so the stack has the
    // built-in skill NAMES a personal skill can shadow (the settings form warns on a
    // collision, and with no skills dir there is nothing to collide with).
    SKILLS_DIR: process.env.SKILLS_DIR ?? join(REPO_ROOT, "skills"),
    GOOSE_MODEL: process.env.GOOSE_MODEL ?? "model-default",
    AGENT_AVAILABLE_MODELS: process.env.AGENT_AVAILABLE_MODELS ?? "model-default,model-fast,model-smart",
    // The env is an explicit allowlist, and AGENT_MODELS_JSON carries the provider-tagged catalog that makes the picker render its grouped branch.
    ...(process.env.AGENT_MODELS_JSON ? { AGENT_MODELS_JSON: process.env.AGENT_MODELS_JSON } : {}),
    // Durable conversation metadata + event log in the ephemeral PG — the row the router lists and
    // hydrates from, and the source of the conversations_changed NOTIFY the router pushes.
    AGENT_HOST_DB_DSN: DSN,
    // Required with a DSN, since nothing else writes the row.
    CONVERSATION_ROUTER_URL: `http://127.0.0.1:${ROUTER_PORT}`,
    // Switches agent-host's link store from files to the shared PG resource_links table, so a link
    // POSTed here is visible to the router's list enrichment (see WEBHOOKS_DSN).
    WEBHOOKS_DB_DSN: WEBHOOKS_DSN,
    AWAITING_INPUT_DB_NAME: AWAITING_DB,
  });

spawnAgentHost(
  "agent-host",
  AGENT_HOST_PORT,
  process.env.LOCAL_STATE_PATH ?? "/tmp/agent-host-e2e",
  process.env.MIRROR_STATE_PATH ?? "/tmp/agent-host-e2e-mirror",
);
// The router never routes here; specs call it directly to read across replicas.
spawnAgentHost("agent-host-replica", REPLICA_PORT, "/tmp/agent-host-e2e-replica", "/tmp/agent-host-e2e-replica-mirror");

const routerBin = process.env.ROUTER_BIN ?? "conversation-router";

// agent-host must be listening before the router verifies its /healthz proxy target; wait then boot.
await waitForHealth(`http://127.0.0.1:${AGENT_HOST_PORT}/healthz`, "agent-host");
await waitForHealth(`http://127.0.0.1:${REPLICA_PORT}/healthz`, "agent-host-replica");

spawnService("conversation-router", routerBin, [], {
  LISTEN_ADDR: `:${ROUTER_PORT}`,
  ROUTER_DEV_MODE: "1",
  AGENT_HOST_URL: `http://127.0.0.1:${AGENT_HOST_PORT}`,
  AGENT_HOST_DB_DSN: DSN,
  // Read-only handle on the same resource_links table agent-host writes, for list enrichment.
  WEBHOOKS_DB_DSN: WEBHOOKS_DSN,
  AWAITING_INPUT_DB_NAME: AWAITING_DB,
});

await waitForHealth(`http://127.0.0.1:${ROUTER_PORT}/healthz`, "conversation-router");
log(`stack ready — UI should target http://localhost:${ROUTER_PORT}`);

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    shuttingDown = true;
    cleanup();
    process.exit(0);
  });
}
// A leftover unhandled path must still tear PG down.
process.on("exit", () => {
  shuttingDown = true;
  cleanup();
});
