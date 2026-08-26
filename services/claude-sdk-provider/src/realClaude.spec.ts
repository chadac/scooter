/**
 * Tier 3 — the tool policy against REAL Claude, via the real SDK and a real `claude`
 * CLI subprocess.
 *
 * WHY THIS EXISTS: the bug it guards is invisible to unit tests. `toolPolicy.spec.ts`
 * proves the decision function, but the failure was never in the decision — it was in
 * the SDK WIRING. An unwired tool raised a permission prompt in a headless subprocess
 * nobody could answer, the turn stalled, and readMessages threw
 * `[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use`.
 *
 * WHAT THIS TEST DOES AND DOES NOT PROVE — measured, not assumed. Running the suite
 * against a PRE-FIX build (permissionMode + PreToolUse removed), with an isolated
 * CLAUDE_CONFIG_DIR so no local pre-approval interferes:
 *
 *   - "does not hang"          -> passes pre-fix TOO. Does NOT reproduce the hang.
 *   - "model sees the reason"  -> FAILS pre-fix. This is the real regression guard.
 *   - "allowed tool works"     -> passes both. Guards the other direction.
 *
 * So this file proves the REDIRECT and proves deny-by-default did not break what
 * worked. It does not reproduce the production hang: that involved scooter-env MCP
 * tools over the BYOC tunnel, a shape this local harness cannot construct. Reproducing
 * it needs a deployed conversation — see the deploy step in the PR. Do not read a green
 * run here as proof the hang is impossible.
 *
 * Gated — needs credentials and makes real model calls:
 *   RUN_REAL_CLAUDE=1 npx vitest run --project claude-sdk-provider realClaude
 *
 * Auth: CLAUDE_CODE_OAUTH_TOKEN, or an existing `claude` login on this machine.
 */
import { describe, it, expect } from "vitest";

import type { ExecBackend, ExecRequest, TerminalHandle } from "./types.js";

const run = process.env.RUN_REAL_CLAUDE === "1";
const TIMEOUT = 180_000;

/** A local ExecBackend: the sandbox tools run as subprocesses here, so the test needs
 *  no cluster. The policy under test is about WHICH tools may run, not where. */
function localExec(): ExecBackend {
  return {
    async run(): Promise<never> {
      throw new Error("not used");
    },
    spawn(req: ExecRequest): TerminalHandle {
      const cbs = new Set<(c: string) => void>();
      let done!: (v: { exitCode: number }) => void;
      const exit = new Promise<{ exitCode: number }>((r) => (done = r));
      void (async () => {
        const { spawn } = await import("node:child_process");
        const p = spawn(req.command, req.args ?? [], { cwd: "/tmp", env: process.env });
        p.stdout?.on("data", (d) => cbs.forEach((cb) => cb(String(d))));
        p.stderr?.on("data", (d) => cbs.forEach((cb) => cb(String(d))));
        p.on("close", (code) => done({ exitCode: code ?? 0 }));
      })();
      return {
        id: `local-${Math.random().toString(36).slice(2)}`,
        onOutput(cb) {
          cbs.add(cb);
        },
        waitForExit: () => exit,
        async kill() {},
        async release() {},
      };
    },
    async readTextFile() {
      return "";
    },
    async writeTextFile() {},
  };
}

/** A throwaway CLAUDE_CONFIG_DIR carrying ONLY credentials — no pre-approved tools, so
 *  the permission flow behaves as it does in-cluster. */
function cleanConfigDir(): string {
  const { mkdtempSync, copyFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir, homedir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "scooter-claude-"));
  const creds = join(homedir(), ".claude", ".credentials.json");
  if (existsSync(creds)) copyFileSync(creds, join(dir, ".credentials.json"));
  return dir;
}

/** Drive one real turn and collect what happened. */
async function realTurn(prompt: string) {
  const { createSdkAcpClient } = await import("./sdkClient.js");
  const client = await createSdkAcpClient({
    // ISOLATE from this machine's `claude` config. The developer running this test has
    // tools pre-approved in ~/.claude; the in-cluster agent-host does NOT — and that
    // difference is the entire bug. Without this the harness silently tests the
    // permissive local setup and a pre-fix build appears to pass.
    extraEnv: { CLAUDE_CONFIG_DIR: cleanConfigDir() },
    oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
    model: process.env.REAL_CLAUDE_MODEL ?? "claude-sonnet-4-5",
    exec: localExec(),
    systemPrompt: "You are a test agent. Do exactly what is asked, briefly.",
  });

  const text: string[] = [];
  const toolCalls: string[] = [];
  client.onSessionUpdate((_sid, u) => {
    if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") text.push(u.content.text);
    if (u.sessionUpdate === "tool_call") toolCalls.push(u.title);
  });

  await client.initialize({ protocolVersion: 1 } as never);
  const { sessionId } = await client.newSession({ cwd: "/tmp", mcpServers: [] } as never);

  let threw: Error | undefined;
  let stopReason = "";
  try {
    ({ stopReason } = await client.prompt({ sessionId, prompt: [{ type: "text", text: prompt }] } as never));
  } catch (e) {
    threw = e as Error;
  }
  await client.close().catch(() => {});
  return { text: text.join(""), toolCalls, threw, stopReason };
}

describe.skipIf(!run)("real Claude — tool policy", () => {
  it(
    "a DENIED tool completes the turn (NB: passes pre-fix too — see the file header)",
    async () => {
      // THE REGRESSION. WebSearch is unwired: before this fix it raised a headless
      // permission prompt, the turn stalled, and the SDK threw stop_reason=tool_use.
      const { text, threw } = await realTurn(
        "Use your WebSearch tool to search for 'kubernetes operator pattern'. " +
          "If you cannot, say what you would use instead.",
      );

      // The turn must COMPLETE. This is the whole point — not what the model said.
      expect(threw, `the turn threw: ${threw?.message}`).toBeUndefined();
      expect(text.length, "the model must have replied").toBeGreaterThan(0);
      // And it must NOT be the specific failure this fix targets.
      expect(threw?.message ?? "").not.toMatch(/stop_reason=tool_use|ede_diagnostic/);
    },
    TIMEOUT,
  );

  it(
    "the model SEES the deny reason and reports it, rather than stalling",
    async () => {
      // The SDK docs say a deny message reaches the model and it "may adjust its
      // approach". Assert the reason arrived — the model must be able to tell the user
      // the tool is unavailable, which is only possible if it received our text.
      //
      // NOT asserting it names `web_search`: this harness runs without mcpEndpointUrl,
      // so the scooter-env tools genuinely are not present. Naming a tool it cannot see
      // would be the wrong behaviour to demand. In-cluster the redirect names it; that
      // belongs in a deployed test, not here.
      const { text, threw } = await realTurn(
        "Search the web for the current Kubernetes release. If a tool is unavailable, " +
          "say so explicitly and explain what happened.",
      );
      expect(threw).toBeUndefined();
      expect(text).toMatch(/not available|unavailable|cannot|can't/i);
      expect(text).toMatch(/websearch/i); // it identifies WHICH tool was refused
    },
    TIMEOUT,
  );

  it(
    "an ALLOWED sandbox tool still runs end to end",
    async () => {
      // Guards the other direction: deny-by-default must not break what should work.
      const { text, toolCalls, threw } = await realTurn(
        "Run the shell command `echo scooter-policy-ok` and tell me its output.",
      );
      expect(threw).toBeUndefined();
      expect(`${text} ${toolCalls.join(" ")}`).toMatch(/scooter-policy-ok/);
    },
    TIMEOUT,
  );
});
