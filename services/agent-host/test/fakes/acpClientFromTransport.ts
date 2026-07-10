/**
 * Adapter: wraps an in-process FakeAcpTransport as an AcpClient so the bridge
 * can be driven without spawning a real `goose acp` subprocess.
 */

import type {
  AcpClient,
  InitializeParams,
  NewSessionParams,
  PromptParams,
  SessionUpdate,
  PermissionRequest,
} from "../../src/acp/client.js";
import type { ExecBackend } from "../../src/types.js";
import type { FakeAcpTransport } from "./fakeAcpAgent.js";

export function acpClientFromTransport(
  transport: FakeAcpTransport,
  _exec: ExecBackend,
): AcpClient {
  const updateCbs = new Set<(sessionId: string, u: SessionUpdate) => void>();
  const terminalCreatedCbs = new Set<(terminalId: string, command: string, args: string[]) => void>();
  let permissionHandler:
    | ((req: PermissionRequest) => Promise<{ optionId: string }>)
    | undefined;

  return {
    async initialize(_params: InitializeParams) {
      return transport.initialize();
    },
    async newSession(_params: NewSessionParams) {
      return transport.newSession();
    },
    async prompt(params: PromptParams) {
      return transport.prompt(params.sessionId, {
        onUpdate: (u) => {
          for (const cb of updateCbs) cb(params.sessionId, u);
        },
        onPermission: permissionHandler
          ? (r) => permissionHandler!(r)
          : undefined,
      });
    },
    async cancel(sessionId: string) {
      await transport.cancel(sessionId);
    },
    async killActiveTerminals() {
      // The in-process transport tracks its own terminals; expose a hook if set so
      // a cancel test can assert terminals were killed. No-op otherwise.
      await transport.killActiveTerminals?.();
    },
    onSessionUpdate(cb) {
      updateCbs.add(cb);
      return () => updateCbs.delete(cb);
    },
    onTerminalCreated(cb) {
      // A test can drive this via transport.emitTerminalCreated (if it models a
      // terminal-based shell tool); otherwise it simply never fires. This keeps the
      // fake AcpClient shape-complete without every test needing terminal plumbing.
      terminalCreatedCbs.add(cb);
      transport.onTerminalCreated?.((terminalId, command, args) => {
        for (const c of terminalCreatedCbs) c(terminalId, command, args);
      });
      return () => terminalCreatedCbs.delete(cb);
    },
    onPermissionRequest(handler) {
      permissionHandler = handler;
    },
    async close() {
      await transport.close();
    },
  };
}
