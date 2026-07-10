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
  /** Optional: a cancel test can set this to assert active terminals were killed. */
  killActiveTerminals?(): Promise<void>;
  /** Subscribe to terminal/create (goose's shell command source). A test drives it
   *  via FakeAcpAgent.terminalCreated(...). */
  onTerminalCreated?(cb: (terminalId: string, command: string, args: string[]) => void): void;
  close(): Promise<void>;
}

export interface FakeAcpAgent {
  setScript(steps: ScriptStep[]): void;
  readonly transport: FakeAcpTransport;
  /** Hold every prompt in flight until releaseGate() (so a test can inspect the
   *  queue mid-run / drive a cancel). Off by default. */
  gate(): void;
  releaseGate(): void;
  /** Number of times killActiveTerminals was called (cancel assertions). */
  killCount(): number;
  /** Number of prompts that have STARTED (entered the fake's prompt()). */
  startedCount(): number;
  /** Push a session update to the CURRENTLY-RUNNING prompt's onUpdate — for a
   *  test to deliver a tool_call_update result while the run is gated. */
  emit(u: SessionUpdate): void;
  /** Simulate goose creating a terminal for a shell command (the terminal/create
   *  call where the command text lives). Fires the bridge's onTerminalCreated. */
  terminalCreated(terminalId: string, command: string, args: string[]): void;
  close(): void;
}

export function createFakeAcpAgent(): FakeAcpAgent {
  let script: ScriptStep[] = [];
  let sessionCounter = 0;
  let gated = false;
  let releaseGateFn: (() => void) | undefined;
  let kills = 0;
  let starts = 0;
  const cancelledSessions = new Set<string>();
  // The live onUpdate of the currently-running prompt, so a test can push an
  // update MID-RUN (e.g. a tool_call_update result while the run is gated).
  let liveUpdate: ((u: SessionUpdate) => void) | undefined;
  const terminalCreatedCbs = new Set<(terminalId: string, command: string, args: string[]) => void>();

  const transport: FakeAcpTransport = {
    async initialize() {
      return { protocolVersion: 1 };
    },
    async newSession() {
      sessionCounter += 1;
      return { sessionId: `fake-session-${sessionCounter}` };
    },
    async prompt(sessionId, handlers) {
      starts += 1;
      liveUpdate = handlers.onUpdate; // exposed via emit() for mid-run pushes
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
      // Optional gate: hold the run in flight until releaseGate(), so a test can
      // inspect the queue / drive a cancel while this run is "running".
      if (gated) {
        await new Promise<void>((res) => { releaseGateFn = res; });
      }
      // A cancel that landed while gated resolves the prompt as cancelled.
      if (cancelledSessions.delete(sessionId)) stopReason = "cancelled";
      return { stopReason };
    },
    async cancel(sessionId: string) {
      cancelledSessions.add(sessionId);
      // Release a gated run so its prompt() resolves (as cancelled).
      releaseGateFn?.();
      releaseGateFn = undefined;
    },
    async killActiveTerminals() {
      kills += 1;
    },
    onTerminalCreated(cb) {
      terminalCreatedCbs.add(cb);
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
    gate() {
      gated = true;
    },
    releaseGate() {
      gated = false;
      releaseGateFn?.();
      releaseGateFn = undefined;
    },
    killCount() {
      return kills;
    },
    startedCount() {
      return starts;
    },
    emit(u: SessionUpdate) {
      liveUpdate?.(u);
    },
    terminalCreated(terminalId, command, args) {
      for (const cb of terminalCreatedCbs) cb(terminalId, command, args);
    },
    close() {
      script = [];
    },
  };
}
