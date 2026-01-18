import { ProviderError } from "../../domain/common/errors";
import { joinUrl } from "../llm/util/url";

type OpenAIEmbeddingResponse = {
  data: Array<{ embedding: number[] | string }>;
  model?: string;
};

export type OpenRouterEmbeddingsConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
};

export class OpenRouterEmbeddings {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, number[]>();

  constructor(config: OpenRouterEmbeddingsConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const input = texts.map((t) => t.slice(0, 8000));
    const result: Array<number[] | undefined> = new Array(input.length);
    const misses: string[] = [];
    const missIndexes: number[] = [];
    for (let i = 0; i < input.length; i++) {
      const key = input[i]!;
      const cached = this.cache.get(key);
      if (cached) {
        result[i] = cached;
      } else {
        misses.push(key);
        missIndexes.push(i);
      }
    }

    if (misses.length === 0) {
      return result as number[][];
    }

    const url = joinUrl(this.baseUrl, "/embeddings");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: this.model, input: misses }),
        signal: controller.signal,
      });
      const json = (await res.json()) as OpenAIEmbeddingResponse & {
        error?: { message?: string };
      };
      if (!res.ok) {
        throw new ProviderError({
          provider: "openrouter",
          statusCode: res.status,
          retryable: res.status === 429 || res.status >= 500,
          message: json?.error?.message ?? `OpenRouter embeddings failed (${res.status})`,
          cause: json,
        });
      }
      const vectors = json.data?.map((d) => d.embedding);
      if (!vectors || vectors.length !== misses.length) {
        throw new ProviderError({
          provider: "openrouter",
          retryable: false,
          message: "OpenRouter embeddings response is missing data",
          cause: json,
        });
      }
      for (let i = 0; i < vectors.length; i++) {
        const v = vectors[i]!;
        if (typeof v === "string") {
          throw new ProviderError({
            provider: "openrouter",
            retryable: false,
            message: "Base64 embeddings are not supported",
          });
        }
        const idx = missIndexes[i]!;
        result[idx] = v;
        this.cache.set(misses[i]!, v);
      }
      return result as number[][];
    } finally {
      clearTimeout(timeout);
    }
  }
}
