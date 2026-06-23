/**
 * Standalone fake ACP agent (stdio binary) — a real `goose acp` stand-in.
 *
 * Speaks the actual ACP wire protocol over stdio via the official SDK's
 * AgentSideConnection, so the agent-host spawns it exactly like goose. It needs
 * no model provider: it echoes the user's prompt and streams a deterministic
 * turn (reasoning -> tool call -> result -> reply). Use it to click through the
 * UI and leave review notes without AWS/Bedrock.
 *
 *   node dist/fakeAgent.js        # the agent-host runs this when GOOSE_BIN=fake
 */

import { Readable, Writable } from "node:stream";

import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type CancelNotification,
  type AuthenticateRequest,
} from "@zed-industries/agent-client-protocol";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeAgent implements Agent {
  constructor(private conn: AgentSideConnection) {}

  async initialize(_p: InitializeRequest): Promise<InitializeResponse> {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: false } };
  }

  async newSession(_p: NewSessionRequest): Promise<NewSessionResponse> {
    return { sessionId: `fake-${Math.random().toString(36).slice(2, 10)}` };
  }

  async authenticate(_p: AuthenticateRequest): Promise<void> {
    return;
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const sessionId = params.sessionId;
    const userText =
      params.prompt
        .map((b) => (b.type === "text" ? b.text : ""))
        .join(" ")
        .trim() || "(no text)";

    const u = (update: Parameters<AgentSideConnection["sessionUpdate"]>[0]["update"]) =>
      this.conn.sessionUpdate({ sessionId, update });

    // A "!<command>" message is a test directive: run <command> verbatim in the
    // sandbox (real exec path) and report its output. Anything else gets a
    // friendly echo. The ! mechanism is the e2e test harness — it lets a UI
    // conversation drive arbitrary sandbox commands (incl. `agent-broker
    // test/whoami` to verify broker/IRSA auth).
    const isCommand = userText.startsWith("!");
    const command = isCommand ? userText.slice(1).trim() : `echo ${userText}`;

    // 1. a thought
    await u({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Planning a response…" } });
    await sleep(300);

    // 2. a REAL tool call: createTerminal -> bridge ACP client -> ExecBackend
    // (local subprocess in fake mode; pod exec in cluster mode). We run the
    // command through `sh -c` so it behaves like a shell line.
    let cmdOutput = "";
    let exitCode = 0;
    await u({
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      title: `run: ${command}`,
      kind: "execute",
      status: "pending",
      rawInput: { command },
    } as never);
    try {
      const term = await this.conn.createTerminal({
        sessionId,
        command: "sh",
        args: ["-c", command],
      });
      const exit = await term.waitForExit();
      exitCode = exit.exitCode ?? 0;
      const out = await term.currentOutput();
      cmdOutput = out.output ?? "";
      await term.release();
    } catch (e) {
      cmdOutput = `exec error: ${String(e)}`;
      exitCode = 1;
    }
    await u({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: exitCode === 0 ? "completed" : "failed",
      content: [{ type: "content", content: { type: "text", text: cmdOutput } }],
    } as never);
    await sleep(200);

    // 3. the reply (streamed), reporting the command output (proves exec ran)
    const reply = isCommand
      ? `🤖 (dummy agent) ran \`${command}\` (exit ${exitCode}):\n${cmdOutput.trim() || "(no output)"}`
      : `🤖 (dummy agent) ran echo: "${cmdOutput.trim()}". (fake mode — real exec chain exercised, no model needed.)`;
    for (const word of reply.split(" ")) {
      await u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: word + " " } });
      await sleep(40);
    }

    return { stopReason: "end_turn" };
  }

  async cancel(_p: CancelNotification): Promise<void> {
    return;
  }
}

const input = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
new AgentSideConnection((conn) => new FakeAgent(conn), ndJsonStream(input, output));
