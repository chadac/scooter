/**
 * record-transcript — drive a REAL agent run (goose/ollama locally, or claude via a
 * live agent-host) with the transcript recorder ON, then save the NDJSON as a
 * fixture. Records the RAW agent input + AG-UI output so tests replay real behavior.
 *
 *. CI never runs this — it replays the
 * committed fixtures. Run it only to (re)capture when the SDK/goose drifts.
 *
 * Usage:
 *   node test/support/record-transcript.mjs goose <scenario> [prompt]
 *
 * goose backends (GOOSE_BACKEND, default "ollama"):
 *   - ollama (local, free): env OLLAMA_HOST (default 127.0.0.1:11434),
 *     GOOSE_MODEL (default qwen2.5-coder:7b). A plain 7b won't emit tool calls
 *     natively — set GOOSE_TOOLSHIM=1 (+ GOOSE_TOOLSHIM_OLLAMA_MODEL, default
 *     llama3.1:8b) so goose's toolshim converts text into tool calls, OR use a
 *     natively-tool-calling model. NOTE: the toolshim is unreliable for real
 *     subagent recording (it hallucinates tool names) — use bedrock for those.
 *   - bedrock (real model, metered): GOOSE_BACKEND=bedrock, with AWS creds in the
 *     env (e.g. `eval "$(aws configure export-credentials --profile <p> --format env)"`)
 *     + AWS_REGION + GOOSE_MODEL (a bedrock inference-profile id, e.g.
 *     us.anthropic.claude-sonnet-4-20250514-v1:0). This is the RELIABLE way to record
 *     goose tool + SUBAGENT scenarios — real ACP tool calls. (goose's claude-code
 *     provider does NOT surface ACP tool calls, so it's unusable here.)
 *
 * Scenarios (canned prompts) live in SCENARIOS below; pass a scenario key. The
 * fixture is written to
 *   services/agent-host/test/fixtures/transcripts/<provider>/<scenario>.ndjson
 *
 * Boots agent-host in FAKE_SANDBOX mode (tool calls run as local subprocesses, no
 * cluster). The platform MCP endpoint (spawn_subagent/check_subagent) IS wired even
 * in FAKE_SANDBOX, so subagent scenarios CAN record locally — provided the model
 * actually tool-calls (use bedrock).
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
  // Fan-out: spawn TWO subagents that both finish close together, so their
  // completions race the parent — the shape that exposed the completion-flush bug
  // (a finished subagent whose RUN_FINISHED lost the fire-and-forget append/read
  // race got NO result injected). Pure-text tasks (no shell) so it works in
  // FAKE_SANDBOX and records cleanly. Best driven with the bedrock backend.
  "subagent-fanout": "Use spawn_subagent to create two subagents. Ask subagent one to write a haiku about the ocean. Ask subagent two to write a haiku about mountains. Wait for both results, then share them.",
  // Multi-turn: two prompts in ONE conversation. Turn 2 references turn 1, so a
  // provider that loses session context (SDK resume / ACP continuation) fails it.
  "multi-turn": [
    "Remember the secret word: ZEBRA. Reply with exactly: OK.",
    "What was the secret word I told you? Reply with just the word.",
  ],
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
const gooseBin = process.env.GOOSE_BIN ?? "goose";
const backend = process.env.GOOSE_BACKEND ?? "ollama";

// Per-backend goose env. ollama = local/free; bedrock = real model (reliable tools).
let backendEnv;
if (backend === "bedrock") {
  const model = process.env.GOOSE_MODEL ?? "us.anthropic.claude-sonnet-4-20250514-v1:0";
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  if (!process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_PROFILE) {
    console.error(">> bedrock backend needs AWS creds in the env. e.g.:\n   eval \"$(aws configure export-credentials --profile <p> --format env)\"");
    process.exit(2);
  }
  backendEnv = { GOOSE_PROVIDER: "aws_bedrock", GOOSE_MODEL: model, AWS_REGION: region };
  console.error(`>> recording goose/${SCENARIO} against BEDROCK (${model}, ${region})`);
} else {
  const ollamaHost = process.env.OLLAMA_HOST ?? "127.0.0.1:11434";
  const gooseModel = process.env.GOOSE_MODEL ?? "qwen2.5-coder:7b";
  backendEnv = { GOOSE_PROVIDER: "ollama", GOOSE_MODEL: gooseModel, OLLAMA_HOST: ollamaHost };
  // Toolshim: convert a non-tool-calling model's text into tool calls. Opt-in
  // (GOOSE_TOOLSHIM=1); default the interpreter to a tool-capable local model.
  if (process.env.GOOSE_TOOLSHIM === "1") {
    backendEnv.GOOSE_TOOLSHIM = "1";
    backendEnv.GOOSE_TOOLSHIM_OLLAMA_MODEL = process.env.GOOSE_TOOLSHIM_OLLAMA_MODEL ?? "llama3.1:8b";
    console.error(`>> toolshim ON (interpreter ${backendEnv.GOOSE_TOOLSHIM_OLLAMA_MODEL})`);
  }
  console.error(`>> recording goose/${SCENARIO} against ollama ${ollamaHost} (${gooseModel})`);
}
console.error(`>> record dir: ${recordDir}`);

const child = spawn("node", ["services/agent-host/dist/index.js"], {
  env: {
    ...process.env,
    PORT: String(port),
    GOOSE_BIN: gooseBin,
    ...backendEnv,
    FAKE_SANDBOX: "1",
    LOCAL_STATE_PATH: join(recordDir, "state"),
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
  // A scenario is one prompt or an array of prompts (multi-turn, same conversation).
  const prompts = Array.isArray(prompt) ? prompt : [prompt];
  const runsFinished = async () => {
    const h = await fetch(`http://127.0.0.1:${port}/conversations/${cid}/history`).then((r) => r.json()).catch(() => ({}));
    const evs = h.events ?? [];
    const started = evs.filter((e) => e.type === "RUN_STARTED").length;
    const finished = evs.filter((e) => e.type === "RUN_FINISHED" || e.type === "RUN_ERROR").length;
    return started > 0 && finished >= started ? finished : 0;
  };
  for (let t = 0; t < prompts.length; t++) {
    console.error(`>> turn ${t + 1}/${prompts.length}`);
    await fetch(`http://127.0.0.1:${port}/agui`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: cid, runId: `r${t + 1}`, messages: [{ id: `u${t + 1}`, role: "user", content: prompts[t] }] }),
    });
    // Wait for THIS turn's run to finish before the next (session continuity).
    const target = t + 1;
    for (let i = 0; i < 180; i++) {
      await sleep(1000);
      if ((await runsFinished()) >= target) { console.error(`>> turn ${target} complete`); break; }
    }
  }
  await sleep(1000);

  // SUBAGENT scenarios: the parent's turn finishes when it has SPAWNED the children,
  // but each child's result injects into the parent ASYNCHRONOUSLY afterwards (a new
  // parent run per completion). Keep waiting until the subagent-done SYSTEM_MESSAGE
  // injections stop arriving, so the fixture captures the whole fan-in.
  if (SCENARIO.startsWith("subagent")) {
    const countInjections = async () => {
      const h = await fetch(`http://127.0.0.1:${port}/conversations/${cid}/history`).then((r) => r.json()).catch(() => ({}));
      return (h.events ?? []).filter((e) => e.type === "SYSTEM_MESSAGE" && e.source === "subagent").length;
    };
    let stable = 0, last = -1;
    for (let i = 0; i < 60 && stable < 4; i++) {
      await sleep(2000);
      const n = await countInjections();
      if (n === last) stable++; else { stable = 0; last = n; }
    }
    console.error(`>> subagent injections captured: ${last}`);
  }

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
