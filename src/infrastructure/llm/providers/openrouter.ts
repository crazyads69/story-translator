import { ProviderError } from "../../../domain/common/errors";
import { joinUrl } from "../util/url";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  LlmClient,
} from "../types";

type OpenRouterErrorResponse = {
  error: { code?: number | string; message: string; metadata?: unknown };
};

type OpenRouterChatCompletionResponse = {
  model: string;
  choices: Array<{
    message?: { role: string; content?: string | null };
    delta?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { code?: number | string; message: string; metadata?: unknown };
};

export type OpenRouterClientConfig = {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  httpReferer?: string;
  title?: string;
};

type OpenRouterChatCompletionBody = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  response_format?: { type: "json_object" };
  seed?: number;
  include_reasoning?: boolean;
};

export class OpenRouterClient implements LlmClient {
  readonly provider = "openrouter" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly httpReferer?: string;
  private readonly title?: string;

  constructor(config: OpenRouterClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.timeoutMs = config.timeoutMs;
    this.httpReferer = config.httpReferer;
    this.title = config.title;
  }

  async chatComplete(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const url = joinUrl(this.baseUrl, "/chat/completions");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const body: OpenRouterChatCompletionBody = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      top_p: request.topP,
      max_tokens: request.maxTokens,
      stream: request.stream ?? false,
      seed: request.seed,
      response_format:
        request.responseFormat === "json_object"
          ? { type: "json_object" }
          : undefined,
      include_reasoning: request.includeReasoning,
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...(this.httpReferer ? { "HTTP-Referer": this.httpReferer } : {}),
          ...(this.title ? { "X-Title": this.title } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const json = (await res.json()) as
        | OpenRouterChatCompletionResponse
        | OpenRouterErrorResponse;

      const bodyError =
        "error" in json && json.error
          ? { message: json.error.message, code: json.error.code }
          : undefined;

      if (!res.ok) {
        throw new ProviderError({
          provider: "openrouter",
          statusCode: res.status,
          retryable: res.status === 429 || res.status >= 500,
          message:
            bodyError?.message ?? `OpenRouter request failed (${res.status})`,
          cause: json,
        });
      }

      if (bodyError) {
        throw new ProviderError({
          provider: "openrouter",
          retryable: true,
          message: bodyError.message,
          cause: json,
        });
      }

      const completion = json as OpenRouterChatCompletionResponse;
      const content =
        completion.choices?.[0]?.message?.content ??
        completion.choices?.[0]?.delta?.content ??
        "";

      return {
        provider: "openrouter",
        model: completion.model ?? request.model,
        content: content ?? "",
        usage: completion.usage
          ? {
              promptTokens: completion.usage.prompt_tokens,
              completionTokens: completion.usage.completion_tokens,
              totalTokens: completion.usage.total_tokens,
            }
          : undefined,
        raw: completion,
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError({
        provider: "openrouter",
        retryable: true,
        message: "OpenRouter request failed",
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async *chatCompleteStream(
    request: ChatCompletionRequest,
  ): AsyncGenerator<string, void, void> {
    const url = joinUrl(this.baseUrl, "/chat/completions");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const body: OpenRouterChatCompletionBody = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      top_p: request.topP,
      max_tokens: request.maxTokens,
      stream: true,
      seed: request.seed,
      response_format:
        request.responseFormat === "json_object"
          ? { type: "json_object" }
          : undefined,
      include_reasoning: request.includeReasoning,
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(this.httpReferer ? { "HTTP-Referer": this.httpReferer } : {}),
          ...(this.title ? { "X-Title": this.title } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new ProviderError({
          provider: "openrouter",
          statusCode: res.status,
          retryable: res.status === 429 || res.status >= 500,
          message: `OpenRouter stream failed (${res.status})`,
          cause: text,
        });
      }
      if (!res.body) return;
      const { parseSse } = await import("../stream/sse");
      for await (const data of parseSse(res.body)) {
        yield data;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
