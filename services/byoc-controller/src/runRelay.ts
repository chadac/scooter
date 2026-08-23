/**
 * The BYOC run relay — one prompt in, a stream of ACP frames out.
 *
 *   agent-host --POST /byoc/:session/prompt--> [relay] --WS--> container
 *   agent-host <----------- SSE (ACP frames) --[relay] <--WS-- container
 *
 * The agent-host holds NOTHING (§L decision 1): it POSTs and reads a stream, so any replica can
 * serve any conversation and a rollout cannot strand a run. The controller owns the single duplex
 * WS to the container and does exactly two jobs — forward frames, and correlate ids.
 *
 * THE INVARIANT THAT MATTERS: every stream must TERMINATE. One container socket multiplexes many
 * runs, so a lost ack, a mis-correlated id, or a dropped socket must each end the affected stream
 * with a terminal frame. A relay that hangs is worse than one that errors — the agent-host's run
 * would never finish, and the user would sit watching a spinner forever with no RUN_ERROR.
 */

import { randomUUID } from "node:crypto";

import type { SessionRegistry } from "./sessionRegistry.js";
import type { AcpPromptPayload, ExecResultPayload, WireFrame } from "./remoteProtocol.js";

/** The user's decision on a permission request. */
export type PermissionAnswer = { optionId: string } | { cancelled: true };

export type AnswerResult = { ok: true } | { ok: false; reason: string };

export interface RunRelayConfig {
  registry: SessionRegistry;
}

export interface RunRelay {
  /** Send a prompt and stream this run's frames back. Rejects (rather than hanging) if the
   *  container is not reachable. The stream ends on the run's `ack`. */
  prompt(sessionId: string, payload: AcpPromptPayload, callerId?: string): AsyncIterable<WireFrame>;
  /** Send ANY ACP request (initialize / new_session / prompt / cancel / kill_terminals) and stream
   *  the reply. `prompt` is the special case; the others are how the handshake completes at all.
   *  Forwarding everything as type:"prompt" made initialize/new_session arrive at the container as
   *  an EMPTY prompt, so the ACP session was never established and no run could start. */
  /** `callerId` is the CALLER'S frame id, round-tripped onto every frame yielded back up.
   *  The agent-host's remoteAcpClient correlates request→ack BY FRAME ID; the relay minting
   *  its own id and yielding the container's ack unmapped left the caller waiting on an id
   *  that never arrived — every real BYOC run hung at `initialize` and died
   *  no_activity_timeout (curl probes, which don't correlate, looked healthy). */
  request(sessionId: string, type: string, payload: unknown, callerId?: string): AsyncIterable<WireFrame>;
  /** Answer a permission the container is BLOCKED on (§L Q1). Stateless — mirrors the UI's
   *  existing POST /conversations/:id/permission/:toolCallId. */
  answerPermission(sessionId: string, permissionId: string, answer: PermissionAnswer): AnswerResult;
  /** Return an exec/fs result the AGENT-HOST ran on its own ExecBackend (§L Q2). */
  answerExec(sessionId: string, execId: string, payload: ExecResultPayload): AnswerResult;
  /** Forward a TUNNEL frame from the agent-host down to the container — a response chunk or a
   *  close for a stream the container opened (MCP over the wire; see remoteProtocol.ts Channel
   *  C). Unlike prompt(), a tunnel stream is NOT a run: it has no ack and never terminates one,
   *  so it must never be routed through the run bookkeeping.
   *
   *  Design stage: SIGNATURE ONLY. */
  answerTunnel(sessionId: string, streamId: string, frame: WireFrame): AnswerResult;
  /** Feed a raw frame received from a container's socket. */
  onContainerFrame(sessionId: string, raw: string): void;
  /** The container's socket closed — terminate every run still waiting on it. */
  onContainerGone(sessionId: string): void;
}

/** One in-flight run: a queue of frames plus whoever is waiting to read the next one. */
interface PendingRun {
  sessionId: string;
  /** The ACP session this run drives (from the prompt/cancel payload); undefined for the
   *  handshake calls, which produce no notifications. */
  acpSessionId?: string;
  /** The caller's frame id — every frame yielded back up whose id is the RELAY's requestId is
   *  rewritten to this, so the caller's by-id correlation resolves. */
  callerId?: string;
  queue: WireFrame[];
  waiter?: (frame: WireFrame | null) => void;
  done: boolean;
}

export function createRunRelay(config: RunRelayConfig): RunRelay {
  const { registry } = config;
  // requestId -> the run awaiting frames. Keyed by the id we put ON THE WIRE, which is what makes
  // concurrent runs on one socket safe: a frame is delivered only to the run whose id it carries.
  const runs = new Map<string, PendingRun>();
  // Requests the CONTAINER is blocked on, awaiting a reply from above: permission ids (§L Q1) and
  // exec ids (§L Q2). Kept per-session so a disconnect can abandon them wholesale — a reconnecting
  // container must never inherit the previous connection's pending work.
  const awaiting = new Map<string, { sessionId: string; kind: "permission" | "exec" }>();
  // Container sessions we have already warned about unattributable frames for (once each).
  const warnedLegacy = new Set<string>();

  const push = (run: PendingRun, frame: WireFrame): void => {
    if (run.done) return;
    // ROUND-TRIP the caller's id: the ack coming up carries the relay's requestId (what the
    // container was sent); the caller correlates by the id IT sent. Rewrite at the delivery
    // boundary so every ack resolves the caller's pending request. Notifications (no id, or a
    // container-minted id like permission_request) pass through untouched.
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

  /** End a run: deliver a terminal frame, then release any reader with null (ends the iterator). */
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

  /** Send a reply down to the container for a request it is blocked on. Rejects an unknown or
   *  already-answered id rather than writing a second ack. */
  const replyToContainer = (
    sessionId: string,
    id: string,
    kind: "permission" | "exec",
    frame: WireFrame,
  ): AnswerResult => {
    const entry = awaiting.get(id);
    // Unknown covers three real cases, all of which must fail cleanly rather than throw: a late
    // answer after a controller restart (the human-decision window has no timeout), a duplicate
    // POST from two tabs, and an id from a connection that has since dropped.
    if (!entry || entry.sessionId !== sessionId || entry.kind !== kind) {
      return { ok: false, reason: `unknown ${kind} ${id}` };
    }
    const session = registry.resolveBySession(sessionId);
    if (!session?.socket) return { ok: false, reason: "container not connected" };
    // Delete BEFORE sending so a concurrent duplicate cannot also pass the check above.
    awaiting.delete(id);
    try {
      session.socket.send(JSON.stringify(frame));
    } catch (err) {
      return { ok: false, reason: `send failed: ${String(err)}` };
    }
    return { ok: true };
  };

  return {
    prompt(sessionId, payload, callerId) {
      return this.request(sessionId, "prompt", payload, callerId);
    },

    request(sessionId, type, payload, callerId) {
      // Resolve + validate BEFORE returning the iterable so a dead session fails fast. The check is
      // against the live SOCKET, never the durable row: a stale "online" would send this prompt
      // into a socket nobody is listening on and the run would never terminate.
      const session = registry.resolveBySession(sessionId);
      const requestId = randomUUID();
      // The ACP session this run drives, when the request names one (prompt/cancel do; the
      // handshake calls do not). This is the routing key that makes CONCURRENT conversations
      // on one container safe — notifications and tool calls deliver to THEIR run only.
      const acpSessionId = (payload as { sessionId?: string } | undefined)?.sessionId;
      const run: PendingRun = { sessionId, queue: [], done: false, callerId, acpSessionId };

      let failure: string | undefined;
      if (!session) failure = `unknown session ${sessionId}`;
      else if (!session.socket) failure = `container not connected (session ${sessionId} is offline)`;

      if (!failure && session?.socket) {
        runs.set(requestId, run);
        const frame: WireFrame = { ch: "acp", type, id: requestId, payload };
        try {
          session.socket.send(JSON.stringify(frame));
        } catch (err) {
          runs.delete(requestId);
          failure = `send failed: ${String(err)}`;
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
        return; // a malformed frame is dropped, never allowed to kill the socket
      }
      if (frame.type === "ack" && frame.id) {
        // The ack terminates its run — whether it carries a result or an error. Both are "the run
        // is over"; only a HANG would be a bug.
        finish(frame.id, frame);
        return;
      }
      // A permission_request / exec_* frame means the container is now BLOCKED waiting for us.
      // Record it so the reply can be routed and so a duplicate reply can be rejected — a second
      // ack would resolve an already-settled call and desync the protocol.
      if (frame.id && (frame.type === "permission_request" || frame.type.startsWith("exec_") || frame.type.startsWith("fs_"))) {
        awaiting.set(frame.id, { sessionId, kind: frame.type === "permission_request" ? "permission" : "exec" });
      }
      // Route notifications + tool-call frames to THE run they belong to. The key, in order of
      // trust: the frame-level sid (stamped by a current container — the only attribution exec
      // frames have), the notification payload's sessionId (session_update has carried it since
      // day one), or a permission_request's request.sessionId. Broadcasting instead — the old
      // behaviour — interleaved conversation A's transcript with B's and had BOTH cloud sides
      // execute the same tool call.
      const payload = frame.payload as
        | { sessionId?: string; request?: { sessionId?: string } }
        | undefined;
      const key = frame.sid ?? payload?.sessionId ?? payload?.request?.sessionId;
      const candidates = [...runs.values()].filter((r) => r.sessionId === sessionId);
      if (key) {
        const matched = candidates.filter((r) => r.acpSessionId === key);
        // A keyed frame with no matching run (a late chunk after its ack) is dropped — pushing
        // it anywhere else would put it in the WRONG conversation.
        for (const run of matched) push(run, frame);
        return;
      }
      // LEGACY / unkeyed frame (an old container's exec request, terminal_created). With exactly
      // one run in flight this is exact — the pre-concurrency world. With more it is ambiguous;
      // keep the old broadcast (both conversations already share one legacy container's brain)
      // and say so, once per container session, so the fix is a container-image upgrade away.
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
      void sessionId;
      void streamId;
      void frame;
      throw new Error("not implemented (design stage)");
    },

    answerExec(sessionId, execId, payload) {
      return replyToContainer(sessionId, execId, "exec", { ch: "exec", type: "exec_result", id: execId, payload });
    },

    onContainerGone(sessionId) {
      // Abandon everything this container was blocked on. Answering into a dead socket would throw,
      // and leaving the ids around would let a RECONNECTED container receive replies to work the
      // previous connection started.
      for (const [id, entry] of [...awaiting]) {
        if (entry.sessionId === sessionId) awaiting.delete(id);
      }
      // Terminate every run on this container. Without this the agent-host waits forever on a
      // socket that will never answer — the exact hang this relay exists to make impossible.
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
}
