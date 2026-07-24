/**
 * @scooter/claude-sdk-provider — the Claude Agent SDK-backed AcpClient, isolated
 * so the SDK's zod v4 peer-dep doesn't collide with agent-host's zod v3.
 *
 * agent-host imports ONLY createSdkAcpClient from here and consumes the returned
 * AcpClient (structurally identical to its own). See ./types.ts for the boundary.
 */
export { createSdkAcpClient, type SdkAcpClientDeps } from "./sdkClient.js";
export type { AcpClient, ExecBackend } from "./types.js";
