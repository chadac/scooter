/**
 * The show_sandbox_resources / set_sandbox_resources MCP tools — let the agent see
 * its sandbox's current cpu/memory/gpu and RIGHT-SIZE its own sandbox (e.g. "this
 * build needs more memory → restart at 8Gi"). Customers ship an intro skill telling
 * the agent when to scale up/down.
 *
 * Pure handlers (no MCP/HTTP plumbing) for unit testing; mcpServer.ts registers
 * them. Validation lives HERE (set_sandbox_resources rejects a bad quantity via
 * validateResources); the wiring's setResources does the mechanism (persist the
 * override on ConversationMeta -> suspend -> resume(override) so the pod comes back
 * at the new size). set_sandbox_resources ALWAYS restarts the pod — call it out.
 *
 * Design (PoC stage 2): signatures + doc only. Bodies throw `unimplemented`.
 */

import type { ToolResult } from "./mcpServer.js";
import { validateResources, InvalidResourceError, type SandboxResources } from "../session/resources.js";

/** What the resource tools need from the agent-host. */
export interface SandboxResourceToolsWiring {
  /** This conversation's EFFECTIVE resources (resolved override → deploy default →
   *  platform default), for show_sandbox_resources. */
  currentResources(conversationId: string): SandboxResources;
  /** Persist the override on ConversationMeta, then restart the pod (suspend ->
   *  resume(override)) so it comes back at the new size. Resolves to whether a
   *  restart happened (false = the requested resources equal the current effective
   *  ones — no-op). Rejects if a switch is in flight (serialized against
   *  modify_environment) or the patch fails. */
  setResources(conversationId: string, resources: SandboxResources): Promise<boolean>;
}

/** The set_sandbox_resources tool input (friendly shape; all optional — an omitted
 *  dimension keeps its current value). Mirrors SandboxResources; flat for the LLM. */
export interface SetSandboxResourcesArgs {
  requestCpu?: string;
  requestMemory?: string;
  requestGpu?: number;
  limitCpu?: string;
  limitMemory?: string;
  limitGpu?: number;
}

/** Render one side of a resources block as "cpu=…, memory=…, gpu=…" (only the set
 *  dimensions), or "(default)" when nothing is set on that side. */
function sideLine(q: { cpu?: string; memory?: string; gpu?: number } | undefined): string {
  const parts = [
    q?.cpu !== undefined ? `cpu=${q.cpu}` : null,
    q?.memory !== undefined ? `memory=${q.memory}` : null,
    q?.gpu !== undefined ? `gpu=${q.gpu}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "(default)";
}

/** Fold the flat tool args into the nested SandboxResources shape, dropping sides
 *  with nothing set (so an omitted dimension stays omitted, not zeroed). */
function argsToResources(args: SetSandboxResourcesArgs): SandboxResources {
  const requests: { cpu?: string; memory?: string; gpu?: number } = {};
  const limits: { cpu?: string; memory?: string; gpu?: number } = {};
  if (args.requestCpu !== undefined) requests.cpu = args.requestCpu;
  if (args.requestMemory !== undefined) requests.memory = args.requestMemory;
  if (args.requestGpu !== undefined) requests.gpu = args.requestGpu;
  if (args.limitCpu !== undefined) limits.cpu = args.limitCpu;
  if (args.limitMemory !== undefined) limits.memory = args.limitMemory;
  if (args.limitGpu !== undefined) limits.gpu = args.limitGpu;
  const r: SandboxResources = {};
  if (Object.keys(requests).length) r.requests = requests;
  if (Object.keys(limits).length) r.limits = limits;
  return r;
}

/** show_sandbox_resources: render the conversation's current cpu/memory/gpu. */
export function handleShowSandboxResources(
  deps: SandboxResourceToolsWiring,
  conversationId: string,
): ToolResult {
  const r = deps.currentResources(conversationId);
  return {
    content: [
      {
        type: "text",
        text:
          "Your sandbox resources:\n" +
          `- requests: ${sideLine(r.requests)}\n` +
          `- limits: ${sideLine(r.limits)}\n` +
          "Change them with set_sandbox_resources (restarts the sandbox).",
      },
    ],
  };
}

/** set_sandbox_resources: validate the requested resources, persist the override,
 *  and RESTART the pod at the new size. Returns the applied total + the restart
 *  note; on a bad quantity returns isError with the exact field to fix. */
export async function handleSetSandboxResources(
  deps: SandboxResourceToolsWiring,
  conversationId: string,
  args: SetSandboxResourcesArgs,
): Promise<ToolResult> {
  const requested = argsToResources(args);
  try {
    validateResources(requested);
  } catch (e) {
    if (e instanceof InvalidResourceError) {
      return { isError: true, content: [{ type: "text", text: `${e.message} (${e.field})` }] };
    }
    throw e;
  }
  let restarted: boolean;
  try {
    restarted = await deps.setResources(conversationId, requested);
  } catch (e) {
    // A rejection is a real failure (e.g. a switch is in flight, or the patch
    // failed) — surface it so the agent knows the resize did NOT take, never hide it.
    return { isError: true, content: [{ type: "text", text: `Could not resize the sandbox: ${(e as Error).message}` }] };
  }
  if (!restarted) {
    return { content: [{ type: "text", text: "Those resources match your sandbox's current size — no change, no restart." }] };
  }
  return {
    content: [
      {
        type: "text",
        text:
          "Applied — your sandbox is RESTARTING at the new size. Any in-flight foreground work was interrupted; " +
          "wait for it to come back before running commands.",
      },
    ],
  };
}
