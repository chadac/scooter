/**
 * ScooterBackend: an AHP backend exposing this sandbox's Scooter conversation to VS Code,
 * plus one child "session" conversation per chat VS Code opens with the session agent.
 *
 *  - Root advertises two agents, each with one model and no protected resources, so
 *    VS Code needs no GitHub/Copilot sign-in:
 *    - "scooter": every chat is this conversation, the one the web UI shows.
 *    - "scooter-session": every chat starts its own child session conversation.
 *  - The primary session `scooter:/<conversationId>` is this conversation.
 *  - `disposeSession` suspends a child and hides it; closing a chat of this
 *    conversation only drops that chat.
 *  - Each chat is a ConversationView with its own event pump and turn mapping.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ConversationView, PROVIDER, SESSION_PROVIDER, type ScooterApi } from "./conversationView.js";
import type { ProtocolCore } from "./vendor/hydra-ahp/protocol/core.js";
import type { ActionDecision, ActionRequest, Backend, ClientContext } from "./vendor/hydra-ahp/protocol/backend.js";
import { ErrorCodes, RpcError } from "./vendor/hydra-ahp/rpc/peer.js";

export type { AguiEvent, ScooterApi } from "./conversationView.js";

const ROOT = "ahp-root://";
/** Prefixes a session's title, e.g. "vscode: Fix the login redirect". */
const TITLE_PREFIX = "vscode";

export interface ChildSession { id: string; title?: string; status?: string }

/** The router's session routes on the primary conversation, plus per-conversation access. */
export interface SessionsApi {
  create(titlePrefix: string): Promise<ChildSession>;
  list(): Promise<ChildSession[]>;
  /** Suspends a session; its history stays. */
  end(id: string): Promise<void>;
  /** The self-access API for one conversation (the primary or a session). */
  conversation(id: string): ScooterApi;
}

export interface ScooterBackendOptions {
  conversationId: string;
  title?: string;
  workspaceUri?: string; // e.g. vscode-remote or file URI of the workspace folder
  conversationUrl?: string; // link back to the Scooter web UI
  api: SessionsApi;
  /** Where session URIs and hidden sessions persist across bridge restarts. */
  statePath?: string;
  log?: (msg: string) => void;
}

/** What survives a bridge restart: VS Code's URI per session, and sessions VS Code deleted. */
interface SavedState { uris: Record<string, string>; disposed: string[] }

export class ScooterBackend implements Backend {
  readonly serverInfo = { name: "scooter-ahp", version: "0.2.0" };
  readonly defaultDirectory: string;
  private core!: ProtocolCore;
  /** Every session VS Code can see, by URI. */
  private readonly views = new Map<string, ConversationView>();
  private readonly saved: SavedState;
  private loaded: Promise<void> = Promise.resolve();

  constructor(private readonly opts: ScooterBackendOptions) {
    this.defaultDirectory = opts.workspaceUri ?? "file:///workspace";
    this.saved = load(opts.statePath);
  }

  start(core: ProtocolCore): void {
    this.core = core;
    core.createChannel(ROOT, {
      agents: [
        agent(PROVIDER, "Scooter", "This Scooter conversation"),
        agent(SESSION_PROVIDER, "Scooter session", "A new Scooter conversation for this chat"),
      ],
      activeSessions: 1,
    } as never);
    this.addView(`${PROVIDER}:/${this.opts.conversationId}`, this.opts.conversationId, this.primaryTitle);
    // Earlier chats of this conversation; sessions come back in refresh().
    for (const [uri, id] of Object.entries(this.saved.uris)) {
      if (id === this.opts.conversationId && !this.views.has(uri)) this.addView(uri, id, this.primaryTitle);
    }
    this.loaded = this.refresh();
  }

  private get primaryTitle(): string { return this.opts.title ?? "Scooter conversation"; }

  stop(): void {
    for (const v of this.views.values()) v.stop();
  }

  // ── Sessions ───────────────────────────────────────────────────────────

  private addView(uri: string, conversationId: string, title: string, api?: ScooterApi): ConversationView {
    const view = new ConversationView(this.core, {
      uri, conversationId, title,
      provider: uri.startsWith(`${SESSION_PROVIDER}:/`) ? SESSION_PROVIDER : PROVIDER,
      directory: this.defaultDirectory,
      conversationUrl: conversationId ? urlFor(this.opts.conversationUrl, conversationId) : undefined,
      api: api ?? this.opts.api.conversation(conversationId),
      log: this.opts.log,
    });
    this.views.set(uri, view);
    view.start();
    return view;
  }

  /** Adds a view for each live session the router knows and VS Code didn't delete. */
  private async refresh(): Promise<void> {
    let children: ChildSession[];
    try {
      children = await this.opts.api.list();
    } catch (e) {
      this.opts.log?.(`listing sessions failed: ${(e as Error).message}`);
      return;
    }
    const byId = new Map([...this.views.values()].map((v) => [v.conversationId, v]));
    for (const c of children) {
      const known = byId.get(c.id);
      if (known) { if (c.title) known.title = c.title; continue; } // the agent may have named it since
      if (c.status === "ended" || this.saved.disposed.includes(c.id)) continue;
      const uri = Object.keys(this.saved.uris).find((u) => this.saved.uris[u] === c.id) ?? `${SESSION_PROVIDER}:/${c.id}`;
      if (this.views.has(uri)) continue;
      this.addView(uri, c.id, c.title || "VS Code session");
    }
  }

  async listSessions() {
    await this.loaded;
    this.loaded = this.refresh();
    await this.loaded;
    return { items: [...this.views.values()].filter((v) => v.conversationId).map((v) => v.summary()) } as never;
  }

  async handleCommand(method: string, params: unknown, _client: ClientContext): Promise<unknown> {
    const body = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "resolveSessionConfig":
        return { schema: { type: "object", properties: {} }, values: {} };
      case "createSession": {
        // VS Code picks the URI; its scheme names the agent the user chose.
        const channel = body.channel;
        const isSession = typeof channel === "string" && channel.startsWith(`${SESSION_PROVIDER}:/`);
        if (typeof channel !== "string" || (!isSession && !channel.startsWith(`${PROVIDER}:/`))) {
          throw new RpcError(ErrorCodes.InvalidParams, `only ${PROVIDER}: and ${SESSION_PROVIDER}: sessions exist here`);
        }
        await this.loaded;
        if (this.views.has(channel)) return null;
        // VS Code creates sessions speculatively; the child conversation waits for the first prompt.
        if (isSession) {
          this.addView(channel, "", "VS Code session", this.lazySession(channel));
          return null;
        }
        this.saved.uris[channel] = this.opts.conversationId;
        this.save();
        const view = this.addView(channel, this.opts.conversationId, this.primaryTitle);
        this.core.notify(ROOT, "root/sessionAdded", { channel: ROOT, summary: view.summary() });
        return null;
      }
      case "disposeSession": {
        const channel = String(body.channel ?? "");
        const view = this.views.get(channel);
        if (!view || channel === `${PROVIDER}:/${this.opts.conversationId}`) return null;
        this.views.delete(channel);
        view.remove();
        if (!view.conversationId) return null; // never prompted: no child to end
        delete this.saved.uris[channel];
        const isSession = view.conversationId !== this.opts.conversationId;
        if (isSession) this.saved.disposed.push(view.conversationId);
        this.save();
        this.core.notify(ROOT, "root/sessionRemoved", { channel: ROOT, session: channel });
        if (!isSession) return null; // another chat of this conversation: nothing to end
        await this.opts.api.end(view.conversationId).catch((e) => this.opts.log?.(`ending session ${view.conversationId} failed: ${(e as Error).message}`));
        return null;
      }
      case "fetchTurns":
        return {};
      default:
        throw new RpcError(ErrorCodes.MethodNotFound, `method not found: ${method}`);
    }
  }

  async handleAction(req: ActionRequest): Promise<ActionDecision> {
    const view = [...this.views.values()].find((v) => v.chat === req.channel || v.uri === req.channel);
    if (!view) return { accept: false, reason: "unknown session" };
    return view.handleAction(req);
  }

  /** A session's API that starts its child conversation on the first prompt. */
  private lazySession(channel: string): ScooterApi {
    let ready!: (api: ScooterApi) => void;
    const bound = new Promise<ScooterApi>((r) => (ready = r));
    let starting: Promise<ScooterApi> | undefined;
    const start = () => starting ??= this.opts.api.create(TITLE_PREFIX).then((child) => {
      const api = this.opts.api.conversation(child.id);
      const view = this.views.get(channel);
      if (view) {
        view.bind(child.id, child.title || "VS Code session", urlFor(this.opts.conversationUrl, child.id));
        this.saved.uris[channel] = child.id;
        this.save();
        this.core.notify(ROOT, "root/sessionAdded", { channel: ROOT, summary: view.summary() });
      }
      ready(api);
      return api;
    }, (e) => {
      starting = undefined; // let the next prompt retry
      throw new Error(`Scooter could not start a session: ${(e as Error).message}`);
    });
    return {
      async stream(onEvent, signal) {
        const api = await Promise.race([bound, new Promise<undefined>((r) => signal.addEventListener("abort", () => r(undefined)))]);
        if (api) await api.stream(onEvent, signal);
      },
      async sendMessage(text) { await (await start()).sendMessage(text); },
      async cancel() { if (starting) await (await starting).cancel(); },
    };
  }

  private save(): void {
    if (!this.opts.statePath) return;
    try {
      writeFileSync(this.opts.statePath, JSON.stringify(this.saved), { mode: 0o600 });
    } catch (e) {
      this.opts.log?.(`saving sessions failed: ${(e as Error).message}`);
    }
  }
}

function agent(provider: string, displayName: string, description: string) {
  return { provider, displayName, description, models: [{ id: "scooter", provider, name: "Scooter" }], protectedResources: [] };
}

function load(path?: string): SavedState {
  try {
    const raw = JSON.parse(readFileSync(path!, "utf8")) as Partial<SavedState>;
    return { uris: raw.uris ?? {}, disposed: raw.disposed ?? [] };
  } catch {
    return { uris: {}, disposed: [] };
  }
}

/** The web UI link for a conversation, from the primary's `…/?thread=<id>`. */
function urlFor(primaryUrl: string | undefined, conversationId: string): string | undefined {
  if (!primaryUrl) return undefined;
  try {
    const u = new URL(primaryUrl);
    u.searchParams.set("thread", conversationId);
    return u.toString();
  } catch {
    return primaryUrl;
  }
}
