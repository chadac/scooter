/**
 * Group the model catalog by SOURCE PROVIDER for the two-level picker.
 *
 * The catalog is provider-first upstream (kubenix `availableModels.<provider>.<id>`)
 * and GET /models exposes it as `providers: { modelId: [tags] }`. Model ids are
 * provider-specific namespaces — a Bedrock id ("us.anthropic.…") means nothing to a
 * subscription-backed provider and vice-versa — so grouping by provider makes the
 * source of each model obvious ("byoc › claude-opus-4-8" vs "goose › us.anthropic…").
 *
 * The picker's stored value is still the model id (unchanged contract): a model that
 * two providers offer is simply listed under each. When NO model carries a provider
 * tag (legacy AGENT_AVAILABLE_MODELS deployments), grouping is skipped and the caller
 * renders a flat list exactly as before.
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

// Friendly labels for provider tags whose display name differs from the tag.
// "byoc" -> "bring-your-own-claude" (spell out the acronym). goose is left
// verbatim: it's multi-use and not tied to one model source, so it keeps its
// own name. Add an entry here only when a tag needs prettifying; unknown tags
// render verbatim.
const PROVIDER_LABELS: Record<string, string> = {
  byoc: "bring-your-own-claude",
};

/** Model ids offered by NO named provider ([] or absent) are bucketed here so a
 *  mixed catalog (some tagged, some universal) still lists them. */
export const UNTAGGED_GROUP = "other";

/** Prettify a provider tag for display. */
export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/**
 * Build provider groups from the offered ids + the id→providers map.
 *
 * Returns `null` when grouping adds nothing — i.e. no model carries a provider tag —
 * so the caller keeps the flat list. Otherwise returns groups ordered with the
 * DEFAULT model's provider first, then remaining providers by first appearance in
 * `available`, then the untagged bucket last. Model order within a group follows
 * `available`.
 */
export function groupModelsByProvider(
  available: string[],
  providers: Record<string, string[]> | undefined,
  defaultModel: string | null,
): ModelGroup[] | null {
  const providersOf = (id: string): string[] => providers?.[id] ?? [];
  const anyTagged = available.some((id) => providersOf(id).length > 0);
  if (!anyTagged) return null;

  // Provider tag -> its model ids, built in `available` order so both the provider
  // sequence (first appearance) and the models within each provider stay stable.
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

  // Float the default model's provider(s) to the front so the default group leads.
  // Capture first-appearance ranks BEFORE sorting (indexOf on the array being sorted
  // is unreliable mid-sort).
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
