/**
 * Fake ACP agent (in-process) — honors the ACP *agent* side for Tier 1 tests.
 *
 * Drives the agent-host's AcpClient deterministically: given a script, it emits
 * session/update notifications and (optionally) calls client methods
 * (terminal/*, fs/*, session/request_permission) so we can assert the bridge's
 * AG-UI output and the ExecBackend routing.
 *
 * Design stage: this is a TEST DOUBLE spec — shape only, no implementation.
 */

import type { SessionUpdate, PermissionRequest } from "../../src/acp/client.js";

export type ScriptStep =
  | { emit: SessionUpdate }
  | { callTerminal: { command: string; args: string[] } }
  | { callFsRead: { path: string } }
  | { callFsWrite: { path: string; content: string } }
  | { requestPermission: Omit<PermissionRequest, "sessionId"> }
  | { finish: { stopReason: string } };

export interface FakeAcpAgent {
  /** Script played out in order when the host sends session/prompt. */
  setScript(steps: ScriptStep[]): void;
  /** stdio endpoints to wire into createAcpClient (or an in-proc transport). */
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  close(): void;
}

export declare function createFakeAcpAgent(): FakeAcpAgent;
