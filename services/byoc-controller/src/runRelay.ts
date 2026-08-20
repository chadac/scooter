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
import type { AcpPromptPayload, WireFrame } from "./remoteProtocol.js";

export interface RunRelayConfig {
  registry: SessionRegistry;
}

export interface RunRelay {
  /** Send a prompt and stream this run's frames back. Rejects (rather than hanging) if the
   *  container is not reachable. The stream ends on the run's `ack`. */
  prompt(sessionId: string, payload: AcpPromptPayload): AsyncIterable<WireFrame>;
  /** Feed a raw frame received from a container's socket. */
  onContainerFrame(sessionId: string, raw: string): void;
  /** The container's socket closed — terminate every run still waiting on it. */
  onContainerGone(sessionId: string): void;
}

/** One in-flight run: a queue of frames plus whoever is waiting to read the next one. */
interface PendingRun {
  sessionId: string;
  queue: WireFrame[];
  waiter?: (frame: WireFrame | null) => void;
  done: boolean;
}

export function createRunRelay(config: RunRelayConfig): RunRelay {
  const { registry } = config;
  // requestId -> the run awaiting frames. Keyed by the id we put ON THE WIRE, which is what makes
  // concurrent runs on one socket safe: a frame is delivered only to the run whose id it carries.
  const runs = new Map<string, PendingRun>();

  const push = (run: PendingRun, frame: WireFrame): void => {
    if (run.done) return;
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

  return {
    prompt(sessionId, payload) {
      // Resolve + validate BEFORE returning the iterable so a dead session fails fast. The check is
      // against the live SOCKET, never the durable row: a stale "online" would send this prompt
      // into a socket nobody is listening on and the run would never terminate.
      const session = registry.resolveBySession(sessionId);
      const requestId = randomUUID();
      const run: PendingRun = { sessionId, queue: [], done: false };

      let failure: string | undefined;
      if (!session) failure = `unknown session ${sessionId}`;
      else if (!session.socket) failure = `container not connected (session ${sessionId} is offline)`;

      if (!failure && session?.socket) {
        runs.set(requestId, run);
        const frame: WireFrame<AcpPromptPayload> = { ch: "acp", type: "prompt", id: requestId, payload };
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
      // Notifications (session_update, terminal_created) carry the ACP session, not our request id,
      // so route them to the runs on this container. With one run in flight per ACP session this is
      // exact; concurrent runs are separated by their own ids at the ack.
      for (const [, run] of runs) {
        if (run.sessionId === sessionId) push(run, frame);
      }
    },

    onContainerGone(sessionId) {
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
