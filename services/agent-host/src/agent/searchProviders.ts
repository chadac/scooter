/**
 * Web-search providers for the `web_search` agent tool.
 *
 * The key must stay in the agent-host process — never passed to the sandbox or
 * the model. Provider choice is config, not code. Why: PR #698.
 */

/** One search result, normalized across providers. */
export interface SearchHit {
  title: string;
  url: string;
  snippet?: string;
}

export interface SearchProvider {
  /** Stable id, matching the `SEARCH_PROVIDER` value that selects it. */
  readonly name: string;
  /** Run a query. MUST throw (not return empty) when the upstream call fails, so
   *  `web_search` can echo the real status + body instead of reporting "no results"
   *  for what was actually an auth or quota error. */
  search(query: string, doFetch: typeof fetch): Promise<SearchHit[]>;
}

const TIMEOUT_MS = 15_000;
const MAX_RESULTS = 10;

/** Throw carrying the verbatim upstream status + body — the repo's "never hide an
 *  error" rule. A 401/422 from a bad key must not read as an empty result set. */
async function failVerbatim(provider: string, res: Response): Promise<never> {
  const body = await res.text().catch(() => "(unreadable body)");
  throw new Error(`${provider} search FAILED (HTTP ${res.status}): ${body}`);
}

/** Brave Search, the default provider. Uses /res/v1/web/search; the same-priced
 *  /res/v1/llm/context would give richer snippets. Why: PR #698. */
export function braveProvider(apiKey: string): SearchProvider {
  return {
    name: "brave",
    async search(query, doFetch) {
      const url =
        `https://api.search.brave.com/res/v1/web/search` +
        `?q=${encodeURIComponent(query)}&count=${MAX_RESULTS}`;
      const res = await doFetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          Accept: "application/json",
          // Header, never a query param: a key in the URL leaks into access logs.
          "X-Subscription-Token": apiKey,
        },
      });
      if (!res.ok) await failVerbatim("brave", res);
      const data = (await res.json().catch(() => ({}))) as {
        web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
      };
      return (data.web?.results ?? [])
        .filter((r) => r.url)
        .slice(0, MAX_RESULTS)
        .map((r) => ({
          title: r.title ?? r.url!,
          url: r.url!,
          snippet: r.description,
        }));
    },
  };
}

/**
 * Kagi Search. Costlier than brave with no free tier (PR #698).
 *
 * Rows are typed: `t: 0` is a result, `t: 1` is a related-searches row carrying a
 * `list` and no url. The `t === 0` filter is load-bearing — without it the
 * related-searches row renders as a bogus hit.
 */
export function kagiProvider(apiKey: string): SearchProvider {
  return {
    name: "kagi",
    async search(query, doFetch) {
      const url =
        `https://kagi.com/api/v1/search` +
        `?q=${encodeURIComponent(query)}&limit=${MAX_RESULTS}`;
      const res = await doFetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Authorization: `Bot ${apiKey}` },
      });
      if (!res.ok) await failVerbatim("kagi", res);
      const data = (await res.json().catch(() => ({}))) as {
        data?: Array<{ t?: number; title?: string; url?: string; snippet?: string }>;
      };
      return (data.data ?? [])
        .filter((r) => r.t === 0 && r.url)
        .slice(0, MAX_RESULTS)
        .map((r) => ({
          title: r.title ?? r.url!,
          url: r.url!,
          snippet: r.snippet,
        }));
    },
  };
}

/**
 * Resolve the configured provider, or `undefined` when search is not set up.
 *
 * Do NOT add a fallback to whichever key happens to be set: a deployment that asked
 * for kagi must not silently search brave (wrong account billed, misconfiguration
 * hidden). Why: PR #698.
 */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): SearchProvider | undefined {
  const brave = env.BRAVE_SEARCH_API_KEY?.trim();
  const kagi = env.KAGI_API_KEY?.trim();
  // Default to brave: it is the only provider with a free monthly allowance, so an
  // operator who sets just a key gets a working search without also setting a knob.
  const choice = (env.SEARCH_PROVIDER?.trim() || "brave").toLowerCase();

  switch (choice) {
    case "none":
      return undefined;
    case "brave":
      return brave ? braveProvider(brave) : undefined;
    case "kagi":
      return kagi ? kagiProvider(kagi) : undefined;
    default:
      return undefined;
  }
}

/** Render hits as the agent-facing text block: one `- title (url)` per line with an
 *  indented snippet, so a model can pick a url to hand to `web_fetch`. */
export function formatHits(hits: SearchHit[], query: string): string {
  const lines = [`Results for "${query}":`];
  for (const h of hits) {
    lines.push(`- ${h.title} (${h.url})`);
    if (h.snippet) lines.push(`  ${h.snippet}`);
  }
  return lines.join("\n");
}
