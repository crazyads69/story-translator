import { ProviderError } from "../../../domain/common/errors";
import { joinUrl } from "../util/url";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  LlmClient,
} from "../types";

type DeepSeekChatCompletionBody = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  response_format?: { type: "text" | "json_object" };
  thinking?: { type: "enabled" | "disabled" };
  seed?: number;
};

type DeepSeekChatCompletionResponse = {
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
  error?: { message?: string; code?: number | string };
};

export type DeepSeekClientConfig = {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
};

export class DeepSeekClient implements LlmClient {
  readonly provider = "deepseek" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: DeepSeekClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.timeoutMs = config.timeoutMs;
  }

  async chatComplete(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const url = joinUrl(this.baseUrl, "/chat/completions");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const body: DeepSeekChatCompletionBody = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      top_p: request.topP,
      max_tokens: request.maxTokens,
      stream: request.stream ?? false,
      response_format: request.responseFormat
        ? { type: request.responseFormat }
        : undefined,
      seed: request.seed,
      thinking:
        request.model === "deepseek-reasoner"
          ? { type: "enabled" }
          : { type: "disabled" },
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const json = (await res.json()) as DeepSeekChatCompletionResponse;
      if (!res.ok) {
        throw new ProviderError({
          provider: "deepseek",
          statusCode: res.status,
          retryable: res.status === 429 || res.status >= 500,
          message: json?.error?.message ?? `DeepSeek request failed (${res.status})`,
          cause: json,
        });
      }
      if (json.error) {
        throw new ProviderError({
          provider: "deepseek",
          retryable: true,
          message: json.error.message ?? "DeepSeek returned an error",
          cause: json,
        });
      }
      const content =
        json.choices?.[0]?.message?.content ??
        json.choices?.[0]?.delta?.content ??
        "";
      return {
        provider: "deepseek",
        model: json.model ?? request.model,
        content: content ?? "",
        usage: json.usage
          ? {
              promptTokens: json.usage.prompt_tokens,
              completionTokens: json.usage.completion_tokens,
              totalTokens: json.usage.total_tokens,
            }
          : undefined,
        raw: json,
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError({
        provider: "deepseek",
        retryable: true,
        message: "DeepSeek request failed",
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

    const body: DeepSeekChatCompletionBody = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      top_p: request.topP,
      max_tokens: request.maxTokens,
      stream: true,
      response_format: request.responseFormat
        ? { type: request.responseFormat }
        : undefined,
      seed: request.seed,
      thinking:
        request.model === "deepseek-reasoner"
          ? { type: "enabled" }
          : { type: "disabled" },
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new ProviderError({
          provider: "deepseek",
          statusCode: res.status,
          retryable: res.status === 429 || res.status >= 500,
          message: `DeepSeek stream failed (${res.status})`,
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
