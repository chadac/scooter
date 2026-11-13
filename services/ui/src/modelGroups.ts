/**
 * Group the model catalog by source provider for the two-level picker. GET /models
 * exposes the catalog as `providers: { modelId: [tags] }`, and model ids are
 * provider-specific namespaces, so grouping by provider makes each model's source
 * obvious ("byoc › claude-opus-4-8" vs "goose › us.anthropic…"). The picker's stored
 * value is still the model id, so a model that two providers offer is listed under
 * each; when no model carries a provider tag, grouping is skipped and the caller
 * renders a flat list.
 */

/** A provider group for the picker: a labelled header + the model ids under it. */
export interface ModelGroup {
  /** The provider tag as reported by the catalog ("byoc" | "goose" | "claude-code" | …). */
  provider: string;
  /** Human label for the group header (prettified tag). */
  label: string;
  /** Model ids under this provider, in catalog order. */
  models: string[];
}

// Display labels for provider tags that differ from the tag; unknown tags render verbatim.
const PROVIDER_LABELS: Record<string, string> = {
  byoc: "bring-your-own-claude",
  copilot: "github-copilot",
};

/** Bucket for model ids no named provider offers, so a mixed catalog still lists them. */
export const UNTAGGED_GROUP = "other";

/** Prettify a provider tag for display. */
export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/**
 * Build provider groups from the offered ids and the id→providers map, or `null` when
 * no model carries a provider tag; groups are ordered default model's provider first,
 * then by first appearance in `available`, then the untagged bucket, with models in
 * `available` order.
 */
export function groupModelsByProvider(
  available: string[],
  providers: Record<string, string[]> | undefined,
  defaultModel: string | null,
): ModelGroup[] | null {
  const providersOf = (id: string): string[] => providers?.[id] ?? [];
  const anyTagged = available.some((id) => providersOf(id).length > 0);
  if (!anyTagged) return null;

  // Provider tag -> its model ids, built in `available` order so the provider sequence
  // and the models within each provider stay stable.
  const byProvider = new Map<string, string[]>();
  const order: string[] = [];
  const push = (provider: string, id: string) => {
    let list = byProvider.get(provider);
    if (!list) {
      list = [];
      byProvider.set(provider, list);
      order.push(provider);
    }
    list.push(id);
  };
  for (const id of available) {
    const tags = providersOf(id);
    if (tags.length === 0) push(UNTAGGED_GROUP, id);
    else for (const tag of tags) push(tag, id);
  }

  // Float the default model's provider(s) to the front, using first-appearance ranks
  // captured before the sort.
  const defaultProviders = defaultModel ? providersOf(defaultModel) : [];
  const firstSeen = new Map(order.map((p, i) => [p, i]));
  order.sort((a, b) => {
    const rank = (p: string) =>
      defaultProviders.includes(p) ? 0 : p === UNTAGGED_GROUP ? 2 : 1;
    const d = rank(a) - rank(b);
    return d !== 0 ? d : firstSeen.get(a)! - firstSeen.get(b)!;
  });

  return order.map((provider) => ({
    provider,
    label: provider === UNTAGGED_GROUP ? UNTAGGED_GROUP : providerLabel(provider),
    models: byProvider.get(provider)!,
  }));
}


/** The option label, where exactly one option is "(default)". */
export function modelOptionLabel(
  id: string,
  provider: string | undefined,
  opts: {
    defaultFor?: Record<string, string[]>;
    globalDefault?: string | null;
    /** The group that carries the label; the provider that would serve the run. */
    defaultProvider?: string;
  },
): string {
  if (id !== opts.globalDefault) return `${id}`;
  // The default model appears under each group; only one carries the label.
  if (provider && opts.defaultProvider && provider !== opts.defaultProvider) return id;
  return `${id} (default)`;
}

/** Provider-qualified value, so a pick identifies both. */
export function modelOptionValue(id: string, provider: string | undefined): string {
  return provider ? `${provider}:${id}` : id;
}

/** Resolution order for an unqualified pick: BYOC outranks the cloud. */
const PROVIDER_PRIORITY = ["byoc", "claude-code"] as const;

export function defaultServingProvider(catalog: {
  default?: string | null;
  defaultFor?: Record<string, string[]>;
  defaultProvider?: string | null;
}): string | undefined {
  // The server's answer wins; it knows whether the caller's BYOC is connected.
  if (catalog.defaultProvider) return catalog.defaultProvider;
  const forDefault = catalog.default ? (catalog.defaultFor?.[catalog.default] ?? []) : [];
  return PROVIDER_PRIORITY.find((p) => forDefault.includes(p)) ?? forDefault[0];
}
