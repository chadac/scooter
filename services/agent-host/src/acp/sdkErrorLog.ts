// Summarizes the ACP SDK's failure logs; params' payload never reaches logs.

import { errorText, logger } from "../log.js";

const log = logger("acp-sdk");

// SDK console.error prefixes whose second argument is the raw message.
const SDK_PREFIXES = [
  "Error handling request",
  "Error handling notification",
  "Unexpected error during message processing:",
];

let installed = false;

/** Route the ACP SDK's failure lines through the structured logger, once. */
export function installAcpSdkErrorLog(): void {
  if (installed) return;
  installed = true;
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === "string" && SDK_PREFIXES.includes(args[0])) {
      log.error(args[0], { ...summarizeMessage(args[1]), error: errorText(args[2]) });
      return;
    }
    original(...args);
  };
}

/** A JSON-RPC message's identifying fields, without its content. */
export function summarizeMessage(message: unknown): Record<string, unknown> {
  if (!message || typeof message !== "object") return {};
  const { id, method, params } = message as { id?: unknown; method?: unknown; params?: unknown };
  const p = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  if (id !== undefined) out.rpc_id = id;
  if (typeof method === "string") out.method = method;
  if (typeof p.sessionId === "string") out.acp_session_id = p.sessionId;
  if (typeof p.path === "string") out.path = p.path;
  if (typeof p.terminalId === "string") out.terminal_id = p.terminalId;
  return out;
}
