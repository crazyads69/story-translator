import { ProviderError } from "../../domain/common/errors";
import { withRetry } from "../llm/retry/retry";
import { safeFetchText, type FetchLike } from "../http/safe-fetch";

export type BraveSearchConfig = {
  apiKey: string;
  baseUrl: string;
  country: string;
  searchLang: string;
  count: number;
  extraSnippets: boolean;
  timeoutMs: number;
  maxRetries: number;
  fetchImpl?: FetchLike;
};

export type BraveWebResult = {
  title: string;
  url: string;
  description?: string;
  extraSnippets?: string[];
};

type BraveWebSearchResponse = {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      extra_snippets?: string[];
    }>;
  };
};

/**
 * Minimal Brave Web Search client for ingestion enrichment.
 *
 * Docs:
 * - Web endpoint: https://api.search.brave.com/res/v1/web/search
 * - Auth header: X-Subscription-Token
 */
export class BraveSearchClient {
  private readonly config: BraveSearchConfig;

  constructor(config: BraveSearchConfig) {
    this.config = config;
  }

  async webSearch(query: string, options?: { count?: number; searchLang?: string }): Promise<BraveWebResult[]> {
    const params = new URLSearchParams({
      q: query,
      count: String(options?.count ?? this.config.count),
      country: this.config.country,
      search_lang: options?.searchLang ?? this.config.searchLang,
      extra_snippets: String(this.config.extraSnippets),
    });
    
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/web/search?${params.toString()}`;

    const run = async () => {
      const res = await safeFetchText({
        url,
        timeoutMs: this.config.timeoutMs,
        maxBytes: 2_000_000,
        headers: { "X-Subscription-Token": this.config.apiKey },
        accept: "application/json",
        fetchImpl: this.config.fetchImpl,
      });
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError({
          provider: "brave",
          statusCode: res.status,
          retryable: false,
          message: "Brave Search authentication failed",
        });
      }
      if (res.status === 429 || res.status >= 500) {
        throw new ProviderError({
          provider: "brave",
          statusCode: res.status,
          retryable: true,
          message: `Brave Search failed (${res.status})`,
          cause: res.text,
        });
      }
      if (res.status < 200 || res.status >= 300) {
        throw new ProviderError({
          provider: "brave",
          statusCode: res.status,
          retryable: false,
          message: `Brave Search failed (${res.status})`,
          cause: res.text,
        });
      }

      const json = JSON.parse(res.text) as BraveWebSearchResponse;
      const results = json.web?.results ?? [];
      return results
        .map((r) => ({
          title: r.title ?? "",
          url: r.url ?? "",
          description: r.description,
          extraSnippets: r.extra_snippets,
        }))
        .filter((r) => r.title.length > 0 && r.url.length > 0);
    };

    return withRetry(run, {
      maxRetries: this.config.maxRetries,
      backoff: { baseMs: 300, maxMs: 10_000, jitter: 0.2 },
    });
  }
}
