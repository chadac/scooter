/**
 * The list_models / switch_model MCP tools — let the agent see the offered models
 * (with deployment hints) and switch its OWN model mid-conversation. Customers ship
 * an intro skill telling the agent to opportunistically pick the fast/cheap model
 * for simple work and escalate to the powerful one for complex planning/debugging.
 *
 * Pure handlers (no MCP/HTTP plumbing) for unit testing; mcpServer.ts registers
 * them. Validation lives HERE (switch_model rejects an unoffered model + returns
 * the valid list); the manager's switchModelNow does the mechanism (cancel the
 * running turn -> rebuild goose with the new model -> continue).
 */

import type { ModelCatalog } from "./models.js";
import { isOffered } from "./models.js";
import type { ToolResult } from "./mcpServer.js";

/** What the model tools need from the agent-host. */
export interface ModelToolsWiring {
  /** The offered models (ids + hints + default). */
  catalog: ModelCatalog;
  /** This conversation's current model (undefined = the default). */
  currentModel(conversationId: string): string | undefined;
  /** Switch this conversation's model NOW and continue on it (manager.switchModelNow).
   *  Resolves to whether a switch happened (false = already on that model). */
  switchModel(conversationId: string, model: string): Promise<boolean>;
}

function modelLine(id: string, hint: string, current: boolean, isDefault: boolean): string {
  const tags = [current ? "current" : null, isDefault ? "default" : null].filter(Boolean).join(", ");
  const suffix = tags ? `  [${tags}]` : "";
  const h = hint ? ` — ${hint}` : "";
  return `- ${id}${suffix}${h}`;
}

/** list_models: show the offered models, which is current/default, and each hint. */
export function handleListModels(deps: ModelToolsWiring, conversationId: string): ToolResult {
  const { catalog } = deps;
  if (catalog.models.length === 0) {
    return { content: [{ type: "text", text: "No models are configured for selection." }] };
  }
  const current = deps.currentModel(conversationId) ?? catalog.defaultId;
  const lines = catalog.models.map((m) =>
    modelLine(m.id, m.hint, m.id === current, m.default),
  );
  return {
    content: [
      {
        type: "text",
        text:
          "Available models (switch with switch_model). Pick the fast/cheap model for simple work; " +
          "escalate to a more powerful one for complex planning, research, or hard debugging:\n" +
          lines.join("\n"),
      },
    ],
  };
}

/** switch_model: validate + switch this conversation's model immediately. */
export async function handleSwitchModel(
  deps: ModelToolsWiring,
  conversationId: string,
  args: { model: string },
): Promise<ToolResult> {
  const model = (args.model ?? "").trim();
  const ids = deps.catalog.models.map((m) => m.id);
  if (!model) {
    return { isError: true, content: [{ type: "text", text: `model is required. Available: ${ids.join(", ") || "(none)"}` }] };
  }
  if (!isOffered(deps.catalog, model)) {
    return {
      isError: true,
      content: [{ type: "text", text: `"${model}" is not an available model. Choose one of: ${ids.join(", ") || "(none)"}` }],
    };
  }
  const switched = await deps.switchModel(conversationId, model);
  if (!switched) {
    return { content: [{ type: "text", text: `Already on ${model} — no change.` }] };
  }
  return {
    content: [
      {
        type: "text",
        text:
          `Switched to ${model}. The previous turn was ended to apply the change; I'll continue on the ` +
          `new model — no need to repeat anything.`,
      },
    ],
  };
}
