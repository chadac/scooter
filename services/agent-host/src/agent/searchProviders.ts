/**
 * Web-search providers for the `web_search` agent tool.
 *
 * Why a seam instead of one hardcoded call: `web_search` previously hit
 * DuckDuckGo's Instant Answer API, which is NOT a web index — it serves
 * definitions and disambiguation stubs, so almost every agent query came back
 * "No instant answer". DDG publishes no results API, so the provider has to be a
 * keyed one. Which keyed one is a deployment decision (price vs. result quality),
 * so it is config (`SEARCH_PROVIDER`) rather than code.
 *
 * The key lives ONLY in the agent-host process, which is where the outbound call
 * already came from — the sandbox and the agent never see it.
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

/**
 * Brave Search. $5/1k requests with $5 of credit granted monthly, so typical
 * single-user volume lands free. Independent index, 50 qps.
 *
 * Uses /res/v1/web/search (plain ranked results). Brave also offers
 * /res/v1/llm/context, which returns pre-chunked grounding snippets; it costs the
 * same and would give richer context, but its nested response shape is a larger
 * mapping job — worth revisiting if snippet quality proves thin.
 */
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
 * Kagi Search. $12/1k requests, no free tier, and the key requires a paid Kagi
 * account — 2.4x Brave's price, bought for result quality an LLM largely reranks
 * away. Offered because that tradeoff is a deployment's call, not ours.
 *
 * Response rows are typed: `t: 0` is a search result, `t: 1` is a related-searches
 * row carrying a `list` and no url. Filtering on `t === 0` keeps the latter from
 * rendering as a bogus hit.
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
 * Returning `undefined` rather than a silent fallback is deliberate: a deployment
 * that asked for kagi but supplied no kagi key must NOT quietly search brave — it
 * would bill the wrong account and obscure the misconfiguration. `web_search` then
 * reports plainly that it is unconfigured.
 *
 * Mirrors the `catalogFromEnv` convention in models.ts (env in, value out).
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
