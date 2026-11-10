/**
 * Standalone fake ACP agent (stdio binary), a `goose acp` stand-in that speaks the
 * real ACP wire protocol via the SDK's AgentSideConnection, so the agent-host spawns
 * it exactly like goose. It needs no model provider: it echoes the user's prompt and
 * streams a deterministic turn (reasoning, tool call, result, reply). The agent-host
 * runs `node dist/fakeAgent.js` when GOOSE_BIN=fake.
 */

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

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

import { ACP_INTERRUPT_META, ACP_INTERRUPT_RESULT_META } from "./acp/client.js";
import { fakeMediaImages } from "./fakeMedia.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every skill the host wrote into `cwd`, for goose or the SDK. */
function skillsText(cwd: string | undefined): string {
  if (!cwd) return "";
  const read = (f: string) => {
    try {
      return readFileSync(f, "utf8");
    } catch {
      return "";
    }
  };
  const dir = join(cwd, ".claude", "skills");
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    // No SDK skills directory.
  }
  return [read(join(cwd, ".goosehints")), ...names.map((n) => read(join(dir, n, "SKILL.md")))].join("\n");
}

/** How long a `~subagent` child stays running, which must outlast the spec asserting on it since the host end()s a subagent as soon as it completes. */
const SUBAGENT_LIFETIME_S = 90;

/** Wrap `s` so `sh -c` sees it as one literal argument, whatever it contains. */
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** One ACP session update, as the connection takes it. */
type SessionUpdate = Parameters<AgentSideConnection["sessionUpdate"]>[0]["update"];

class FakeAgent implements Agent {
  constructor(private conn: AgentSideConnection) {}

  /** Sessions that have already received their first prompt, so the <title> marker is emitted only on the first reply. */
  private titled = new Set<string>();
  // Each tool call gets a fresh id, as real ACP agents mint one per call.
  private readonly toolCallNonce = randomUUID().slice(0, 8);
  private toolCallSeq = 0;
  private nextToolCallId(): string {
    return `call_${this.toolCallNonce}_${++this.toolCallSeq}`;
  }
  /** The per-session model from newSession. */
  private sessionModel = new Map<string, string>();
  /** The per-session cwd, where the host writes the skills. */
  private sessionCwd = new Map<string, string>();
  /** Offered MCP servers per session, by name. */
  private mcp = new Map<string, Map<string, { url: string; headers: Record<string, string> }>>();

  /** Names the session on its first reply, as a real agent would. */
  private async emitTitleOnce(sessionId: string, text: string, u: (update: SessionUpdate) => Promise<unknown>): Promise<void> {
    if (this.titled.has(sessionId)) return;
    this.titled.add(sessionId);
    await u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `<title>${text.slice(0, 40).trim()}</title>` } });
    await sleep(40);
  }

  async initialize(_p: InitializeRequest): Promise<InitializeResponse> {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: false } };
  }

  async newSession(p: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = `fake-${Math.random().toString(36).slice(2, 10)}`;
    const offered =
      (
        p as {
          mcpServers?: Array<{ name?: string; url?: string; headers?: Array<{ name: string; value: string }> }>;
        }
      ).mcpServers ?? [];
    const reqModel = (p as { model?: string }).model;
    if (typeof reqModel === "string" && reqModel) this.sessionModel.set(sessionId, reqModel);
    if (typeof p.cwd === "string" && p.cwd) this.sessionCwd.set(sessionId, p.cwd);
    const servers = new Map<string, { url: string; headers: Record<string, string> }>();
    for (const srv of offered) {
      if (typeof srv.url !== "string" || !srv.name) continue;
      servers.set(srv.name, {
        url: srv.url,
        headers: Object.fromEntries((srv.headers ?? []).map((h) => [h.name, h.value])),
      });
    }
    this.mcp.set(sessionId, servers);
    return { sessionId };
  }

  /** Call a tool on an offered MCP server with the official client. */
  private async callTool(sessionId: string, server: string, name: string, args: Record<string, unknown>): Promise<string> {
    const srv = this.mcp.get(sessionId)?.get(server);
    if (!srv) return `no ${server} MCP endpoint was offered to this session`;
    const client = new Client({ name: "scooter-fake-agent", version: "0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(srv.url), { requestInit: { headers: srv.headers } }),
      );
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as Array<{ type: string; text?: string }>)
        .map((c) => c.text ?? "")
        .join("\n")
        .trim();
      return res.isError ? `MCP ${name} error: ${text}` : text;
    } catch (err) {
      return `MCP ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      await client.close().catch(() => {});
    }
  }

  async authenticate(_p: AuthenticateRequest): Promise<void> {
    return;
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const sessionId = params.sessionId;
    // The user's actual message is the last text block; a revived session prepends a
    // history preamble as an earlier block.
    const textBlocks = params.prompt.filter((b) => b.type === "text").map((b) => b.text);
    const userText = (textBlocks.at(-1) ?? "").trim() || "(no text)";

    const u = (update: SessionUpdate) =>
      this.conn.sessionUpdate({ sessionId, update });

    // A "??<question>" message is a test directive: raise an `ask-user.questions` request (the
    // ask-user contrib's card) over the permission round-trip's _meta and report the answer.
    if (userText.startsWith("??")) {
      const question = userText.slice(2).trim() || "Which database should we use?";
      const res = (await this.conn.requestPermission({
        sessionId,
        toolCall: { toolCallId: this.nextToolCallId(), title: question } as never,
        options: [{ optionId: "answer", name: "Answer", kind: "allow_once" }],
        _meta: {
          [ACP_INTERRUPT_META]: {
            kind: "ask-user.questions",
            data: {
              questions: [
                {
                  question,
                  header: "Database",
                  options: [
                    { label: "Postgres", description: "Relational, the default" },
                    { label: "SQLite", description: "Embedded, zero setup" },
                  ],
                  multiSelect: false,
                },
              ],
            },
          },
        },
      } as never)) as { outcome: { outcome: string }; _meta?: Record<string, unknown> };
      const result = res._meta?.[ACP_INTERRUPT_RESULT_META] as { answers?: Record<string, string> } | undefined;
      const answers = result?.answers;
      const reply =
        res.outcome.outcome === "selected" && answers
          ? `🤖 (dummy agent) you answered: ${answers[question] ?? "(missing)"}`
          : "🤖 (dummy agent) question dismissed";
      for (const word of reply.split(" ")) {
        await u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: word + " " } });
        await sleep(20);
      }
      return { stopReason: "end_turn" };
    }

    // A "?<prompt>" message is a test directive: present an option choice via the ACP
    // permission round-trip and report the picked option.
    if (userText.startsWith("?")) {
      const question = userText.slice(1).trim() || "Choose an option";
      const res = (await this.conn.requestPermission({
        sessionId,
        toolCall: { toolCallId: this.nextToolCallId(), title: question } as never,
        options: [
          { optionId: "red", name: "Red", kind: "allow_once" },
          { optionId: "green", name: "Green", kind: "allow_once" },
          { optionId: "blue", name: "Blue", kind: "allow_once" },
        ],
      } as never)) as { outcome: { outcome: string; optionId?: string } };
      const picked =
        res.outcome.outcome === "selected" ? res.outcome.optionId : "(cancelled)";
      const reply = `🤖 (dummy agent) you picked: ${picked}`;
      for (const word of reply.split(" ")) {
        await u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: word + " " } });
        await sleep(20);
      }
      return { stopReason: "end_turn" };
    }

    // "~call <server> <tool> [json-args]": a real tool call.
    if (userText.startsWith("~call ")) {
      const [, server, tool, ...rest] = userText.split(/\s+/);
      let args: Record<string, unknown> = {};
      try {
        args = rest.length ? (JSON.parse(rest.join(" ")) as Record<string, unknown>) : {};
      } catch {
        args = {};
      }
      const out = await this.callTool(sessionId, server ?? "", tool ?? "", args);
      // Else the title Stop hook adds a second reply.
      await this.emitTitleOnce(sessionId, userText, u);
      await u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `call ${server} ${tool}: ${out}` } });
      return { stopReason: "end_turn" };
    }

    // A "~model" message is a test directive: report the GOOSE_MODEL this process was launched with.
    if (userText.startsWith("~model")) {
      // The session's model; GOOSE_MODEL is fixed at launch.
      await this.emitTitleOnce(sessionId, userText, u);
      const reply = `model=${this.sessionModel.get(sessionId) ?? process.env.GOOSE_MODEL ?? "(default)"}`;
      for (const word of reply.split(" ")) {
        await u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: word + " " } });
        await sleep(10);
      }
      return { stopReason: "end_turn" };
    }

    // "~hints <text>": report whether this session's skills contain <text>.
    if (userText.startsWith("~hints")) {
      await this.emitTitleOnce(sessionId, userText, u);
      const needle = userText.slice("~hints".length).trim();
      const reply = skillsText(this.sessionCwd.get(sessionId)).includes(needle) ? "hints=present" : "hints=absent";
      await u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } });
      return { stopReason: "end_turn" };
    }

    // A "~images" message is a test directive: report how many image content blocks reached this prompt.
    if (userText.startsWith("~images")) {
      const count = params.prompt.filter((b) => b.type === "image").length;
      await this.emitTitleOnce(sessionId, userText, u);
      const reply = `images=${count}`;
      for (const word of reply.split(" ")) {
        await u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: word + " " } });
        await sleep(10);
      }
      return { stopReason: "end_turn" };
    }

    // A "~media" message is a test directive for inline media: a tool call whose result
    // carries two images, an image sent inline in the agent's message, and markdown with a
    // data: image (loads), a remote image (click to load) and an SVG (never loads).
    if (userText.startsWith("~media")) {
      const img = fakeMediaImages();
      const toolCallId = this.nextToolCallId();
      await u({ sessionUpdate: "tool_call", toolCallId, title: "screenshot", kind: "other", status: "pending", rawInput: { url: "http://localhost:3000" } } as never);
      await sleep(150);
      await u({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "Captured 2 screenshots." } },
          { type: "content", content: { type: "image", mimeType: "image/png", data: img.toolA } },
          { type: "content", content: { type: "image", mimeType: "image/png", data: img.toolB } },
        ],
      } as never);
      await sleep(150);
      await u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Here is the rendered page:\n\n" } });
      await u({ sessionUpdate: "agent_message_chunk", content: { type: "image", mimeType: "image/png", data: img.inline } } as never);
      const md = [
        "",
        "A data: image (loads): ![tiny](data:image/png;base64," + img.tiny + ")",
        "",
        "A remote image (click to load): ![remote](https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png)",
        "",
        "An SVG (never loads): ![svg](https://upload.wikimedia.org/wikipedia/commons/0/02/SVG_logo.svg)",
      ].join("\n");
      await u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: md } });
      return { stopReason: "end_turn" };
    }

    // A "~video" message is a test directive: a show_video result pointing at an asset
    // the e2e spec serves itself, since the fake stack has no sandbox to read from.
    if (userText.startsWith("~video")) {
      const toolCallId = this.nextToolCallId();
      const path = "/workspace/demo.webm";
      await u({ sessionUpdate: "tool_call", toolCallId, title: "show_video", kind: "other", status: "pending", rawInput: { path } } as never);
      await sleep(150);
      const url = "/conversations/fake/assets/fake-demo.webm";
      const ref = JSON.stringify({ type: "video", mimeType: "video/webm", assetId: "fake-demo.webm", url });
      await u({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: ref } },
          { type: "content", content: { type: "text", text: `Showing ${path} to the user as an inline video.` } },
        ],
      } as never);
      await u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Here's the recording." } });
      return { stopReason: "end_turn" };
    }

    // A "~tools" message is a test directive: runs of tool calls around prose, one message each.
    if (userText.startsWith("~tools")) {
      const tool = async (title: string, kind: string, rawInput: unknown, out: string) => {
        const toolCallId = this.nextToolCallId();
        await u({ sessionUpdate: "tool_call", toolCallId, title, kind, status: "pending", rawInput } as never);
        await sleep(60);
        await u({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: out } }],
        } as never);
      };
      const say = (text: string) => u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
      await u({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Find where the notebook loads its data." } });
      await tool("grep", "search", { pattern: "read_parquet", path: "/workspace" }, "notebook.py:14: df = pd.read_parquet(SRC)\nnotebook.py:52: ref = pd.read_parquet(REF)");
      await tool("read_file", "read", { path: "/workspace/notebook.py" }, "import marimo as mo\nimport pandas as pd\n\nSRC = 's3://metrics/daily.parquet'\n…");
      await tool("bash", "execute", { command: "python -c 'import pandas; print(pandas.__version__)'" }, "2.2.3");
      await say("The notebook reads two parquet files, and the second one (`REF`) is the slow one:\n\n");
      await say("- **`SRC`** — daily metrics, ~40 MB, cached after the first run\n- **`REF`** — reference table, ~1.2 GB, re-read on every cell change\n\n");
      await say("I'll move the `REF` load into its own cell so marimo only re-runs it when the path changes.\n\n");
      await tool("edit", "edit", { path: "/workspace/notebook.py" }, "Replaced 3 lines.");
      await tool("bash", "execute", { command: "marimo check notebook.py" }, "ok");
      await say("Done. Changing a filter now re-runs in **~0.3s** instead of ~9s. Want me to add a cache for `SRC` too?");
      return { stopReason: "end_turn" };
    }

    // A "~subagent <title>" message is a test directive: spawn a real subagent via the
    // scooter-env MCP tool, whose child sleeps because the host end()s it as soon as its run completes.
    if (userText.startsWith("~subagent")) {
      const title = userText.slice("~subagent".length).trim() || "research task";
      await u({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Delegating…" } });
      const out = await this.callTool(sessionId, "scooter-env", "spawn_subagent", {
        prompt: `!sleep ${SUBAGENT_LIFETIME_S}`,
        title,
      });
      const reply = `🤖 (dummy agent) spawned a subagent: ${out}`;
      for (const word of reply.split(" ")) {
        await u({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: word + " " } });
        await sleep(10);
      }
      return { stopReason: "end_turn" };
    }

    // A "!<command>" message is a test directive: run <command> verbatim in the sandbox
    // and report its output; anything else gets an echo.
    const isCommand = userText.startsWith("!");
    // Quote the echoed prose so shell metacharacters reach echo as one literal argument;
    // the "!<command>" directive is deliberately unquoted.
    const command = isCommand ? userText.slice(1).trim() : `echo ${shellQuote(userText)}`;

    // 1. a thought
    await u({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Planning a response…" } });
    await sleep(300);

    // 2. a real tool call through createTerminal, the bridge ACP client and the ExecBackend
    let cmdOutput = "";
    let exitCode = 0;
    const toolCallId = this.nextToolCallId();
    // Match real goose's shell shape: the tool_call carries no rawInput, the command runs
    // via terminal/create, and the terminal is handed off as the tool_call_update content.
    await u({
      sessionUpdate: "tool_call",
      toolCallId,
      title: `run: ${command}`,
      kind: "execute",
      status: "pending",
    } as never);
    let terminalId = "";
    try {
      const term = await this.conn.createTerminal({
        sessionId,
        command: "sh",
        args: ["-c", command],
      });
      terminalId = term.id;
      // Hand off the live terminal, with no rawInput.
      await u({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: [{ type: "terminal", terminalId }],
      } as never);
      const exit = await term.waitForExit();
      exitCode = exit.exitCode ?? 0;
      const out = await term.currentOutput();
      cmdOutput = out.output ?? "";
      await term.release();
    } catch (e) {
      cmdOutput = `exec error: ${String(e)}`;
      exitCode = 1;
    }
    // The real finish, carrying the command's output as content.
    await u({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: exitCode === 0 ? "completed" : "failed",
      content: [{ type: "content", content: { type: "text", text: cmdOutput } }],
    } as never);
    await sleep(200);

    // The first reply in a session emits a <title> marker derived from the user's request.
    await this.emitTitleOnce(sessionId, isCommand ? command : userText, u);

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
