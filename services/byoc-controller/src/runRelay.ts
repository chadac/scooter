/**
 * The BYOC run relay: one prompt in, a stream of ACP frames out.
 *
 *   agent-host --POST /byoc/:session/prompt--> [relay] --WS--> container
 *   agent-host <----------- SSE (ACP frames) --[relay] <--WS-- container
 *
 * The agent-host holds nothing, so any replica can serve any conversation; the controller
 * owns the single duplex WS to the container and forwards frames and correlates ids. The
 * invariant is that every stream terminates: a lost ack, a mis-correlated id or a dropped
 * socket must each end the affected stream with a terminal frame.
 */

import { randomUUID } from "node:crypto";

import type { ContainerSocket, SessionRegistry } from "./sessionRegistry.js";
import { LINK_GRACE_MS, Link, type LinkResume } from "./link.js";
import type { AcpPromptPayload, ExecResultPayload, WireFrame } from "./remoteProtocol.js";

/** The user's decision on a permission request. */
export type PermissionAnswer = { optionId: string; result?: Record<string, unknown> } | { cancelled: true };

export type AnswerResult = { ok: true } | { ok: false; reason: string };

export interface RunRelayConfig {
  registry: SessionRegistry;
  /** How long a dropped container's runs wait for it. */
  linkGraceMs?: number;
}

/** The link a connecting container asks to resume. */
export interface LinkRequest {
  id: string;
  /** Highest controller seq the container received. */
  seq: number;
}

export interface AttachedLink {
  /** For the `connected` frame; absent without links. */
  resume?: LinkResume;
  /** Bind and replay; call after sending `connected`. */
  start(): void;
}

export interface RunRelay {
  /** Send a prompt and stream this run's frames back, rejecting rather than hanging if the container is not reachable. */
  prompt(sessionId: string, payload: AcpPromptPayload, callerId?: string): AsyncIterable<WireFrame>;
  /** Send any ACP request and stream the reply, with `callerId` (the caller's frame id) round-tripped onto the ack so the caller's by-id correlation resolves. */
  request(sessionId: string, type: string, payload: unknown, callerId?: string): AsyncIterable<WireFrame>;
  /** Answer a permission the container is blocked on. */
  answerPermission(sessionId: string, permissionId: string, answer: PermissionAnswer): AnswerResult;
  /** Return an exec/fs result the agent-host ran on its own ExecBackend. */
  answerExec(sessionId: string, execId: string, payload: ExecResultPayload): AnswerResult;
  /** Forward a tunnel frame from the agent-host down to the container; a tunnel stream is not a run and bypasses the run bookkeeping. */
  answerTunnel(sessionId: string, streamId: string, frame: WireFrame): AnswerResult;
  /** Subscribe to container-to-cloud tunnel frames, which are kept out of run streams; returns unsubscribe. */
  onTunnelFrame(cb: (sessionId: string, frame: WireFrame) => void): () => void;
  /** Feed a raw frame received from a container's socket. */
  onContainerFrame(sessionId: string, raw: string): void;
  /** Resume the session's link if asked, else start fresh. */
  onContainerAttached(sessionId: string, socket: ContainerSocket, link?: LinkRequest): AttachedLink;
  /** Hold a resumable link for the grace window, else end runs. */
  onContainerClosed(sessionId: string, socket: ContainerSocket): void;
  /** The container is gone for good: terminate its runs. */
  onContainerGone(sessionId: string): void;
}

/** One in-flight run: a queue of frames plus whoever is waiting to read the next one. */
interface PendingRun {
  sessionId: string;
  /** The ACP session this run drives; undefined for the handshake calls, which produce no notifications. */
  acpSessionId?: string;
  /** The caller's frame id, which the ack yielded back up is rewritten to. */
  callerId?: string;
  queue: WireFrame[];
  waiter?: (frame: WireFrame | null) => void;
  done: boolean;
}

export function createRunRelay(config: RunRelayConfig): RunRelay {
  const { registry } = config;
  const graceMs = config.linkGraceMs ?? LINK_GRACE_MS;
  // sessionId -> its container link and currently bound socket.
  const links = new Map<string, { link: Link; socket?: ContainerSocket; grace?: ReturnType<typeof setTimeout> }>();
  // requestId -> the run awaiting frames, keyed by the id put on the wire so a frame is delivered only to the run whose id it carries.
  const runs = new Map<string, PendingRun>();
  // Requests the container is blocked on (permission and exec ids), kept per-session so a disconnect can abandon them wholesale.
  const awaiting = new Map<string, { sessionId: string; kind: "permission" | "exec" }>();
  // Container sessions already warned about unattributable frames.
  const warnedLegacy = new Set<string>();
  // Subscribers for container-to-cloud tunnel frames.
  const tunnelCbs = new Set<(sessionId: string, frame: WireFrame) => void>();

  const push = (run: PendingRun, frame: WireFrame): void => {
    if (run.done) return;
    // The ack carries the relay's requestId, so rewrite it to the id the caller correlates by; notifications pass through untouched.
    if (run.callerId && frame.type === "ack") {
      frame = { ...frame, id: run.callerId };
    }
    if (run.waiter) {
      const w = run.waiter;
      run.waiter = undefined;
      w(frame);
    } else {
      run.queue.push(frame);
    }
  };

  /** End a run: deliver a terminal frame, then release any reader with null to end the iterator. */
  const finish = (requestId: string, terminal: WireFrame): void => {
    const run = runs.get(requestId);
    if (!run || run.done) return;
    push(run, terminal);
    run.done = true;
    runs.delete(requestId);
    if (run.waiter) {
      const w = run.waiter;
      run.waiter = undefined;
      w(null);
    }
  };

  /** Whether a frame can reach the container, now or after resume. */
  const reachable = (sessionId: string): boolean =>
    links.has(sessionId) || registry.resolveBySession(sessionId)?.socket !== undefined;

  /** Send via the link when there is one, so drops queue. */
  const sendDown = (sessionId: string, frame: WireFrame): AnswerResult => {
    const entry = links.get(sessionId);
    if (entry) {
      entry.link.send(frame);
      if (entry.link.overflowed && !entry.socket) expire(sessionId, "outbox overflowed while disconnected");
      return { ok: true };
    }
    const socket = registry.resolveBySession(sessionId)?.socket;
    if (!socket) return { ok: false, reason: `container not connected (session ${sessionId})` };
    try {
      socket.send(JSON.stringify(frame));
    } catch (err) {
      return { ok: false, reason: `send failed: ${String(err)}` };
    }
    return { ok: true };
  };

  /** Drop a session's link and fail its waiting work. */
  const expire = (sessionId: string, why: string): void => {
    const entry = links.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.grace);
    entry.link.dispose();
    links.delete(sessionId);
    // eslint-disable-next-line no-console
    console.log(`[byoc] link lost: session=${sessionId}: ${why}`);
    relay.onContainerGone(sessionId);
  };

  /** Send a reply down to the container for a request it is blocked on, rejecting an unknown or already-answered id. */
  const replyToContainer = (
    sessionId: string,
    id: string,
    kind: "permission" | "exec",
    frame: WireFrame,
  ): AnswerResult => {
    const entry = awaiting.get(id);
    // Unknown covers a late answer after a restart, a duplicate POST and an id from a dropped connection, all of which must fail cleanly.
    if (!entry || entry.sessionId !== sessionId || entry.kind !== kind) {
      return { ok: false, reason: `unknown ${kind} ${id}` };
    }
    if (!reachable(sessionId)) return { ok: false, reason: "container not connected" };
    // Delete before sending so a concurrent duplicate cannot also pass the check above.
    awaiting.delete(id);
    return sendDown(sessionId, frame);
  };

  const relay: RunRelay = {
    prompt(sessionId, payload, callerId) {
      return this.request(sessionId, "prompt", payload, callerId);
    },

    request(sessionId, type, payload, callerId) {
      // Validate against the live socket before returning the iterable so a dead session fails fast.
      const session = registry.resolveBySession(sessionId);
      const requestId = randomUUID();
      // The ACP session this run drives, the routing key that delivers notifications and tool calls to their run only.
      // Only a prompt drives a session: a cancel or kill_terminals naming the same session must not receive a copy of the
      // running prompt's frames, or the agent-host sees every update twice and services each exec request twice.
      const acpSessionId = type === "prompt" ? (payload as { sessionId?: string } | undefined)?.sessionId : undefined;
      const run: PendingRun = { sessionId, queue: [], done: false, callerId, acpSessionId };

      let failure: string | undefined;
      if (!session) failure = `unknown session ${sessionId}`;
      else if (!reachable(sessionId)) failure = `container not connected (session ${sessionId} is offline)`;

      if (!failure) {
        runs.set(requestId, run);
        const sent = sendDown(sessionId, { ch: "acp", type, id: requestId, payload });
        if (!sent.ok) {
          runs.delete(requestId);
          failure = sent.reason;
        }
      }

      return {
        async *[Symbol.asyncIterator]() {
          if (failure) throw new Error(failure);
          for (;;) {
            if (run.queue.length) {
              yield run.queue.shift()!;
              continue;
            }
            if (run.done) return;
            const next = await new Promise<WireFrame | null>((resolve) => {
              run.waiter = resolve;
            });
            if (next === null) return;
            yield next;
          }
        },
      };
    },

    onContainerFrame(sessionId, raw) {
      let frame: WireFrame;
      try {
        frame = JSON.parse(raw) as WireFrame;
      } catch {
        return; // a malformed frame is dropped rather than killing the socket
      }
      // Link acks and replayed duplicates stop here.
      const entry = links.get(sessionId);
      if (entry && !entry.link.receive(frame)) return;
      // Skip the hello and stray link frames.
      if (frame.ch === "link" || typeof frame.type !== "string") return;
      // The agent-host never sees link bookkeeping.
      delete frame.seq;
      // Tunnel frames go to their subscribers only, never into a run's transcript.
      if (frame.ch === "tunnel") {
        for (const cb of [...tunnelCbs]) cb(sessionId, frame);
        return;
      }
      if (frame.type === "ack" && frame.id) {
        // The ack terminates its run whether it carries a result or an error.
        finish(frame.id, frame);
        return;
      }
      // A permission_request or exec frame means the container is blocked on a reply; record it so the reply routes and a duplicate is rejected.
      if (frame.id && (frame.type === "permission_request" || frame.type.startsWith("exec_") || frame.type.startsWith("fs_"))) {
        awaiting.set(frame.id, { sessionId, kind: frame.type === "permission_request" ? "permission" : "exec" });
      }
      // Route to the run the frame belongs to, keyed by the frame-level sid, then the payload's sessionId, then a permission_request's request.sessionId.
      const payload = frame.payload as
        | { sessionId?: string; request?: { sessionId?: string } }
        | undefined;
      const key = frame.sid ?? payload?.sessionId ?? payload?.request?.sessionId;
      const candidates = [...runs.values()].filter((r) => r.sessionId === sessionId);
      if (key) {
        const matched = candidates.filter((r) => r.acpSessionId === key);
        // A keyed frame with no matching run is dropped rather than put in the wrong conversation.
        for (const run of matched) push(run, frame);
        return;
      }
      // An unkeyed frame is exact with one run in flight and ambiguous with more, where it is broadcast with a one-time warning.
      if (candidates.length > 1 && !warnedLegacy.has(sessionId)) {
        warnedLegacy.add(sessionId);
        // eslint-disable-next-line no-console
        console.warn(
          `[byoc] session ${sessionId}: unkeyed ${frame.type} with ${candidates.length} concurrent runs — ` +
            `an old container image cannot attribute tool calls; upgrade it for safe concurrency`,
        );
      }
      for (const run of candidates) push(run, frame);
    },

    answerPermission(sessionId, permissionId, answer) {
      return replyToContainer(sessionId, permissionId, "permission", { ch: "acp", type: "ack", id: permissionId, payload: answer });
    },

    answerTunnel(sessionId, streamId, frame) {
      // Fail rather than drop, so the tool call fails, not hangs.
      return sendDown(sessionId, frame);
    },

    onTunnelFrame(cb) {
      tunnelCbs.add(cb);
      return () => tunnelCbs.delete(cb);
    },

    answerExec(sessionId, execId, payload) {
      return replyToContainer(sessionId, execId, "exec", { ch: "exec", type: "exec_result", id: execId, payload });
    },

    onContainerAttached(sessionId, socket, want) {
      const entry = links.get(sessionId);
      const write = (raw: string) => socket.send(raw);
      if (!want) {
        if (entry) expire(sessionId, "replaced by a container without links");
        return { start() {} };
      }
      if (entry && entry.link.id === want.id && entry.link.canResume(want.seq)) {
        clearTimeout(entry.grace);
        entry.grace = undefined;
        // Unbind a half-open predecessor.
        entry.link.detach();
        entry.socket = socket;
        // eslint-disable-next-line no-console
        console.log(`[byoc] link resumed: session=${sessionId} replaying ${entry.link.pending} frames`);
        return {
          resume: { resumed: true, seq: entry.link.received },
          start: () => {
            if (entry.socket === socket) entry.link.attach(write, want.seq);
          },
        };
      }
      if (entry) expire(sessionId, entry.link.id === want.id ? "the container's link could not be resumed" : "a new container link");
      const fresh: { link: Link; socket?: ContainerSocket } = { link: new Link(want.id), socket };
      links.set(sessionId, fresh);
      return {
        resume: { resumed: false, seq: 0 },
        start: () => {
          if (fresh.socket === socket) fresh.link.attach(write, 0);
        },
      };
    },

    onContainerClosed(sessionId, socket) {
      const entry = links.get(sessionId);
      // Without a link, runs end with the socket.
      if (!entry) return relay.onContainerGone(sessionId);
      // A superseded socket's close arrives after its replacement attached.
      if (entry.socket !== socket) return;
      entry.socket = undefined;
      entry.link.detach();
      if (entry.link.overflowed) return expire(sessionId, "outbox overflowed");
      // eslint-disable-next-line no-console
      console.log(`[byoc] holding session=${sessionId} for ${graceMs}ms while the container reconnects`);
      entry.grace = setTimeout(() => expire(sessionId, `no reconnect within ${graceMs}ms`), graceMs);
      entry.grace.unref?.();
    },

    onContainerGone(sessionId) {
      // Abandon everything this container was blocked on, so a reconnected container cannot receive replies to the previous connection's work.
      for (const [id, entry] of [...awaiting]) {
        if (entry.sessionId === sessionId) awaiting.delete(id);
      }
      // Terminate every run on this container, or the agent-host waits forever.
      for (const [requestId, run] of [...runs]) {
        if (run.sessionId !== sessionId) continue;
        finish(requestId, {
          ch: "acp",
          type: "ack",
          id: requestId,
          payload: { error: "container disconnected mid-run" },
        });
      }
    },
  };
  return relay;
}
