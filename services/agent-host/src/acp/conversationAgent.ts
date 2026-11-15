/**
 * One conversation served as an ACP agent, the reverse of acp/client.ts: here agent-host is the
 * agent and an ACP client in the browser (an editor's agent panel) talks to it. The ACP session id is the
 * conversation id. Prompts become the user's messages in the conversation; its AG-UI log, the
 * recent turns and then live events, becomes `session/update`s; a pending permission or
 * AskUserQuestion becomes `session/request_permission`, answered as the connected user.
 * Anything the panel can't draw is a short note pointing at the full chat.
 */

import type { AguiEvent, AguiInterrupt } from "../bridge.js";

/** ACP protocol version spoken. */
export const ACP_PROTOCOL_VERSION = 1;

/** User turns replayed when a session opens. */
export const REPLAY_USER_TURNS = 1;

/** Longer tool output is cut, so it doesn't flood the panel. */
const MAX_TOOL_OUTPUT = 4000;

/** The whole log, then live appends, with no gap or repeat. */
export interface ConversationFeed {
  open(onLive: (ev: AguiEvent) => void): Promise<{ history: AguiEvent[]; close(): void }>;
}

/** The conversation, acted on as the socket's user. */
export interface ConversationPort {
  conversationId: string;
  feed: ConversationFeed;
  send(text: string): Promise<void>;
  cancel(): Promise<void>;
  /** False once the interrupt no longer awaits an answer. */
  answer(interruptId: string, optionId: string, result?: Record<string, unknown>): Promise<boolean>;
  /** The full chat, linked for what the panel can't show. */
  conversationUrl?: string;
  log?: (msg: string, err?: unknown) => void;
}

/** One JSON-RPC message frame out to the client. */
export type AcpSend = (msg: Record<string, unknown>) => void;

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** Newline-delimited JSON-RPC 2.0 both ways over one message channel. */
export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buf = "";

  constructor(
    private readonly out: AcpSend,
    private readonly handlers: {
      request(method: string, params: any): Promise<unknown>;
      notify(method: string, params: any): void;
    },
  ) {}

  /** A frame may hold several messages, or part of one. */
  receive(chunk: string): void {
    this.buf += chunk.endsWith("\n") ? chunk : chunk + "\n";
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        this.out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: any): void {
    if (typeof msg?.method === "string") {
      if (msg.id === undefined || msg.id === null) {
        this.handlers.notify(msg.method, msg.params);
        return;
      }
      this.handlers.request(msg.method, msg.params).then(
        (result) => this.out({ jsonrpc: "2.0", id: msg.id, result: result ?? null }),
        (err: unknown) => {
          const code = err instanceof RpcError ? err.code : -32603;
          this.out({ jsonrpc: "2.0", id: msg.id, error: { code, message: (err as Error)?.message ?? String(err) } });
        },
      );
      return;
    }
    const p = typeof msg?.id === "number" ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new RpcError(msg.error.code ?? -32603, msg.error.message ?? "error"));
    else p.resolve(msg.result);
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.out({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.out({ jsonrpc: "2.0", method, params });
  }

  /** Fail requests still waiting on a closed socket. */
  close(): void {
    for (const p of this.pending.values()) p.reject(new Error("connection closed"));
    this.pending.clear();
  }
}

type StopReason = "end_turn" | "cancelled";

/** The panel's prompt, waiting for its own run to end. */
interface OpenPrompt {
  text: string;
  /** Logged, so the next run end is its own. */
  echoed: boolean;
  cancelled: boolean;
  resolve: (r: { stopReason: StopReason }) => void;
}

interface AskOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: Array<{ label: string; description?: string }>;
}

const OPTION_KINDS = new Set(["allow_once", "allow_always", "reject_once", "reject_always"]);

export class ConversationAgent {
  readonly peer: JsonRpcPeer;
  private feed: { close(): void } | undefined;
  /** Bumped per session open, so a stale replay stops. */
  private generation = 0;
  private live = false;
  private prompt: OpenPrompt | undefined;

  // Mapping state over the conversation's events.
  private userText = new Map<string, string>();
  private replies = new Map<string, CommentStripper>();
  private tools = new Map<string, { name: string; args: string }>();

  // Interrupts awaiting an answer, and those already asked.
  private openInterrupts = new Map<string, AguiInterrupt>();
  private asked = new Set<string>();
  private asking: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly port: ConversationPort, send: AcpSend) {
    this.peer = new JsonRpcPeer(send, {
      request: (m, p) => this.handleRequest(m, p),
      notify: (m, p) => this.handleNotify(m, p),
    });
  }

  /** The socket went away: stop following the log and settle the open prompt. */
  close(): void {
    this.closed = true;
    this.feed?.close();
    this.feed = undefined;
    this.peer.close();
    this.prompt?.resolve({ stopReason: "cancelled" });
    this.prompt = undefined;
  }

  // ── client → conversation ───────────────────────────────────────────────

  private async handleRequest(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
          },
          authMethods: [],
        };
      case "session/new":
        // Replay after the response, which carries the session id.
        setImmediate(() => void this.openSession().catch((e) => this.port.log?.("acp: replay failed", e)));
        return { sessionId: this.port.conversationId };
      case "session/load":
        this.checkSession(params);
        await this.openSession();
        return {};
      case "session/prompt":
        this.checkSession(params);
        return this.handlePrompt(params?.prompt);
      default:
        throw new RpcError(-32601, `method not found: ${method}`);
    }
  }

  private handleNotify(method: string, params: any): void {
    if (method !== "session/cancel" || params?.sessionId !== this.port.conversationId) return;
    if (this.prompt && !this.prompt.echoed) {
      // Still queued: it may yet run, but this request is over.
      this.prompt.resolve({ stopReason: "cancelled" });
      this.prompt = undefined;
    } else if (this.prompt) {
      this.prompt.cancelled = true;
    }
    void this.port.cancel().catch((e) => this.port.log?.("acp: cancel failed", e));
  }

  private checkSession(params: any): void {
    if (params?.sessionId !== this.port.conversationId) throw new RpcError(-32602, "unknown session");
  }

  private async handlePrompt(blocks: unknown): Promise<{ stopReason: StopReason }> {
    const text = promptText(Array.isArray(blocks) ? blocks : []);
    if (!text.trim()) throw new RpcError(-32602, "empty prompt");
    if (this.prompt) throw new RpcError(-32600, "a prompt is already running");
    return new Promise((resolve, reject) => {
      const open: OpenPrompt = { text, echoed: false, cancelled: false, resolve: (r) => { if (this.prompt === open) this.prompt = undefined; resolve(r); } };
      this.prompt = open;
      this.port.send(text).catch((e: unknown) => {
        if (this.prompt === open) this.prompt = undefined;
        reject(new RpcError(-32603, `Scooter didn't take the message: ${(e as Error)?.message ?? e}`));
      });
    });
  }

  /** (Re)start following the log: replay the recent turns, then go live. */
  private async openSession(): Promise<void> {
    const gen = ++this.generation;
    this.feed?.close();
    this.live = false;
    this.userText.clear();
    this.replies.clear();
    this.tools.clear();
    this.openInterrupts.clear();
    this.asked.clear();
    const backlog: AguiEvent[] = [];
    const { history, close } = await this.port.feed.open((ev) => {
      if (gen !== this.generation) return;
      if (this.live) this.map(ev, false);
      else backlog.push(ev);
    });
    if (gen !== this.generation || this.closed) return close();
    this.feed = { close };
    for (const ev of history) trackInterrupt(this.openInterrupts, ev);
    const start = replayStart(history);
    if (start > 0) this.noteEarlier();
    for (const ev of history.slice(start)) this.map(ev, true);
    for (const ev of backlog) this.map(ev, false);
    this.live = true;
    for (const intr of this.openInterrupts.values()) this.ask(intr);
  }

  // ── conversation → client ───────────────────────────────────────────────

  private update(update: Record<string, unknown>): void {
    if (this.closed) return;
    this.peer.notify("session/update", { sessionId: this.port.conversationId, update });
  }

  private say(text: string): void {
    if (text) this.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  }

  /** Map one AG-UI event; history asks and ends nothing. */
  map(ev: AguiEvent, replay: boolean): void {
    const e = ev as any;
    if (!replay) trackInterrupt(this.openInterrupts, ev);
    switch (ev.type) {
      case "TEXT_MESSAGE_START":
        if (e.role === "user") this.userText.set(e.messageId, "");
        else this.replies.set(e.messageId, new CommentStripper());
        return;
      case "TEXT_MESSAGE_CONTENT": {
        const user = this.userText.get(e.messageId);
        if (user !== undefined) this.userText.set(e.messageId, user + e.delta);
        else this.say(this.replies.get(e.messageId)?.push(e.delta) ?? e.delta);
        return;
      }
      case "TEXT_MESSAGE_END": {
        const stripper = this.replies.get(e.messageId);
        if (stripper) {
          this.replies.delete(e.messageId);
          this.say(stripper.end());
        }
        const text = this.userText.get(e.messageId);
        if (text === undefined) return;
        this.userText.delete(e.messageId);
        // The panel already shows its own prompt.
        if (!replay && this.prompt && !this.prompt.echoed && isEcho(text, this.prompt.text)) {
          this.prompt.echoed = true;
          return;
        }
        this.update({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
        return;
      }
      case "REASONING_MESSAGE_CONTENT":
        this.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: e.delta } });
        return;
      case "TOOL_CALL_START":
        this.tools.set(e.toolCallId, { name: e.toolCallName, args: "" });
        this.update({
          sessionUpdate: "tool_call",
          toolCallId: e.toolCallId,
          title: prettyTool(e.toolCallName),
          kind: toolKind(e.toolCallName),
          status: "in_progress",
        });
        return;
      case "TOOL_CALL_ARGS": {
        const t = this.tools.get(e.toolCallId);
        if (t) t.args += e.delta;
        return;
      }
      case "TOOL_CALL_END": {
        const t = this.tools.get(e.toolCallId);
        if (!t) return;
        this.update({
          sessionUpdate: "tool_call_update",
          toolCallId: e.toolCallId,
          title: describeTool(t.name, t.args),
          ...(parseArgs(t.args) !== undefined ? { rawInput: parseArgs(t.args) } : {}),
        });
        return;
      }
      case "TOOL_CALL_RESULT": {
        this.tools.delete(e.toolCallId);
        const content = String(e.content ?? "");
        this.update({
          sessionUpdate: "tool_call_update",
          toolCallId: e.toolCallId,
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: truncate(content) } }],
        });
        return;
      }
      case "RUN_FINISHED":
        if (e.outcome?.type === "interrupt") {
          if (!replay) for (const intr of e.outcome.interrupts as AguiInterrupt[]) this.ask(intr);
          return;
        }
        if (!replay) this.endPrompt(e.cancelled ? "cancelled" : "end_turn");
        return;
      case "RUN_ERROR":
        this.say(`\n\n⚠️ ${e.message ?? "The run failed."}\n`);
        if (!replay) this.endPrompt("end_turn");
        return;
      case "CANCEL_REQUESTED":
        if (!replay && this.prompt?.echoed) this.prompt.cancelled = true;
        return;
      default:
        return;
    }
  }

  private endPrompt(reason: StopReason): void {
    const p = this.prompt;
    if (!p?.echoed) return;
    p.resolve({ stopReason: p.cancelled ? "cancelled" : reason });
  }

  /** One dialog at a time; clients show one (marimo does). */
  private ask(intr: AguiInterrupt): void {
    if (this.asked.has(intr.id)) return;
    this.asked.add(intr.id);
    this.asking = this.asking.then(() => this.askNow(intr)).catch((e) => this.port.log?.("acp: permission request failed", e));
  }

  private async askNow(intr: AguiInterrupt): Promise<void> {
    if (this.closed || !this.openInterrupts.has(intr.id)) return;
    const meta = (intr.metadata ?? {}) as { options?: Array<{ optionId: string; name: string; kind?: string }>; kind?: string; data?: unknown };
    const options = meta.options ?? [];
    const toolCallId = intr.toolCallId ?? intr.id;
    const title = intr.message ?? "The agent needs your choice";

    if (meta.kind === "ask-user.questions") {
      const questions = questionsOf(meta.data);
      if (!questions || !options[0]) return this.noteElsewhere(title);
      const answers: Record<string, string> = {};
      for (const [i, q] of questions.entries()) {
        const picked = await this.choose(`${toolCallId}:q${i}`, q.header ? `${q.header}: ${q.question}` : q.question,
          q.options!.map((o, j) => ({ optionId: String(j), name: o.label, kind: "allow_once" as const })));
        if (picked === undefined) return;
        answers[q.question] = q.options![Number(picked)].label;
      }
      await this.settle(intr.id, options[0].optionId, { answers });
      return;
    }
    if (meta.kind || options.length === 0) return this.noteElsewhere(title);

    const picked = await this.choose(toolCallId, title, options.map((o) => ({
      optionId: o.optionId,
      name: o.name,
      kind: (OPTION_KINDS.has(o.kind ?? "") ? o.kind : "allow_once") as AskOption["kind"],
    })));
    if (picked !== undefined) await this.settle(intr.id, picked);
  }

  /** One permission dialog; undefined when dismissed or answered elsewhere first. */
  private async choose(toolCallId: string, title: string, options: AskOption[]): Promise<string | undefined> {
    const res = await this.peer.request<{ outcome?: { outcome?: string; optionId?: string } }>("session/request_permission", {
      sessionId: this.port.conversationId,
      // Some clients (marimo) show the content, not the title.
      toolCall: { toolCallId, title, status: "pending", content: [{ type: "content", content: { type: "text", text: title } }] },
      options,
    }).catch(() => undefined);
    return res?.outcome?.outcome === "selected" ? res.outcome.optionId : undefined;
  }

  private async settle(interruptId: string, optionId: string, result?: Record<string, unknown>): Promise<void> {
    if (!this.openInterrupts.has(interruptId)) return;
    if (!(await this.port.answer(interruptId, optionId, result))) this.say("\n\n(That was already answered elsewhere.)\n");
  }

  private noteElsewhere(title: string): void {
    this.say(`\n\n⏸ **${title}**: answer this in ${this.chatLink()}.\n`);
  }

  private noteEarlier(): void {
    this.say(`Earlier messages are in ${this.chatLink()}.\n`);
  }

  private chatLink(): string {
    return this.port.conversationUrl ? `[the Scooter chat](${this.port.conversationUrl})` : "the Scooter chat";
  }
}

/** Index of the first event to replay: the start of the REPLAY_USER_TURNS-th last user message. */
export function replayStart(history: AguiEvent[], turns = REPLAY_USER_TURNS): number {
  let seen = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i] as any;
    if (e.type === "TEXT_MESSAGE_START" && e.role === "user" && ++seen === turns) return i;
  }
  return 0;
}

/** Keep `open` to the interrupts still awaiting an answer. */
function trackInterrupt(open: Map<string, AguiInterrupt>, ev: AguiEvent): void {
  const e = ev as any;
  if (e.type === "RUN_FINISHED" && e.outcome?.type === "interrupt") {
    for (const intr of e.outcome.interrupts as AguiInterrupt[]) open.set(intr.id, intr);
  } else if (e.type === "PERMISSION_RESOLVED") {
    open.delete(e.toolCallId);
  }
}

/** The prompt as the conversation's message: the text, then what the client attached. */
export function promptText(blocks: any[]): string {
  const parts: string[] = [];
  const notes: string[] = [];
  for (const b of blocks) {
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b?.type === "resource_link" && typeof b.uri === "string") {
      notes.push(`Attached: ${b.uri}`);
    } else if (b?.type === "resource" && b.resource) {
      const body = typeof b.resource.text === "string" ? b.resource.text : "";
      notes.push(body ? `Context ${b.resource.uri}:\n\`\`\`\n${truncate(body)}\n\`\`\`` : `Attached: ${b.resource.uri}`);
    }
  }
  const text = parts.join("\n\n");
  return notes.length ? `${text}\n\n(Sent from an agent panel. ${notes.join("\n")})` : text;
}

/** Whether a logged message is the prompt, perhaps batched. */
function isEcho(logged: string, sent: string): boolean {
  const a = logged.trim();
  const b = sent.trim();
  return a === b || a.includes(b);
}

function questionsOf(data: unknown): Question[] | undefined {
  const qs = (data as { questions?: unknown })?.questions;
  if (!Array.isArray(qs) || qs.length === 0) return undefined;
  const ok = qs.every((q: Question) => typeof q?.question === "string" && !q.multiSelect && Array.isArray(q.options) && q.options.length > 0);
  return ok ? (qs as Question[]) : undefined;
}

function truncate(s: string): string {
  return s.length > MAX_TOOL_OUTPUT ? s.slice(0, MAX_TOOL_OUTPUT) + "\n…(truncated)" : s;
}

function parseArgs(args: string): unknown {
  try {
    return args ? JSON.parse(args) : undefined;
  } catch {
    return undefined;
  }
}

export function prettyTool(name?: string): string {
  if (!name) return "tool";
  return name.replace(/^mcp__.+?__/, "").replace(/_/g, " ");
}

function describeTool(name: string, args: string): string {
  const parsed = parseArgs(args) as Record<string, unknown> | undefined;
  const detail = String(parsed?.command ?? parsed?.description ?? parsed?.path ?? parsed?.file_path ?? parsed?.query ?? parsed?.url ?? "");
  return detail ? `${prettyTool(name)}: ${detail.length > 200 ? detail.slice(0, 200) + "…" : detail}` : prettyTool(name);
}

/** The ACP tool kind (the panel's icon), guessed from the name. */
export function toolKind(name?: string): string {
  const n = prettyTool(name).toLowerCase();
  if (/\b(bash|shell|exec|run|terminal)\b/.test(n)) return "execute";
  if (/\b(read|view|cat)\b/.test(n)) return "read";
  if (/\b(edit|write|patch|create)\b/.test(n)) return "edit";
  if (/\b(grep|glob|search|find|ls)\b/.test(n)) return "search";
  if (/\b(fetch|web|http)\b/.test(n)) return "fetch";
  return "other";
}

const OPEN = "<!--";
const CLOSE = "-->";

/** Hides HTML comments (markers) in streamed markdown. */
export class CommentStripper {
  private buf = "";
  private inComment = false;

  push(chunk: string): string {
    this.buf += chunk;
    let out = "";
    for (;;) {
      const marker = this.inComment ? CLOSE : OPEN;
      const at = this.buf.indexOf(marker);
      if (at >= 0) {
        if (!this.inComment) out += this.buf.slice(0, at);
        this.buf = this.buf.slice(at + marker.length);
        this.inComment = !this.inComment;
        continue;
      }
      // Hold back a tail that may start the marker.
      let keep = 0;
      for (let n = Math.min(marker.length - 1, this.buf.length); n > 0; n--) {
        if (this.buf.endsWith(marker.slice(0, n))) {
          keep = n;
          break;
        }
      }
      if (!this.inComment) out += this.buf.slice(0, this.buf.length - keep);
      this.buf = this.buf.slice(this.buf.length - keep);
      return out;
    }
  }

  /** The held-back tail; an unclosed comment stays hidden. */
  end(): string {
    const rest = this.inComment ? "" : this.buf;
    this.buf = "";
    return rest;
  }
}
