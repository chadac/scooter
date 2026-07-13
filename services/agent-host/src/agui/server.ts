/**
 * AG-UI server — streams AG-UI events from the agent-host to the browser.
 *
 * Transport: Server-Sent Events (SSE). AG-UI's event stream is one-directional
 * (agent -> UI), so SSE fits; prompts/permission answers come over POST.
 * assistant-ui's native AG-UI runtime consumes the SSE stream.
 *
 * Events are encoded with @ag-ui/encoder so the wire format is the canonical
 * AG-UI SSE framing.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";

import { EventEncoder } from "@ag-ui/encoder";
import type { BaseEvent } from "@ag-ui/core";

import type { AguiEvent } from "../bridge.js";
import type { SessionId, ThreadId } from "../types.js";
import type { Router } from "../http/router.js";
import type { WebServiceProxy } from "../proxy/webServiceProxy.js";

/** A raw inbound image on a user message (base64 bytes + mime) — before it's
 *  stored in the AssetStore. The promptHandler (index.ts) stores it and passes the
 *  resulting assetId to the bridge. */
export interface InboundImage {
  data: string; // base64
  mimeType: string;
}

/** One part of a multimodal message content array. Text or image; other AG-UI part
 *  shapes are tolerated (ignored). */
export type ContentPart =
  | { type: "text"; text?: string }
  | { type: "image"; data?: string; mimeType?: string; image?: string; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

/** Normalize a message's `content` (string | ContentPart[]) into prompt text + the
 *  inbound images. A plain string is the text (no images) — the unchanged path. */
export function normalizeContent(content: string | ContentPart[] | undefined): {
  text: string;
  images: InboundImage[];
} {
  if (content == null) return { text: "", images: [] };
  if (typeof content === "string") return { text: content, images: [] };
  const texts: string[] = [];
  const images: InboundImage[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof (part as { text?: unknown }).text === "string") {
      texts.push((part as { text: string }).text);
    } else if (part.type === "image") {
      // Accept {data, mimeType} (our shape) or {image} (assistant-ui data URL).
      const p = part as { data?: string; mimeType?: string; image?: string };
      const parsed = p.data && p.mimeType
        ? { data: p.data, mimeType: p.mimeType }
        : p.image
          ? parseDataUrl(p.image)
          : null;
      if (parsed) images.push(parsed);
    }
  }
  return { text: texts.join("\n\n"), images };
}

/** Parse a `data:<mime>;base64,<data>` URL into {data, mimeType}, or null. */
function parseDataUrl(url: string): InboundImage | null {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  return m ? { mimeType: m[1], data: m[2] } : null;
}

/** A user prompt arriving from the UI (AG-UI RunAgentInput, subset). */
export interface RunAgentInput {
  threadId: ThreadId;
  text: string;
  /** Per-conversation model pick/switch (from the X-Agent-Model header on the
   *  /agui POST). Undefined = keep the conversation's current model. */
  model?: string;
  /** Priority tier (PRIORITY_INTERRUPT) for a force-interrupting message — a
   *  webhooks `@scooter` mention to an ACTIVE conversation sets this so it can
   *  preempt a stuck turn after the bridge's priority timeout. The UI (a human
   *  typing) never sets it. Undefined/0 = normal (waits its turn). */
  priority?: number;
  /** The Scooter user id to OWN a webhook-spawned conversation (the external-user
   *  identity mapping resolved this). SECURITY: honored ONLY when the caller is the
   *  TRUSTED webhooks service, verified by its ServiceAccount token via k8s
   *  TokenReview (see auth/webhooksCaller.ts) — a browser / any other caller can't
   *  claim a conversation. Undefined = no owner set here (the UI path stamps the
   *  ingress identity on POST /conversations instead). */
  owner?: string;
  /** Images attached to the latest user message (base64), from a multimodal
   *  content array. Empty/undefined = a text-only message (the unchanged path). */
  images?: InboundImage[];
}

/** One connected UI client subscribed to a session's event stream. */
export interface AguiConnection {
  readonly sessionId: SessionId;
  send(event: AguiEvent): void;
  close(): void;
}

export interface AguiServer {
  listen(port: number): Promise<void>;
  /** The bound port after listen() (for tests binding to :0). undefined if not listening. */
  port(): number | undefined;
  close(): Promise<void>;
  onPrompt(handler: (sessionId: SessionId, input: RunAgentInput) => Promise<void>): void;
  /** Answer a pending permission request (toolCallId -> optionId). */
  onPermission(handler: (sessionId: SessionId, toolCallId: string, optionId: string) => Promise<void>): void;
  /** Resume a paused run: the user answered an interrupt via RunAgentInput.resume.
   *  status "cancelled" -> the request is cancelled; otherwise payload carries the
   *  chosen optionId. */
  onResume(
    handler: (
      sessionId: SessionId,
      entry: { interruptId: string; status: "resolved" | "cancelled"; payload?: unknown },
    ) => Promise<void>,
  ): void;
  broadcast(sessionId: SessionId, event: AguiEvent): void;
  /** Replay the persisted event log to a newly-attached connection. */
  onAttach(handler: (sessionId: SessionId, conn: AguiConnection) => Promise<void>): void;
  /** Mount a management router; tried before the built-in AG-UI routes. */
  use(router: Router): void;
  /** Mount the web-service reverse proxy (/c/<id>/<service>/...): consulted as an
   *  HTTP fallback before the 404, and wired to the server's `upgrade` event for
   *  WebSocket services (marimo/xterm/vscode). */
  useProxy(proxy: WebServiceProxy): void;
  /** Set the verifier that decides whether a /agui request is the TRUSTED webhooks
   *  caller (its SA token via TokenReview) — gating the privileged `owner` field.
   *  Absent = owner is never honored. */
  useOwnerVerifier(verify: (req: import("node:http").IncomingMessage) => Promise<boolean>): void;
  /** Attach an SSE response to a session's persistent event stream (for the
   *  management API's GET .../events). Returns once replay (onAttach) is done. */
  subscribeSSE(sessionId: SessionId, res: ServerResponse): Promise<void>;
}

/** Our internal AguiEvent IS a BaseEvent once `type` is the discriminator. */
function toBaseEvent(event: AguiEvent): BaseEvent {
  return event as unknown as BaseEvent;
}

export function createAguiServer(): AguiServer {
  const encoder = new EventEncoder();
  const connections = new Map<SessionId, Set<ServerResponse>>();

  let promptHandler:
    | ((sessionId: SessionId, input: RunAgentInput) => Promise<void>)
    | undefined;
  let permissionHandler:
    | ((sessionId: SessionId, toolCallId: string, optionId: string) => Promise<void>)
    | undefined;
  let resumeHandler:
    | ((
        sessionId: SessionId,
        entry: { interruptId: string; status: "resolved" | "cancelled"; payload?: unknown },
      ) => Promise<void>)
    | undefined;
  let attachHandler:
    | ((sessionId: SessionId, conn: AguiConnection) => Promise<void>)
    | undefined;

  let server: Server | undefined;
  let mountedRouter: Router | undefined;
  let mountedProxy: WebServiceProxy | undefined;
  let ownerVerifier: ((req: IncomingMessage) => Promise<boolean>) | undefined;

  const write = (res: ServerResponse, event: AguiEvent) => {
    res.write(encoder.encodeSSE(toBaseEvent(event)));
  };

  const subscribeSSE = async (sessionId: SessionId, res: ServerResponse): Promise<void> => {
    res.writeHead(200, {
      "Content-Type": encoder.getContentType(),
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    let set = connections.get(sessionId);
    if (!set) connections.set(sessionId, (set = new Set()));
    set.add(res);
    res.req.on("close", () => set!.delete(res));
    const conn: AguiConnection = {
      sessionId,
      send: (e) => write(res, e),
      close: () => res.end(),
    };
    await attachHandler?.(sessionId, conn); // replay the event log
  };

  // Connections opened via POST /agui are run-scoped: they close when the run
  // ends. The persistent GET /sessions/:id/events connections stay open.
  const runScoped = new WeakSet<ServerResponse>();

  // Broadcast a run's live AG-UI events ONLY to run-scoped connections — i.e.
  // the POST /agui stream of the client that started THIS run. We deliberately
  // do NOT push to persistent (GET .../events) connections: a run the client
  // didn't initiate (driven by another tab or a webhook via POST
  // /conversations/:id/messages) would otherwise reach an idle @ag-ui client as
  // a stray RUN_STARTED — which it rejects ("RUN_STARTED while a run is still
  // active"). The open UI renders those external runs through the separate
  // integrity stream (GET .../events.integrity) instead, which is fed off the
  // persist path and carries every event with its checksum. The right primitive
  // for each: run-scoped SSE for your own run, the integrity stream for the rest.
  const broadcast = (sessionId: SessionId, event: AguiEvent) => {
    const set = connections.get(sessionId);
    if (!set) return;
    const terminal = event.type === "RUN_FINISHED" || event.type === "RUN_ERROR";
    for (const res of set) {
      if (!runScoped.has(res)) continue; // integrity stream serves persistent conns
      write(res, event);
      if (terminal) {
        set.delete(res);
        res.end();
      }
    }
  };

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    // Management API (mounted router) is tried first.
    if (mountedRouter && (await mountedRouter.handle(req, res))) return;

    // GET /healthz  -> readiness probe
    if (req.method === "GET" && parts[0] === "healthz") {
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"ok"}');
      return;
    }

    // POST /agui  -> the standard AG-UI HttpAgent protocol: accept a
    // RunAgentInput and stream this run's AG-UI events back over SSE. This is
    // what @ag-ui/client HttpAgent (used by assistant-ui) talks to.
    if (req.method === "POST" && parts[0] === "agui") {
      const input = JSON.parse((await readBody(req)) || "{}") as {
        threadId: string;
        runId?: string;
        // content is a plain string (text-only, the common case) OR an array of
        // content parts (multimodal: text + image parts).
        messages?: Array<{ role: string; content?: string | ContentPart[] }>;
        /** Priority tier for a force-interrupting message (webhooks @mention). */
        priority?: number;
        /** The Scooter user to OWN a webhook-spawned conversation. Honored ONLY for
         *  a TokenReview-verified webhooks caller (ownerVerifier); ignored otherwise. */
        owner?: string;
        /** Per-interrupt responses (assistant-ui resumes a paused run with these
         *  instead of a new user message). */
        resume?: Array<{ interruptId: string; status: "resolved" | "cancelled"; payload?: unknown }>;
      };
      const sessionId = input.threadId;
      res.writeHead(200, {
        "Content-Type": encoder.getContentType(),
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      // Subscribe this response to the session's events for the duration of the
      // run; unsubscribe when the run completes.
      let set = connections.get(sessionId);
      if (!set) connections.set(sessionId, (set = new Set()));
      set.add(res);
      runScoped.add(res);
      req.on("close", () => set!.delete(res));

      // A RESUME (answer to a pending interrupt) reconnects to the still-blocked
      // run and unpauses it — its continued events stream back over THIS SSE. We
      // do NOT start a new prompt for a resume.
      if (input.resume && input.resume.length > 0) {
        for (const r of input.resume) await resumeHandler?.(sessionId, r);
        return;
      }

      // The latest user message is the prompt. Its content is either a plain
      // string (text-only) or an array of parts (multimodal); normalize to text +
      // inbound images.
      const lastUser = [...(input.messages ?? [])].reverse().find((m) => m.role === "user");
      const { text, images } = normalizeContent(lastUser?.content);
      // The UI rides the per-conversation model on a header (the assistant-ui
      // runtime drives the AG-UI body, so a header is the clean injection point).
      const hdr = req.headers["x-agent-model"];
      const model = (Array.isArray(hdr) ? hdr[0] : hdr) || undefined;
      // The conversation OWNER for a webhook-spawned run is PRIVILEGED (it claims a
      // conversation for a Scooter user). Honor it ONLY when the caller is the
      // TRUSTED webhooks service — verified by its ServiceAccount token via k8s
      // TokenReview (ownerVerifier), NOT a header the ingress is trusted to strip.
      // The UI / a browser / any other caller can't set it. Absent verifier → never.
      let owner: string | undefined;
      if (input.owner && ownerVerifier && (await ownerVerifier(req).catch(() => false))) {
        owner = input.owner;
      }
      // Drive the run. If promptHandler THROWS before the run ever emits a terminal
      // event (the big one: revive/provision fails — e.g. 409 AlreadyExists from a
      // wrong hydrate map, goose spawn/ACP-connect error), the SSE 200 header is
      // ALREADY sent, so the outer handle().catch can't send a 500 — it would just
      // res.end() a raw error string that assistant-ui can't parse, and the UI hangs
      // with NO error (the hydrate-silent-drop bug). Emit a proper RUN_ERROR event on
      // THIS stream + close it, so the UI has something to render as a failed send.
      try {
        await promptHandler?.(sessionId, { threadId: sessionId, text, model, priority: input.priority, owner, images });
        // promptHandler drives the run; RUN_FINISHED/RUN_ERROR close the stream.
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(`[agui] prompt failed for ${sessionId} (surfacing RUN_ERROR to the client):`, err);
        try {
          write(res, { type: "RUN_ERROR", message: `The agent could not start this run: ${message}` });
        } catch {
          /* stream already torn down */
        }
        res.end();
      }
      return;
    }

    // GET /sessions/:id/events  -> SSE subscription
    if (req.method === "GET" && parts[0] === "sessions" && parts[2] === "events") {
      const sessionId = parts[1];
      res.writeHead(200, {
        "Content-Type": encoder.getContentType(),
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      let set = connections.get(sessionId);
      if (!set) connections.set(sessionId, (set = new Set()));
      set.add(res);
      req.on("close", () => set!.delete(res));

      const conn: AguiConnection = {
        sessionId,
        send: (e) => write(res, e),
        close: () => res.end(),
      };
      await attachHandler?.(sessionId, conn); // replay the event log
      return;
    }

    // POST /sessions/:id/prompt
    if (req.method === "POST" && parts[0] === "sessions" && parts[2] === "prompt") {
      const body = JSON.parse((await readBody(req)) || "{}") as RunAgentInput;
      await promptHandler?.(parts[1], body);
      res.writeHead(202).end();
      return;
    }

    // POST /sessions/:id/permission/:toolCallId  { optionId }
    if (req.method === "POST" && parts[0] === "sessions" && parts[2] === "permission") {
      const body = JSON.parse((await readBody(req)) || "{}") as { optionId: string };
      await permissionHandler?.(parts[1], parts[3], body.optionId);
      res.writeHead(204).end();
      return;
    }

    // Web-service reverse proxy (/c/<id>/<service>/...) — last, so it never
    // shadows the API routes above.
    if (mountedProxy && mountedProxy.matches(url.pathname)) {
      await mountedProxy.handleHttp(req, res);
      return;
    }

    res.writeHead(404).end();
  };

  return {
    listen(port) {
      return new Promise((resolve) => {
        server = createServer((req, res) => {
          handle(req, res).catch((err) => {
            if (!res.headersSent) res.writeHead(500);
            res.end(String(err));
          });
        });
        // WebSocket upgrades for proxied services (marimo kernel, xterm PTY,
        // vscode RPC). The agent-host had no upgrade handler before this.
        server.on("upgrade", (req, socket, head) => {
          const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
          if (mountedProxy && mountedProxy.matches(pathname)) {
            mountedProxy.handleUpgrade(req, socket, head).catch(() => socket.destroy());
          } else {
            socket.destroy();
          }
        });
        server.listen(port, () => resolve());
      });
    },
    port() {
      const addr = server?.address();
      return addr && typeof addr === "object" ? addr.port : undefined;
    },
    close() {
      return new Promise((resolve) => {
        for (const set of connections.values()) for (const res of set) res.end();
        connections.clear();
        server?.close(() => resolve());
      });
    },
    onPrompt(handler) {
      promptHandler = handler;
    },
    onPermission(handler) {
      permissionHandler = handler;
    },
    onResume(handler) {
      resumeHandler = handler;
    },
    broadcast,
    onAttach(handler) {
      attachHandler = handler;
    },
    use(router) {
      mountedRouter = router;
    },
    useOwnerVerifier(verify) {
      ownerVerifier = verify;
    },
    useProxy(proxy) {
      mountedProxy = proxy;
    },
    subscribeSSE,
  };
}
