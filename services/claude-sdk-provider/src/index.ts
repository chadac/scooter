/**
 * @scooter/claude-sdk-provider — the Claude Agent SDK-backed AcpClient, isolated
 * so the SDK's zod v4 peer-dep doesn't collide with agent-host's zod v3.
 *
 * agent-host imports ONLY createSdkAcpClient from here and consumes the returned
 * AcpClient (structurally identical to its own). See ./types.ts for the boundary.
 */
export { createSdkAcpClient, type SdkAcpClientDeps } from "./sdkClient.js";
export { summarizeConversation, type SummaryTurn, type SummarizeDeps } from "./summarize.js";
export type { AcpClient, ExecBackend } from "./types.js";
// Exported for the cross-provider transcript harness: re-derive normalized updates
// from recorded raw SDK messages through the LIVE adapter (see the harness doc).
export { sdkMessageToUpdates, type SdkMessage } from "./sdkAdapter.js";
