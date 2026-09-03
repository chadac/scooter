/**
 * FAKE BACKEND ORCHESTRATOR — boots the whole kube-less server stack the fast-e2e / dev harness
 * drives the UI against, as ONE Playwright webServer process:
 *
 *   ephemeral Postgres  →  atlas migrate (agent_host schema)  →  agent-host (fake agent)  →  router
 *
 * Why the router is now in the stack: the conversation LIST (GET /conversations), its live events
 * stream (GET /conversations/events), and CREATE (POST /conversations) were moved OFF agent-host
 * onto the conversation-router, which serves the list/stream from Postgres (LISTEN/NOTIFY) and
 * creates conversations. So the UI can no longer talk to agent-host directly for those — it talks
 * to the router, which proxies everything else through to the single agent-host and answers the
 * list/create itself. The router runs in ROUTER_DEV_MODE (see services/conversation-router/
 * devmode.go): no CRD watch, existence = every metadata row, create = a direct row INSERT.
 *
 * Playwright waits on the router's /healthz (which proxies to agent-host), so when this process
 * reports ready the whole chain is up. On teardown it tears the chain down in reverse and, crucially,
 * stops the detached Postgres (pg_ctl daemonizes it — it is NOT a child, so a plain tree-kill would
 * orphan it).
 *
 * Plain .mjs (no TS toolchain) so it runs as a bare `node` webServer command. Requires on PATH
 * (the nix dev shell provides all): `conversation-router`, postgres tools (initdb/pg_ctl/createdb),
 * `atlas`, and node. Env (all optional, defaults match the old single-agent-host webServer):
 *   ROUTER_PORT (8080)  AGENT_HOST_PORT (8079)  PG_PORT (55432)
 *   ROUTER_BIN (else `conversation-router` on PATH)
 *   LOCAL_STATE_PATH, MIRROR_STATE_PATH, GOOSE_MODEL, AGENT_AVAILABLE_MODELS
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, chownSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Postgres refuses to run as root (initdb/postgres hard-fail as uid 0). CI runners are non-root,
// but a dev container (Scooter's own sandbox included) often runs as root — so when we ARE root,
// run the PG processes as a non-root uid (default `nobody`, override via PGUID/PGGID) and chown the
// datadir to it. Everything else (agent-host, router, the TCP clients) runs as-is. Empty object on
// a non-root host → spawn uses the current user, exactly as CI does.
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
const PG_AS = runningAsRoot
  ? { uid: Number(process.env.PGUID ?? 65534), gid: Number(process.env.PGGID ?? 65534) }
  : {};

// E2E_-prefixed so they can't collide with k8s SERVICE env injection — a dev container running
// inside k8s (Scooter's own sandbox) gets AGENT_HOST_PORT=tcp://<ip>:8080 auto-injected, which
// would poison a bare `AGENT_HOST_PORT` read (→ PORT="tcp://…" → NaN).
const ROUTER_PORT = process.env.E2E_ROUTER_PORT ?? "8080";
const AGENT_HOST_PORT = process.env.E2E_AGENT_HOST_PORT ?? "8079";
const PG_PORT = process.env.E2E_PG_PORT ?? "55432";
const REPO_ROOT = new URL("../../..", import.meta.url).pathname;
const DSN = `postgres://postgres@127.0.0.1:${PG_PORT}/agent_host?sslmode=disable`;
// The webhooks DB owns the resource_links table. In production agent-host WRITES links here and
// the router READS them to enrich the list; the sidebar's link-name search depends on it. Both
// must point at the SAME DB or a linked conversation lists with no links (chat-search-filter).
const WEBHOOKS_DSN = `postgres://postgres@127.0.0.1:${PG_PORT}/webhooks?sslmode=disable`;

const log = (msg) => console.log(`[fakeBackend] ${msg}`);
const fail = (msg) => {
  console.error(`[fakeBackend] FATAL: ${msg}`);
  cleanup();
  process.exit(1);
};

let tmp;
let pgStarted = false;
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
  if (pgStarted && tmp) {
    // pg_ctl daemonizes postgres detached from this process — it must be stopped explicitly, or it
    // leaks past teardown holding PG_PORT and the temp datadir.
    spawnSync("pg_ctl", ["-D", join(tmp, "data"), "-m", "immediate", "stop"], { stdio: "ignore", ...PG_AS });
    pgStarted = false;
  }
  if (tmp) {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

// ---- boot sequence -----------------------------------------------------------------------------

tmp = mkdtempSync(join(tmpdir(), "scooter-e2e-pg-"));
const pgData = join(tmp, "data");
const pgSock = join(tmp, "sock");
mkdirSync(pgSock, { recursive: true });
if (runningAsRoot) {
  // The PG processes run as PG_AS; give them ownership of the dir tree they must write.
  chownSync(tmp, PG_AS.uid, PG_AS.gid);
  chownSync(pgSock, PG_AS.uid, PG_AS.gid);
}

log(`initdb → ${pgData}${runningAsRoot ? ` (as uid ${PG_AS.uid})` : ""}`);
must("initdb", ["-D", pgData, "-U", "postgres", "--auth=trust"], PG_AS);

log(`starting Postgres on 127.0.0.1:${PG_PORT}`);
must("pg_ctl", [
  "-D", pgData,
  "-o", `-k ${pgSock} -c listen_addresses=127.0.0.1 -c port=${PG_PORT}`,
  "-l", join(tmp, "pg.log"),
  "-w", "start",
], PG_AS);
pgStarted = true;

log("createdb agent_host");
must("createdb", ["-h", "127.0.0.1", "-p", PG_PORT, "-U", "postgres", "agent_host"], PG_AS);

log("atlas migrate apply (agent_host)");
must("atlas", ["migrate", "apply", "--dir", "file://agent_host/migrations", "--url", DSN], {
  cwd: join(REPO_ROOT, "lib/sql"),
});

log("createdb webhooks");
must("createdb", ["-h", "127.0.0.1", "-p", PG_PORT, "-U", "postgres", "webhooks"], PG_AS);

log("atlas migrate apply (webhooks)");
must("atlas", ["migrate", "apply", "--dir", "file://webhooks/migrations", "--url", WEBHOOKS_DSN], {
  cwd: join(REPO_ROOT, "lib/sql"),
});

// Spawn a long-lived child; if it dies unexpectedly, tear the whole stack down (Playwright then
// sees /healthz never come up, or drop, and fails the run fast rather than hanging).
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

spawnService("agent-host", "node", [join(REPO_ROOT, "services/agent-host/dist/index.js")], {
  PORT: AGENT_HOST_PORT,
  GOOSE_BIN: "fake",
  // Force the fake sandbox (noop provisioner, no k8s). agent-host otherwise infers it from
  // GOOSE_BIN=fake AND not-in-cluster — but a dev container that happens to run inside k8s
  // (KUBERNETES_SERVICE_HOST set, e.g. Scooter's own sandbox) would then pick the k8s provisioner
  // and try to reconcile against the cluster. Explicit is deterministic on any host.
  FAKE_SANDBOX: "1",
  LOCAL_STATE_PATH: process.env.LOCAL_STATE_PATH ?? "/tmp/agent-host-e2e",
  // PRODUCTION's two-store topology (mirroredConversationStore only exists with MIRROR_STATE_PATH).
  MIRROR_STATE_PATH: process.env.MIRROR_STATE_PATH ?? "/tmp/agent-host-e2e-mirror",
  GOOSE_MODEL: process.env.GOOSE_MODEL ?? "model-default",
  AGENT_AVAILABLE_MODELS: process.env.AGENT_AVAILABLE_MODELS ?? "model-default,model-fast,model-smart",
  // Durable conversation metadata + event log in the ephemeral PG — the row the router lists and
  // hydrates from, and the source of the conversations_changed NOTIFY the router pushes.
  AGENT_HOST_DB_DSN: DSN,
  // Switches agent-host's link store from files to the shared PG resource_links table, so a link
  // POSTed here is visible to the router's list enrichment (see WEBHOOKS_DSN).
  WEBHOOKS_DB_DSN: WEBHOOKS_DSN,
});

const routerBin = process.env.ROUTER_BIN ?? "conversation-router";

// agent-host must be listening before the router verifies its /healthz proxy target; wait then boot.
await waitForHealth(`http://127.0.0.1:${AGENT_HOST_PORT}/healthz`, "agent-host");

spawnService("conversation-router", routerBin, [], {
  LISTEN_ADDR: `:${ROUTER_PORT}`,
  ROUTER_DEV_MODE: "1",
  AGENT_HOST_URL: `http://127.0.0.1:${AGENT_HOST_PORT}`,
  AGENT_HOST_DB_DSN: DSN,
  // Read-only handle on the same resource_links table agent-host writes, so the list/events
  // enrich each conversation with its links (the sidebar's link-name search).
  WEBHOOKS_DB_DSN: WEBHOOKS_DSN,
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
