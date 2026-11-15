/**
 * The ACP WebSocket for a conversation, at /c/<id>/_scooter/acp on the main host and
 * /_scooter/acp on the conversation's sandbox host (the router rewrites the latter onto the
 * former). A client on the conversation's pages shares their origin, so the user's session
 * cookie authenticates it.
 * The ACP mapping itself is conversationAgent.ts.
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

import type { UserContext } from "../auth/identity.js";
import { PRIORITY_INTERRUPT, userAssertionOf, type AguiEvent, type ApproverIdentity } from "../bridge.js";
import { logger } from "../log.js";
import type { AccessCheck } from "../session/access.js";
import type { ChecksummedEvent, Conversation, SessionManager } from "../session/manager.js";
import type { SessionId } from "../types.js";
import { sandboxLabelOf } from "../proxy/webServiceProxy.js";
import { ConversationAgent, type ConversationFeed } from "./conversationAgent.js";

const log = logger("acpSocket");

const ACP_PATH = /^\/c\/([^/]+)\/_scooter\/acp\/?$/;

/** The conversation an ACP socket path names. */
export function acpConversationOf(pathname: string): string | undefined {
  const m = ACP_PATH.exec(pathname);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return undefined;
  }
}

/** The log reads and live appends the feed needs. */
export interface AcpEventSource {
  readEventsWithChecksum(id: SessionId): AsyncIterable<ChecksummedEvent>;
  onAppend(cb: (id: SessionId, event: ChecksummedEvent) => void): () => void;
  flush?(id: SessionId): Promise<void>;
}

export interface AcpSocketDeps {
  sessions: SessionManager;
  events: AcpEventSource;
  resolveUser: (req: IncomingMessage) => UserContext | Promise<UserContext>;
  /** Absent means no check (tests and fake mode). */
  accessCheck?: AccessCheck;
  /** Records the caller as steering, as a typed message does. */
  recordSteering?: (conversationId: string, user: UserContext) => Promise<void>;
  /** Answer an interrupt as `approver`; the same path as POST /permission/:toolCallId. */
  answerInterrupt: (
    id: SessionId,
    entry: { interruptId: string; status: "resolved"; payload: { optionId: string; result?: Record<string, unknown> } },
    approver: ApproverIdentity | undefined,
  ) => Promise<{ ok: boolean; reason?: string }>;
  /** When set, the socket is served only on sandbox hosts. */
  sandboxDomain?: string;
  /** The chat UI's base URL, for links to the full chat. */
  publicUrl?: string;
}

/** Whether the Origin is the host reached; none means no browser. */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const forwarded = req.headers["x-forwarded-host"];
  const host = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim() || req.headers.host;
  try {
    return new URL(origin).host.toLowerCase() === (host ?? "").toLowerCase();
  } catch {
    return false;
  }
}

export function createAcpSocket(deps: AcpSocketDeps) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  const refuse = (socket: Duplex, status: number, text: string) => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  async function lookup(urlId: string): Promise<Conversation | undefined> {
    const { sessions } = deps;
    const known = sessions.get(urlId) ?? (await sessions.getBySandboxKey(urlId));
    if (known) return known;
    if (!(await sessions.ensureReadable(urlId as SessionId).catch(() => false))) return undefined;
    return sessions.get(urlId);
  }

  /** Whether this upgrade is an ACP socket. */
  function matches(pathname: string): boolean {
    return acpConversationOf(pathname) !== undefined;
  }

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const urlId = acpConversationOf(new URL(req.url ?? "/", "http://localhost").pathname)!;
    const label = sandboxLabelOf(req);
    // Like the web-service proxy: with sandbox hosts on, only there.
    if (deps.sandboxDomain ? label === undefined : label !== undefined) return refuse(socket, 404, "Not Found");
    // It answers approvals as the user, so same-site only.
    if (!sameOrigin(req)) return refuse(socket, 403, "Forbidden");
    const user = await deps.resolveUser(req);
    try {
      if (deps.accessCheck && (await deps.accessCheck(urlId, req, user)) === "deny") return refuse(socket, 404, "Not Found");
    } catch (err) {
      log.errorWith("visibility check failed; refusing", err, { conversation_id: urlId });
      return refuse(socket, 503, "Service Unavailable");
    }
    const conv = await lookup(urlId);
    if (!conv || conv.parentId || (label !== undefined && !conv.id.startsWith(label))) return refuse(socket, 404, "Not Found");
    const id = conv.id as SessionId;
    const approver: ApproverIdentity | undefined = user.anonymous
      ? undefined
      : { id: user.id, email: user.email, name: user.name, assertion: userAssertionOf(req) };

    wss.handleUpgrade(req, socket, head, (ws) => serve(ws, id, user, approver));
  }

  function serve(ws: WebSocket, id: SessionId, user: UserContext, approver: ApproverIdentity | undefined): void {
    const conversationUrl = deps.publicUrl ? `${deps.publicUrl.replace(/\/$/, "")}/chat/${encodeURIComponent(id)}` : undefined;
    const agent = new ConversationAgent(
      {
        conversationId: id,
        feed: feedFor(deps.events, id),
        conversationUrl,
        async send(text) {
          await deps.recordSteering?.(id, user);
          await deps.sessions.enqueueByThread(deps.sessions.get(id)?.threadId ?? (id as never), text, undefined, PRIORITY_INTERRUPT);
        },
        async cancel() {
          await deps.sessions.get(id)?.bridge?.cancel(undefined, true);
        },
        async answer(interruptId, optionId, result) {
          const payload = result ? { optionId, result } : { optionId };
          return (await deps.answerInterrupt(id, { interruptId, status: "resolved", payload }, approver)).ok;
        },
        log: (msg, err) => (err ? log.errorWith(msg, err, { conversation_id: id }) : log.info(msg, { conversation_id: id })),
      },
      (msg) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
    );
    log.info("acp client connected", { conversation_id: id });
    ws.on("message", (data, isBinary) => {
      agent.peer.receive(isBinary || Buffer.isBuffer(data) ? Buffer.from(data as Buffer).toString("utf8") : String(data));
    });
    // Proxies drop a quiet socket.
    const ping = setInterval(() => ws.ping(), 25_000);
    ping.unref?.();
    const done = () => {
      clearInterval(ping);
      agent.close();
    };
    ws.on("close", done);
    ws.on("error", done);
  }

  return { matches, handleUpgrade };
}

/** Subscribes before reading, so nothing falls between; dedupes by checksum. */
export function feedFor(events: AcpEventSource, id: SessionId): ConversationFeed {
  return {
    async open(onLive) {
      const seen = new Set<string>();
      const early: ChecksummedEvent[] = [];
      let live = false;
      const unsub = events.onAppend((evId, c) => {
        if (evId !== id) return;
        if (!live) early.push(c);
        else if (!seen.has(c.checksum)) onLive(c.event);
      });
      try {
        await events.flush?.(id);
        const history: AguiEvent[] = [];
        for await (const c of events.readEventsWithChecksum(id)) {
          seen.add(c.checksum);
          history.push(c.event);
        }
        for (const c of early) {
          if (seen.has(c.checksum)) continue;
          seen.add(c.checksum);
          history.push(c.event);
        }
        live = true;
        return { history, close: unsub };
      } catch (err) {
        unsub();
        throw err;
      }
    },
  };
}
