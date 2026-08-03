/**
 * record-transcript — drive a REAL agent run (goose/ollama locally, or claude via a
 * live agent-host) with the transcript recorder ON, then save the NDJSON as a
 * fixture. Records the RAW agent input + AG-UI output so tests replay real behavior.
 *
 * See todo/docs/AGENT_TRANSCRIPT_HARNESS.md. CI never runs this — it replays the
 * committed fixtures. Run it only to (re)capture when the SDK/goose drifts.
 *
 * Usage (goose/ollama, fully local + free):
 *   node test/support/record-transcript.mjs goose <scenario> [prompt]
 *     env: OLLAMA_HOST (default 127.0.0.1:11434), GOOSE_MODEL (default qwen2.5-coder:7b)
 *
 * Scenarios (canned prompts) live in SCENARIOS below; pass a scenario key. The
 * fixture is written to
 *   services/agent-host/test/fixtures/transcripts/<provider>/<scenario>.ndjson
 *
 * This boots agent-host in FAKE_SANDBOX mode (tool calls run as local subprocesses,
 * no cluster) with a REAL goose talking to a local ollama model.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROVIDER = process.argv[2];
const SCENARIO = process.argv[3];
const PROMPT_OVERRIDE = process.argv[4];

/** Canned scenario prompts — the behaviors the fakes must get right. Deterministic-
 *  ish; a weak local model may vary, so keep prompts explicit + simple. */
const SCENARIOS = {
  "plain-text-turn": "Reply with exactly one short sentence and nothing else.",
  "shell-tool-and-result": "Run the shell command `echo HARNESS_MARKER` using your shell tool, then tell me its output.",
  "subagent-poll-loop": "Spawn a subagent with spawn_subagent to run 'sleep 6 && echo SUBDONE'. Then call check_subagent a few times to poll until you receive its result.",
};

if (PROVIDER !== "goose") {
  console.error("Only `goose` (ollama) is wired for local recording. For claude, record on odin with TRANSCRIPT_RECORD_DIR set (see the harness doc).");
  process.exit(2);
}
const prompt = PROMPT_OVERRIDE ?? SCENARIOS[SCENARIO];
if (!prompt) {
  console.error(`Unknown scenario '${SCENARIO}'. Known: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(2);
}

const recordDir = join(tmpdir(), `transcript-record-${Date.now()}`);
mkdirSync(recordDir, { recursive: true });
const port = 8099;
const ollamaHost = process.env.OLLAMA_HOST ?? "127.0.0.1:11434";
const gooseModel = process.env.GOOSE_MODEL ?? "qwen2.5-coder:7b";
const gooseBin = process.env.GOOSE_BIN ?? "goose";

console.error(`>> recording goose/${SCENARIO} against ollama ${ollamaHost} (${gooseModel})`);
console.error(`>> record dir: ${recordDir}`);

const child = spawn("node", ["services/agent-host/dist/index.js"], {
  env: {
    ...process.env,
    PORT: String(port),
    GOOSE_BIN: gooseBin,
    GOOSE_PROVIDER: "ollama",
    GOOSE_MODEL: gooseModel,
    OLLAMA_HOST: ollamaHost,
    FAKE_SANDBOX: "1",
    STATE_PATH: join(recordDir, "state"),
    TRANSCRIPT_RECORD_DIR: recordDir,
    // A local model's FIRST inference includes a slow cold load — give the
    // dead-on-arrival + liveness watchdogs plenty of room so recording doesn't
    // spuriously RUN_ERROR before the model warms up.
    FIRST_ACTIVITY_TIMEOUT_MS: "300000",
    AGENT_LIVENESS_PROBE_MS: "0",
    // Disable back-pressure noise unless the scenario needs it (subagent does).
    SUBAGENT_BACKPRESSURE: SCENARIO === "subagent-poll-loop" ? "1" : "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => process.env.DEBUG && process.stderr.write(`[ah] ${d}`));
child.stderr.on("data", (d) => process.env.DEBUG && process.stderr.write(`[ah:err] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitReady = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("agent-host did not become ready");
};

const cid = `rec-${SCENARIO}-${Date.now()}`;
try {
  await waitReady();
  console.error(">> agent-host ready; driving the scenario (local model — may be slow)...");
  await fetch(`http://127.0.0.1:${port}/agui`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: cid, runId: "r1", messages: [{ id: "u1", role: "user", content: prompt }] }),
  });
  // Poll the conversation history until the run(s) finish (or a generous cap).
  for (let i = 0; i < 180; i++) {
    await sleep(1000);
    const h = await fetch(`http://127.0.0.1:${port}/conversations/${cid}/history`).then((r) => r.json()).catch(() => ({}));
    const evs = h.events ?? [];
    const started = evs.filter((e) => e.type === "RUN_STARTED").length;
    const finished = evs.filter((e) => e.type === "RUN_FINISHED" || e.type === "RUN_ERROR").length;
    if (started > 0 && finished >= started) { console.error(`>> run(s) complete (${finished}/${started})`); break; }
  }
  await sleep(1000);

  // Collect the recorded NDJSON (one file per run) into a single fixture, in order.
  const files = readdirSync(recordDir).filter((f) => f.startsWith("sess-") || f.includes(cid) || f.endsWith(".ndjson"));
  const all = files
    .filter((f) => f.endsWith(".ndjson"))
    .map((f) => readFileSync(join(recordDir, f), "utf8"))
    .join("");
  const outDir = join("services/agent-host/test/fixtures/transcripts/goose");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${SCENARIO}.ndjson`);
  writeFileSync(outFile, all);
  const lines = all.split("\n").filter((l) => l.trim()).length;
  console.error(`>> WROTE ${outFile} (${lines} entries)`);
} finally {
  child.kill("SIGTERM");
  await sleep(300);
  try { rmSync(recordDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
