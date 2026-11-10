/**
 * ConversationView: one Scooter conversation shown as one AHP session with one chat.
 *
 * The conversation's AG-UI event log (history + live) is mapped to AHP chat actions and
 * published through the protocol core, whose reducers build the turns. Client prompts and
 * cancels go to the router; tool approvals are rejected (they stay in the Scooter web UI,
 * since anything in the pod could otherwise self-approve).
 */
import type { ProtocolCore } from "./vendor/hydra-ahp/protocol/core.js";
import type { ActionDecision, ActionRequest } from "./vendor/hydra-ahp/protocol/backend.js";
import { CommentStripper } from "./commentStripper.js";

/** The router's self-access API for one conversation. */
export interface ScooterApi {
  /** Stream the conversation's AG-UI events: full replay, then live. Calls onEvent per event; resolves when the stream ends. */
  stream(onEvent: (ev: AguiEvent) => void, signal: AbortSignal): Promise<void>;
  sendMessage(text: string): Promise<void>;
  cancel(): Promise<void>;
}

export type AguiEvent = { type: string; [k: string]: any };

/** The agent whose chats are all this conversation. */
export const PROVIDER = "scooter";
/** The agent whose every chat is its own session conversation. */
export const SESSION_PROVIDER = "scooter-session";
/** The system-message source VS Code's prompts carry, so the agent knows where they came from. */
export const MESSAGE_SOURCE = "vscode";

/** A router refusal: the conversation is gone or not ours. */
export class RouterRefused extends Error {
  constructor(readonly status: number, what: string) { super(`${what}: ${status}`); }
}
const DEFAULT_CHAT_PREFIX = "ahp-chat://default/";
const IDLE = 1;
export const chatOf = (session: string) => DEFAULT_CHAT_PREFIX + Buffer.from(session, "utf8").toString("base64url");
const A = (v: Record<string, unknown>) => v as never;

export interface ConversationViewOptions {
  /** The AHP session URI VS Code knows this conversation by. */
  uri: string;
  conversationId: string;
  title: string;
  /** The agent this chat belongs to. */
  provider: string;
  directory: string;
  /** Link back to this conversation in the Scooter web UI. */
  conversationUrl?: string;
  api: ScooterApi;
  log?: (msg: string) => void;
}

export class ConversationView {
  readonly uri: string;
  readonly chat: string;
  private readonly abort = new AbortController();
  private readonly createdAt = new Date().toISOString();

  // Mapping state.
  private openTurn: string | undefined;
  private turnStartMs = 0;
  private turnSeq = 0;
  private userText = new Map<string, string>();
  private replyText = new Map<string, CommentStripper>();
  private toolArgs = new Map<string, { name: string; args: string }>();
  /** Turns VS Code started and sent to the router, by text, awaiting their echo in the log. */
  private pendingClientTurns: Array<{ turnId: string; text: string }> = [];

  constructor(private readonly core: ProtocolCore, readonly opts: ConversationViewOptions) {
    this.uri = opts.uri;
    this.chat = chatOf(opts.uri);
  }

  get conversationId(): string { return this.opts.conversationId; }
  get title(): string { return this.opts.title; }
  set title(t: string) { this.opts.title = t; }

  /** Points a session that had no conversation yet at the one just started for it. */
  bind(conversationId: string, title: string, conversationUrl?: string): void {
    Object.assign(this.opts, { conversationId, title, conversationUrl });
  }

  /** Creates the session and chat channels and starts mapping the conversation's events. */
  start(): void {
    const now = new Date().toISOString();
    const { title, directory } = this.opts;
    this.core.createChannel(this.chat, A({ resource: this.chat, title, status: IDLE, modifiedAt: now, turns: [] }));
    this.core.createChannel(this.uri, A({
      provider: this.opts.provider, title, status: IDLE, lifecycle: "ready", activeClients: [],
      chats: [{ resource: this.chat, title, status: IDLE, modifiedAt: now }], defaultChat: this.chat,
      workingDirectories: [directory],
    }));
    void this.pump();
  }

  /** Stops the event pump and removes the channels. */
  remove(): void {
    this.abort.abort();
    this.core.removeChannel(this.chat);
    this.core.removeChannel(this.uri);
  }

  summary() {
    const { title, directory } = this.opts;
    return A({
      resource: this.uri, provider: this.opts.provider, title,
      status: IDLE, createdAt: this.createdAt, modifiedAt: new Date().toISOString(),
      chats: [{ resource: this.chat, title }],
      defaultChat: this.chat,
      workingDirectories: [directory],
      project: { uri: directory, displayName: "workspace" },
    });
  }

  // ── Client → Scooter ───────────────────────────────────────────────────

  async handleAction(req: ActionRequest): Promise<ActionDecision> {
    const a = req.action as unknown as Record<string, any>;
    switch (a.type) {
      case "chat/turnStarted": {
        const text: string = a.message?.text ?? "";
        if (!text.trim()) return { accept: false, reason: "empty message" };
        // Remember it BEFORE sending: the router's echo can arrive before the POST returns.
        const pending = { turnId: a.turnId, text };
        this.pendingClientTurns.push(pending);
        // The core applies the client's action itself once accepted.
        if (this.openTurn) this.endTurn("complete");
        this.openTurn = a.turnId;
        this.turnStartMs = Date.now();
        // Accept now so the turn opens at once; fail it if the router rejects the message.
        this.opts.api.sendMessage(text).catch((e) => {
          this.pendingClientTurns = this.pendingClientTurns.filter((p) => p !== pending);
          if (this.openTurn === a.turnId) this.endTurn("error", `Scooter rejected the message: ${(e as Error).message}`);
        });
        return { accept: true };
      }
      case "chat/turnCancelled":
        await this.opts.api.cancel().catch(() => {});
        if (this.openTurn === a.turnId) this.openTurn = undefined;
        return { accept: true };
      case "chat/toolCallConfirmed":
        return { accept: false, reason: "Approve or deny this in the Scooter web UI." };
      default:
        return { accept: true };
    }
  }

  // ── Scooter → AHP ──────────────────────────────────────────────────────

  private emit(action: Record<string, unknown>): void {
    this.core.publish(this.chat, A(action));
  }

  private beginTurn(turnId: string, text: string, kind: "user" | "systemNotification"): void {
    if (this.openTurn) this.endTurn("complete");
    this.openTurn = turnId;
    this.turnStartMs = Date.now();
    this.emit({ type: "chat/turnStarted", turnId, startedAt: new Date().toISOString(), message: { text, origin: { kind } } });
  }

  private reply(messageId: string, content: string): void {
    if (content) this.emit({ type: "chat/delta", turnId: this.ensureTurn(), partId: messageId, content });
  }

  private ensureTurn(): string {
    if (!this.openTurn) this.beginTurn(`scooter-turn-${++this.turnSeq}`, "", "systemNotification");
    return this.openTurn!;
  }

  private endTurn(how: "complete" | "cancelled" | "error", message?: string): void {
    const turnId = this.openTurn;
    if (!turnId) return;
    const duration = Math.max(0, Date.now() - this.turnStartMs);
    if (how === "complete") this.emit({ type: "chat/turnComplete", turnId, duration });
    else if (how === "cancelled") this.emit({ type: "chat/turnCancelled", turnId, duration });
    else this.emit({ type: "chat/error", turnId, duration, part: { kind: "error", error: { errorType: "run_error", message: message ?? "Run failed" } } });
    this.openTurn = undefined;
  }

  /** Map one AG-UI event from the conversation log. */
  map(ev: AguiEvent): void {
    switch (ev.type) {
      case "TEXT_MESSAGE_START":
        if (ev.role === "user") this.userText.set(ev.messageId, "");
        else {
          this.replyText.set(ev.messageId, new CommentStripper());
          this.emit({ type: "chat/responsePart", turnId: this.ensureTurn(), part: { kind: "markdown", id: ev.messageId, content: "" } });
        }
        return;
      case "TEXT_MESSAGE_CONTENT":
        if (this.userText.has(ev.messageId)) this.userText.set(ev.messageId, this.userText.get(ev.messageId)! + ev.delta);
        else this.reply(ev.messageId, this.replyText.get(ev.messageId)?.push(ev.delta) ?? ev.delta);
        return;
      case "TEXT_MESSAGE_END": {
        const stripper = this.replyText.get(ev.messageId);
        if (stripper) { this.replyText.delete(ev.messageId); this.reply(ev.messageId, stripper.end()); }
        const text = this.userText.get(ev.messageId);
        if (text === undefined) return;
        this.userText.delete(ev.messageId);
        if (this.adoptClientTurn(text)) return;
        this.beginTurn(`scooter-${ev.messageId}`, text, "user");
        return;
      }
      case "SYSTEM_MESSAGE":
        // A prompt sent from VS Code comes back as a system message from the pod.
        if (ev.source === MESSAGE_SOURCE && this.adoptClientTurn(ev.text ?? "")) return;
        if (ev.source === MESSAGE_SOURCE) { this.beginTurn(`scooter-${ev.messageId}`, ev.text ?? "", "user"); return; } // another chat's prompt
        return; // platform events (hooks, CI, resumes) are noise in an editor chat
      case "REASONING_MESSAGE_START":
        this.emit({ type: "chat/responsePart", turnId: this.ensureTurn(), part: { kind: "reasoning", id: ev.messageId, content: "" } });
        return;
      case "REASONING_MESSAGE_CONTENT":
        this.emit({ type: "chat/reasoning", turnId: this.ensureTurn(), partId: ev.messageId, content: ev.delta });
        return;
      case "TOOL_CALL_START":
        this.toolArgs.set(ev.toolCallId, { name: ev.toolCallName, args: "" });
        this.emit({ type: "chat/toolCallStart", turnId: this.ensureTurn(), toolCallId: ev.toolCallId, toolName: ev.toolCallName, displayName: prettyTool(ev.toolCallName) });
        return;
      case "TOOL_CALL_ARGS": {
        const t = this.toolArgs.get(ev.toolCallId);
        if (t) t.args += ev.delta;
        return;
      }
      case "TOOL_CALL_END": {
        const t = this.toolArgs.get(ev.toolCallId);
        this.emit({ type: "chat/toolCallReady", turnId: this.ensureTurn(), toolCallId: ev.toolCallId, invocationMessage: describeTool(t?.name, t?.args), confirmed: "not-needed" });
        return;
      }
      case "TOOL_CALL_RESULT": {
        const t = this.toolArgs.get(ev.toolCallId);
        this.toolArgs.delete(ev.toolCallId);
        const content = String(ev.content ?? "");
        this.emit({ type: "chat/toolCallComplete", turnId: this.ensureTurn(), toolCallId: ev.toolCallId, result: {
          success: true, pastTenseMessage: `Ran ${prettyTool(t?.name)}`,
          content: [{ type: "text", text: content.length > 4000 ? content.slice(0, 4000) + "\n…(truncated)" : content }],
        } });
        return;
      }
      case "RUN_FINISHED":
        if (ev.outcome?.type === "interrupt") {
          const link = this.opts.conversationUrl ? ` [Open Scooter](${this.opts.conversationUrl})` : "";
          const id = `approval-${Date.now()}`;
          this.emit({ type: "chat/responsePart", turnId: this.ensureTurn(), part: { kind: "markdown", id, content: `\n\n> ⏸ **Waiting for approval** — answer it in the Scooter web UI.${link}\n` } });
          return; // the run resumes in the same turn once answered
        }
        this.endTurn("complete");
        return;
      case "RUN_ERROR":
        this.ensureTurn();
        this.endTurn("error", ev.message);
        return;
      case "CANCEL_REQUESTED":
        this.endTurn("cancelled");
        return;
      default:
        return; // QUEUE_UPDATED, CONTEXT_USAGE, PERMISSION_RESOLVED, … not surfaced yet
    }
  }

  /** Whether the log's echo of a prompt matches a turn VS Code already opened (this chat's or not). */
  private adoptClientTurn(text: string): boolean {
    const i = this.pendingClientTurns.findIndex((p) => p.text === text);
    if (i < 0) return false;
    this.pendingClientTurns.splice(i, 1);
    return true;
  }

  private async pump(): Promise<void> {
    // The events endpoint replays the full log on every connect; skip what we've mapped.
    let seen = 0;
    let delay = 1000;
    while (!this.abort.signal.aborted) {
      let i = 0;
      try {
        await this.opts.api.stream((ev) => { if (i++ >= seen) { seen++; this.map(ev); } }, this.abort.signal);
      } catch (e) {
        if (this.abort.signal.aborted) return;
        if (e instanceof RouterRefused) {
          this.opts.log?.(`${this.conversationId}: stopped following: ${e.message}`);
          this.endTurn("error", `Scooter refused this conversation (${e.status}).`);
          return;
        }
        this.opts.log?.(`${this.conversationId}: event stream error: ${(e as Error).message}`);
      }
      // Back off while unreachable; any delivered event resets it.
      delay = i > 0 ? 2000 : Math.min(delay * 2, 30_000);
      if (!this.abort.signal.aborted) await new Promise((r) => setTimeout(r, delay));
    }
  }

  stop(): void { this.abort.abort(); }
}

function prettyTool(name?: string): string {
  if (!name) return "tool";
  return name.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ");
}

function describeTool(name?: string, args?: string): string {
  let detail = "";
  try {
    const parsed = JSON.parse(args || "{}");
    detail = parsed.command ?? parsed.description ?? parsed.path ?? parsed.file_path ?? parsed.query ?? "";
  } catch { /* partial or non-JSON args */ }
  detail = String(detail);
  return detail ? `${prettyTool(name)}: \`${detail.length > 200 ? detail.slice(0, 200) + "…" : detail}\`` : prettyTool(name);
}
