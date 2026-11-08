/**
 * The show_sandbox_resources / set_sandbox_resources MCP tools, which let the agent
 * see and right-size its own sandbox. These are pure handlers registered by
 * mcpServer.ts; validation lives here, and the wiring's setResources writes the
 * broker size spec, which the broker applies on the next sandbox restart.
 */

import type { ToolResult } from "./mcpServer.js";
import { validateResources, InvalidResourceError, type SandboxResources } from "../session/resources.js";
import type { SandboxSizePreset } from "../session/resources.js";
import type { PendingRestart, SandboxRestartResult } from "../session/manager.js";
import { formatError, logger } from "../log.js";

const log = logger("resourceTools");

/** What the resource tools need from the agent-host. */
export interface SandboxResourceToolsWiring {
  /** This conversation's stored size spec from the broker, `{}` when nothing is stored. */
  currentResources(conversationId: string): SandboxResources | Promise<SandboxResources>;
  /** Write a preset name or raw resources to the broker, which applies it on the next sandbox restart; rejects if the write fails. */
  setResources(conversationId: string, resources: SandboxResources | { size: string }): Promise<boolean>;
  /** The named sandbox size presets and the default preset name, from the broker. */
  availableSizes?(): Promise<{ sizes: Record<string, SandboxSizePreset>; default: string | null }>;
  /** Restarts onto the current image and size; enables restart_sandbox. */
  restartSandbox?(conversationId: string): Promise<SandboxRestartResult>;
  /** Stops the pod, keeping the turn alive; enables stop_sandbox. */
  stopSandbox?(conversationId: string): Promise<{ deferred: boolean; pending?: PendingRestart }>;
}

/** The set_sandbox_resources tool input, either a preset name (size) or flat raw resources where an omitted dimension keeps its current value. */
export interface SetSandboxResourcesArgs {
  size?: string;
  requestCpu?: string;
  requestMemory?: string;
  requestGpu?: number;
  limitCpu?: string;
  limitMemory?: string;
  limitGpu?: number;
}

/** Render one side of a resources block as "cpu=…, memory=…, gpu=…", or "(default)" when nothing is set. */
function sideLine(q: { cpu?: string; memory?: string; gpu?: number } | undefined): string {
  const parts = [
    q?.cpu !== undefined ? `cpu=${q.cpu}` : null,
    q?.memory !== undefined ? `memory=${q.memory}` : null,
    q?.gpu !== undefined ? `gpu=${q.gpu}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "(default)";
}

/** Fold the flat tool args into the nested SandboxResources shape, dropping sides with nothing set. */
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

/** show_sandbox_resources: render the conversation's stored broker size spec. */
export async function handleShowSandboxResources(
  deps: SandboxResourceToolsWiring,
  conversationId: string,
): Promise<ToolResult> {
  const r = await deps.currentResources(conversationId);
  // The preset table is per-deployment, so list the valid names; a failure to read them is non-fatal.
  let presetLines = "";
  if (deps.availableSizes) {
    try {
      const { sizes, default: defaultName } = await deps.availableSizes();
      const names = Object.keys(sizes);
      if (names.length > 0) {
        presetLines =
          "\nAvailable size presets (pass one as set_sandbox_resources(size=...)):\n" +
          names
            .map((n) => {
              const p = sizes[n];
              const gpu = p.gpu ? `, ${p.gpu} GPU` : "";
              const isDefault = n === defaultName ? "  (default)" : "";
              // The deployment's hint is carried through verbatim.
              const hint = p.hint ? ` — ${p.hint}` : "";
              return `- ${n}: ${p.cpu} CPU, ${p.memory}${gpu}${isDefault}${hint}`;
            })
            .join("\n");
      }
    } catch (e) {
      log.warn("could not list size presets", { error: formatError(e) });
    }
  }
  return {
    content: [
      {
        type: "text",
        text:
          "Your sandbox resources:\n" +
          `- requests: ${sideLine(r.requests)}\n` +
          `- limits: ${sideLine(r.limits)}\n` +
          presetLines +
          "\nChange them with set_sandbox_resources (applies on the next sandbox restart" +
            (deps.restartSandbox ? "; call restart_sandbox to apply it now)." : ")."),
      },
    ],
  };
}

/** set_sandbox_resources: validate a preset name or raw resources, then write the broker size spec, returning isError with the exact issue on a bad input. */
export async function handleSetSandboxResources(
  deps: SandboxResourceToolsWiring,
  conversationId: string,
  args: SetSandboxResourcesArgs,
): Promise<ToolResult> {
  if (args.size) {
    // Validate the preset exists when available sizes can be queried.
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
        // Let the broker reject it rather than block the write.
        log.warn("could not query available sizes; skipping preset validation", { error: formatError(e) });
      }
    }
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
            "running pod right now). Nothing was interrupted." + applyNowHint(deps),
        },
      ],
    };
  } else {
    // Raw-resources path: validate, then fold the flat args into the nested shape.
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
      // Surface a failed broker write so the agent knows the resize did not take.
      return { isError: true, content: [{ type: "text", text: `Could not set the sandbox size: ${(e as Error).message}` }] };
    }
    return {
      content: [
        {
          type: "text",
          text:
            "Recorded — your new sandbox size takes effect on the NEXT sandbox restart (it is not applied to the " +
            "running pod right now). Nothing was interrupted." + applyNowHint(deps),
        },
      ],
    };
  }
}

/** Hint appended to set_sandbox_resources when restart is available. */
function applyNowHint(deps: SandboxResourceToolsWiring): string {
  return deps.restartSandbox
    ? " To apply it now, save your work and call restart_sandbox (running processes, background jobs and web services stop)."
    : "";
}

/** Describes pending restart changes; empty when none. */
function pendingLine(p: PendingRestart | undefined): string {
  if (!p) return "";
  const parts = [
    p.image ? `a newer sandbox image (${p.image.from} -> ${p.image.to})` : null,
    p.size ? "your recorded size change" : null,
    p.env ? "refreshed environment settings" : null,
    p.template?.length ? `platform sandbox changes (${p.template.join(", ")})` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "";
}

/** restart_sandbox: cycle the pod and wait for it. */
export async function handleRestartSandbox(deps: SandboxResourceToolsWiring, conversationId: string): Promise<ToolResult> {
  if (!deps.restartSandbox) return { isError: true, content: [{ type: "text", text: "Sandbox restart is not available here." }] };
  let r: SandboxRestartResult;
  try {
    r = await deps.restartSandbox(conversationId);
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `Could not restart the sandbox: ${(e as Error).message}` }] };
  }
  const lines = [
    r.ready
      ? "Sandbox restarted and ready."
      : "Sandbox restart issued, but the new pod was not Ready before the wait gave up; your next command will wait for it." +
        (r.notReadyReason ? ` Pod state: ${r.notReadyReason}.` : ""),
    `from_image: ${r.fromImage ?? "(unknown)"}`,
    `to_image: ${r.toImage ?? "(unknown)"}`,
    `size_applied: ${r.sizeApplied}`,
  ];
  if (!r.imageCurrent) lines.push("The image update failed; the sandbox is still on its old image. You can try restart_sandbox again later.");
  lines.push("/workspace, installed modules and /nix/store persist; restart any background jobs or web services you need.");
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

/** stop_sandbox: stop the pod; the next sandbox call restarts it. */
export async function handleStopSandbox(deps: SandboxResourceToolsWiring, conversationId: string): Promise<ToolResult> {
  if (!deps.stopSandbox) return { isError: true, content: [{ type: "text", text: "Stopping the sandbox is not available here." }] };
  let r: { deferred: boolean; pending?: PendingRestart };
  try {
    r = await deps.stopSandbox(conversationId);
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `Could not stop the sandbox: ${(e as Error).message}` }] };
  }
  const pending = pendingLine(r.pending);
  const lines = [
    "Sandbox stopped. Its capacity is freed; /workspace persists.",
    "Any sandbox tool call (bash, read, …) starts it again, which costs one pod boot, so make this your last action.",
  ];
  lines.push(pending ? `pending_restart: ${pending} — applies when the sandbox next starts.` : "pending_restart: none");
  return { content: [{ type: "text", text: lines.join("\n") }] };
}
