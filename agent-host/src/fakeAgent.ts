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

    // 1. a thought
    await u({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Planning a response…" } });
    await sleep(300);

    // 2. a tool call + result (so the UI renders tool-call cards)
    await u({
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      title: "run: echo",
      kind: "execute",
      status: "pending",
      rawInput: { command: `echo ${userText}` },
    } as never);
    await sleep(300);
    await u({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: userText } }],
    } as never);
    await sleep(200);

    // 3. the reply (streamed in chunks), echoing the prompt
    const reply = `🤖 (dummy agent) You said: "${userText}". This is a fake response so you can test the UI and leave review notes — no model needed.`;
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
