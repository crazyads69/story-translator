import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  LlmClient,
} from "../types";
import { withRetry, type RetryConfig } from "./retry";

export class RetriableClient implements LlmClient {
  readonly provider: LlmClient["provider"];
  private readonly inner: LlmClient;
  private readonly retry: RetryConfig;

  constructor(inner: LlmClient, retry: RetryConfig) {
    this.inner = inner;
    this.provider = inner.provider;
    this.retry = retry;
  }

  async chatComplete(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    return withRetry(() => this.inner.chatComplete(request), this.retry);
  }
}
