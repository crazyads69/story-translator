import type { ChatCompletionRequest, ChatCompletionResponse, LlmClient } from "../types";
import type { Limiter } from "./limiter";

export class LimitedClient implements LlmClient {
  readonly provider: LlmClient["provider"];
  private readonly inner: LlmClient;
  private readonly limiter: Limiter;

  constructor(inner: LlmClient, limiter: Limiter) {
    this.inner = inner;
    this.provider = inner.provider;
    this.limiter = limiter;
  }

  async chatComplete(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    return this.limiter.run(() => this.inner.chatComplete(request));
  }
}

