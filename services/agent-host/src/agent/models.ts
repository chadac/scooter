/**
 * Model catalog — the set of models a conversation may run on, each with an
 * optional deployment HINT guiding when to use it (fast/cheap vs slow/powerful).
 * The agent picks its own model via the list_models / switch_model MCP tools;
 * customers steer that choice through the hints in their kubenix config.
 *
 * Source of truth: the AGENT_MODELS_JSON env var, a JSON array rendered by
 * modules/platform.nix from `agent.availableModels.<id> = { enable; hint; default; }`.
 * We derive the flat `default` id + `available` id list from it so resolveModel /
 * GET /models keep working. Backward-compat: a legacy comma-sep
 * AGENT_AVAILABLE_MODELS + GOOSE_MODEL still yields a catalog (no hints).
 */

/** One offered model. */
export interface ModelInfo {
  id: string;
  /** Deployment guidance shown to the agent (list_models). "" = none. */
  hint: string;
  /** The default model — used when a conversation hasn't picked one. Exactly one. */
  default: boolean;
}

export interface ModelCatalog {
  models: ModelInfo[];
  /** The default model id (the one with default:true), or undefined if none. */
  defaultId?: string;
}

/**
 * Build the catalog from the environment. Prefers AGENT_MODELS_JSON (the rich
 * form); falls back to the legacy GOOSE_MODEL + AGENT_AVAILABLE_MODELS.
 */
export function catalogFromEnv(env: NodeJS.ProcessEnv = process.env): ModelCatalog {
  const json = env.AGENT_MODELS_JSON;
  if (json && json.trim()) {
    try {
      const parsed = JSON.parse(json) as Array<{ id?: unknown; hint?: unknown; default?: unknown }>;
      const models: ModelInfo[] = [];
      for (const m of Array.isArray(parsed) ? parsed : []) {
        if (typeof m?.id !== "string" || !m.id) continue;
        models.push({
          id: m.id,
          hint: typeof m.hint === "string" ? m.hint : "",
          default: m.default === true,
        });
      }
      return withDefault(models);
    } catch {
      // fall through to the legacy form
    }
  }
  // Legacy: GOOSE_MODEL is the default; AGENT_AVAILABLE_MODELS the (hint-less) list.
  const legacyDefault = env.GOOSE_MODEL?.trim() || undefined;
  const ids = (env.AGENT_AVAILABLE_MODELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (legacyDefault && !ids.includes(legacyDefault)) ids.unshift(legacyDefault);
  const models: ModelInfo[] = ids.map((id) => ({ id, hint: "", default: id === legacyDefault }));
  return withDefault(models, legacyDefault);
}

/** Ensure exactly one default is marked: honor an explicit default:true, else the
 *  hinted `fallback` id, else the first model. */
function withDefault(models: ModelInfo[], fallback?: string): ModelCatalog {
  if (models.length === 0) return { models: [], defaultId: fallback };
  let def = models.find((m) => m.default);
  if (!def && fallback) def = models.find((m) => m.id === fallback);
  if (!def) def = models[0];
  // Normalize the flags so exactly `def` is the default.
  for (const m of models) m.default = m.id === def.id;
  return { models, defaultId: def.id };
}

/** The offered model ids. */
export function availableIds(cat: ModelCatalog): string[] {
  return cat.models.map((m) => m.id);
}

/**
 * Resolve a requested model against the catalog. Returns the requested model iff
 * it's offered; otherwise the default. Undefined only when the catalog is empty.
 */
export function resolveModel(requested: string | undefined, cat: ModelCatalog): string | undefined {
  if (requested && cat.models.some((m) => m.id === requested)) return requested;
  return cat.defaultId;
}

/** Is `id` an offered model? (switch_model validates with this.) */
export function isOffered(cat: ModelCatalog, id: string): boolean {
  return cat.models.some((m) => m.id === id);
}
