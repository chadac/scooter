/**
 * Fake ACP agent (in-process) — honors the ACP *agent* side for Tier 1 tests.
 *
 * Drives the agent-host's AcpClient deterministically: given a script, it emits
 * session/update notifications and (optionally) calls client methods
 * (terminal/*, fs/*, session/request_permission) so we can assert the bridge's
 * AG-UI output and the ExecBackend routing.
 *
 * Implemented as an in-process transport: the AcpClient created with this
 * agent's `transport` invokes the agent directly (no real subprocess/stdio),
 * keeping Tier 1 fast and deterministic.
 */

import type { SessionUpdate, PermissionRequest } from "../../src/acp/client.js";

export type ScriptStep =
  | { emit: SessionUpdate }
  | { callTerminal: { command: string; args: string[] } }
  | { callFsRead: { path: string } }
  | { callFsWrite: { path: string; content: string } }
  | { requestPermission: Omit<PermissionRequest, "sessionId"> }
  | { finish: { stopReason: string } };

/**
 * In-process ACP transport: the side the AcpClient talks to. The fake agent
 * plays its script when `prompt` is called, pushing updates back through the
 * provided callbacks.
 */
export interface FakeAcpTransport {
  initialize(): Promise<{ protocolVersion: number }>;
  newSession(): Promise<{ sessionId: string }>;
  prompt(
    sessionId: string,
    handlers: {
      onUpdate: (u: SessionUpdate) => void;
      onPermission?: (r: PermissionRequest) => Promise<{ optionId: string }>;
    },
  ): Promise<{ stopReason: string }>;
  cancel(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

export interface FakeAcpAgent {
  setScript(steps: ScriptStep[]): void;
  readonly transport: FakeAcpTransport;
  close(): void;
}

export function createFakeAcpAgent(): FakeAcpAgent {
  let script: ScriptStep[] = [];
  let sessionCounter = 0;

  const transport: FakeAcpTransport = {
    async initialize() {
      return { protocolVersion: 1 };
    },
    async newSession() {
      sessionCounter += 1;
      return { sessionId: `fake-session-${sessionCounter}` };
    },
    async prompt(sessionId, handlers) {
      let stopReason = "end_turn";
      for (const step of script) {
        if ("emit" in step) {
          handlers.onUpdate(step.emit);
        } else if ("requestPermission" in step) {
          if (handlers.onPermission) {
            await handlers.onPermission({ sessionId, ...step.requestPermission });
          }
        } else if ("finish" in step) {
          stopReason = step.finish.stopReason;
        }
        // callTerminal / callFsRead / callFsWrite are exercised by the real
        // ACP client method path in higher tiers; the in-process fake focuses
        // on update emission + permission flow for bridge assertions.
      }
      return { stopReason };
    },
    async cancel() {
      /* no-op for the fake */
    },
    async close() {
      /* no-op */
    },
  };

  return {
    setScript(steps) {
      script = steps;
    },
    transport,
    close() {
      script = [];
    },
  };
}
