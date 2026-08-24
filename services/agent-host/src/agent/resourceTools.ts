/**
 * The show_sandbox_resources / set_sandbox_resources MCP tools — let the agent see
 * its sandbox's current cpu/memory/gpu and RIGHT-SIZE its own sandbox (e.g. "this
 * build needs more memory → set 8Gi"). Customers ship an intro skill telling the
 * agent when to scale up/down.
 *
 * Pure handlers (no MCP/HTTP plumbing) for unit testing; mcpServer.ts registers
 * them. Validation lives HERE (set_sandbox_resources rejects a bad quantity via
 * validateResources); the wiring's setResources WRITES THE BROKER SIZE SPEC, which
 * the broker applies on the NEXT sandbox restart (sizing is broker-owned now — the
 * agent-host no longer suspends/resumes or persists on ConversationMeta).
 */

import type { ToolResult } from "./mcpServer.js";
import { validateResources, InvalidResourceError, type SandboxResources } from "../session/resources.js";

/** What the resource tools need from the agent-host. */
export interface SandboxResourceToolsWiring {
  /** This conversation's stored size spec (the broker GET /size result; `{}` when
   *  nothing is stored — the agent sees "default"), for show_sandbox_resources.
   *  May be async (it reads the broker). */
  currentResources(conversationId: string): SandboxResources | Promise<SandboxResources>;
  /** Write the size spec to the broker (PUT /size). The broker applies it on the
   *  NEXT sandbox restart — this does NOT restart the pod. Accepts either a preset
   *  name (via {size: "large"}) OR raw resources. Resolves to true when the spec was
   *  recorded. Rejects if the broker write fails. */
  setResources(conversationId: string, resources: SandboxResources | { size: string }): Promise<boolean>;
  /** Get the available named sandbox size presets (name → {cpu, memory}) and the
   *  default preset name, from GET /sandbox-sizes. Used to validate preset names and
   *  show the agent what's available. May be async (reads the broker). */
  availableSizes?(): Promise<{ sizes: Record<string, { cpu: string; memory: string }>; default: string | null }>;
}

/** The set_sandbox_resources tool input (friendly shape; all optional — an omitted
 *  dimension keeps its current value). Accepts EITHER a preset name (size) OR raw
 *  resources (the cpu/memory/gpu fields). Mirrors SandboxResources; flat for the LLM. */
export interface SetSandboxResourcesArgs {
  size?: string;
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

/** show_sandbox_resources: render the conversation's current cpu/memory/gpu (the
 *  stored broker size spec). Async — it reads the broker. */
export async function handleShowSandboxResources(
  deps: SandboxResourceToolsWiring,
  conversationId: string,
): Promise<ToolResult> {
  const r = await deps.currentResources(conversationId);
  return {
    content: [
      {
        type: "text",
        text:
          "Your sandbox resources:\n" +
          `- requests: ${sideLine(r.requests)}\n` +
          `- limits: ${sideLine(r.limits)}\n` +
          "Change them with set_sandbox_resources (applies on the next sandbox restart).",
      },
    ],
  };
}

/** set_sandbox_resources: validate the requested resources, then WRITE the broker
 *  size spec. The broker applies it on the NEXT sandbox restart — this does not
 *  restart the pod now. Accepts EITHER a preset name (size) OR raw resources. On a
 *  bad quantity or unknown preset returns isError with the exact field/issue to fix. */
export async function handleSetSandboxResources(
  deps: SandboxResourceToolsWiring,
  conversationId: string,
  args: SetSandboxResourcesArgs,
): Promise<ToolResult> {
  // Preset-name path: pass {size: "..."} straight to the broker (it resolves the preset).
  // Raw-resources path: validate + fold the flat args into the nested shape.
  if (args.size) {
    // Preset name provided — validate it exists if we can query available sizes.
    if (deps.availableSizes) {
      try {
        const { sizes } = await deps.availableSizes();
        if (!Object.keys(sizes).includes(args.size)) {
          const available = Object.keys(sizes).join(", ") || "(no presets configured)";
          return {
            isError: true,
            content: [{ type: "text", text: `Unknown size preset "${args.size}". Available: ${available}` }],
          };
        }
      } catch (e) {
        // Sizes query failed — let the broker reject it (don't block the write).
        console.warn(`[resourceTools] could not query available sizes: ${(e as Error).message}`);
      }
    }
    // Pass the preset name to the broker as {size: "..."}.
    try {
      await deps.setResources(conversationId, { size: args.size });
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `Could not set the sandbox size: ${(e as Error).message}` }] };
    }
    return {
      content: [
        {
          type: "text",
          text:
            `Recorded size preset "${args.size}" — it takes effect on the NEXT sandbox restart (not applied to the ` +
            "running pod right now). Nothing was interrupted.",
        },
      ],
    };
  } else {
    // Raw-resources path: validate + fold the flat args into the nested shape.
    const requested = argsToResources(args);
    try {
      validateResources(requested);
    } catch (e) {
      if (e instanceof InvalidResourceError) {
        return { isError: true, content: [{ type: "text", text: `${e.message} (${e.field})` }] };
      }
      throw e;
    }
    try {
      await deps.setResources(conversationId, requested);
    } catch (e) {
      // A rejection is a real failure (the broker write failed) — surface it so the
      // agent knows the resize did NOT take, never hide it.
      return { isError: true, content: [{ type: "text", text: `Could not set the sandbox size: ${(e as Error).message}` }] };
    }
    return {
      content: [
        {
          type: "text",
          text:
            "Recorded — your new sandbox size takes effect on the NEXT sandbox restart (it is not applied to the " +
            "running pod right now). Nothing was interrupted.",
        },
      ],
    };
  }
}
