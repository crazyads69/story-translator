import { ProviderError } from "../../domain/common/errors";
import { withRetry } from "../llm/retry/retry";
import { safeFetchText, type FetchLike } from "../http/safe-fetch";
import { joinUrl } from "../llm/util/url";

export type JinaRerankConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  fetchImpl?: FetchLike;
};

export type JinaRerankResult = {
  index: number;
  score: number;
};

type JinaRerankResponse = {
  results?: Array<{ index: number; score: number }>;
};

/**
 * Jina Reranker API client.
 *
 * Endpoint:
 * - POST https://api.jina.ai/v1/rerank
 *
 * Example (from Jina model card / docs):
 * - model: "jina-reranker-v2-base-multilingual"
 * - query: string
 * - documents: string[]
 * - top_n: number
 */
export class JinaRerankerClient {
  private readonly config: JinaRerankConfig;

  constructor(config: JinaRerankConfig) {
    this.config = config;
  }

  async rerank(params: {
    query: string;
    documents: string[];
    topN: number;
  }): Promise<JinaRerankResult[]> {
    const url = joinUrl(this.config.baseUrl, "/rerank");
    const run = async () => {
      const res = await safeFetchText({
        url,
        method: "POST",
        timeoutMs: this.config.timeoutMs,
        maxBytes: 2_000_000,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        accept: "application/json",
        fetchImpl: this.config.fetchImpl,
        body: JSON.stringify({
          model: this.config.model,
          query: params.query,
          documents: params.documents,
          top_n: params.topN,
        }),
      });
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError({
          provider: "jina",
          statusCode: res.status,
          retryable: false,
          message: "Jina reranker authentication failed",
        });
      }
      if (res.status === 429 || res.status >= 500) {
        throw new ProviderError({
          provider: "jina",
          statusCode: res.status,
          retryable: true,
          message: `Jina rerank failed (${res.status})`,
          cause: res.text,
        });
      }
      if (res.status < 200 || res.status >= 300) {
        throw new ProviderError({
          provider: "jina",
          statusCode: res.status,
          retryable: false,
          message: `Jina rerank failed (${res.status})`,
          cause: res.text,
        });
      }
      const json = JSON.parse(res.text) as JinaRerankResponse;
      return (json.results ?? []).map((r) => ({
        index: r.index,
        score: r.score,
      }));
    };

    return withRetry(run, {
      maxRetries: this.config.maxRetries,
      backoff: { baseMs: 300, maxMs: 10_000, jitter: 0.2 },
    });
  }
}
