import { describe, it, expect } from "vitest";
import {
  braveProvider,
  kagiProvider,
  providerFromEnv,
  formatHits,
  type SearchHit,
} from "../../src/agent/searchProviders.js";

/** A fetch stub that records the request and replays a canned response. */
function stubFetch(body: unknown, init?: { status?: number; raw?: string }) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (url: string | URL, opts?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (opts?.headers ?? {}) as Record<string, string>,
    });
    const status = init?.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => init?.raw ?? JSON.stringify(body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("searchProviders: brave", () => {
  it("hits the web/search endpoint with the subscription token and maps results", async () => {
    const { impl, calls } = stubFetch({
      web: {
        results: [
          { title: "Kagi Search API", url: "https://kagi.com/api", description: "docs" },
          { title: "Other", url: "https://example.com" },
        ],
      },
    });
    const hits = await braveProvider("KEY123").search("kagi api", impl);

    expect(calls[0].url).toContain("api.search.brave.com/res/v1/web/search");
    expect(calls[0].url).toContain("q=kagi%20api");
    // The key travels in the header, never the query string (it would land in logs).
    expect(calls[0].headers["X-Subscription-Token"]).toBe("KEY123");
    expect(calls[0].url).not.toContain("KEY123");

    expect(hits).toEqual<SearchHit[]>([
      { title: "Kagi Search API", url: "https://kagi.com/api", snippet: "docs" },
      { title: "Other", url: "https://example.com", snippet: undefined },
    ]);
  });

  it("throws with the VERBATIM upstream body on a non-2xx (never hide an error)", async () => {
    const { impl } = stubFetch({}, { status: 422, raw: "SUBSCRIPTION_TOKEN_INVALID" });
    await expect(braveProvider("bad").search("q", impl)).rejects.toThrow(
      /422.*SUBSCRIPTION_TOKEN_INVALID/s,
    );
  });
});

describe("searchProviders: kagi", () => {
  it("sends the Bot authorization header and keeps only result rows (t === 0)", async () => {
    const { impl, calls } = stubFetch({
      data: [
        { t: 0, title: "Result", url: "https://a.test", snippet: "snip" },
        { t: 1, list: ["related search", "another"] }, // related-searches row, not a result
      ],
    });
    const hits = await kagiProvider("TOK").search("q", impl);

    expect(calls[0].url).toContain("kagi.com/api/v1/search");
    expect(calls[0].headers["Authorization"]).toBe("Bot TOK");
    expect(hits).toEqual<SearchHit[]>([
      { title: "Result", url: "https://a.test", snippet: "snip" },
    ]);
  });
});

describe("searchProviders: providerFromEnv", () => {
  it("defaults to brave when a brave key is present", () => {
    const p = providerFromEnv({ BRAVE_SEARCH_API_KEY: "k" });
    expect(p?.name).toBe("brave");
  });

  it("selects kagi when SEARCH_PROVIDER says so", () => {
    const p = providerFromEnv({ SEARCH_PROVIDER: "kagi", KAGI_API_KEY: "k" });
    expect(p?.name).toBe("kagi");
  });

  it("is undefined when no key is configured — so web_search can say so plainly", () => {
    expect(providerFromEnv({})).toBeUndefined();
  });

  it("is undefined when the selected provider's key is missing, even if ANOTHER key is set", () => {
    // Guards the silent-wrong-provider trap: asking for kagi with only a brave key
    // must NOT quietly search brave.
    expect(providerFromEnv({ SEARCH_PROVIDER: "kagi", BRAVE_SEARCH_API_KEY: "k" })).toBeUndefined();
  });

  it("treats SEARCH_PROVIDER=none as deliberately off", () => {
    expect(providerFromEnv({ SEARCH_PROVIDER: "none", BRAVE_SEARCH_API_KEY: "k" })).toBeUndefined();
  });
});

describe("searchProviders: formatHits", () => {
  it("renders title, url and snippet on one line per hit", () => {
    const out = formatHits([{ title: "T", url: "https://u.test", snippet: "S" }], "q");
    expect(out).toContain("T");
    expect(out).toContain("https://u.test");
    expect(out).toContain("S");
  });
});
