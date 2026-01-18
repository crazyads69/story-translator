import type { AppConfig } from "../config/schema";
import { DeepSeekClient } from "./providers/deepseek";
import { OpenRouterClient } from "./providers/openrouter";
import { createConcurrencyLimiter } from "./rate-limit/limiter";
import { LimitedClient } from "./rate-limit/limited-client";
import { RetriableClient } from "./retry/retriable-client";
import type { LlmClient } from "./types";

export type LlmClients = {
  deepseek: LlmClient;
  openrouter?: LlmClient;
};

export function createLlmClients(config: AppConfig): LlmClients {
  const deepseekLimiter = createConcurrencyLimiter(config.providers.deepseek.concurrency);
  const deepseekInner = new LimitedClient(
    new DeepSeekClient({
    apiKey: config.providers.deepseek.apiKey,
    baseUrl: config.providers.deepseek.baseUrl,
    timeoutMs: config.providers.deepseek.timeoutMs,
    }),
    deepseekLimiter,
  );
  const deepseek = new RetriableClient(deepseekInner, {
    maxRetries: config.providers.deepseek.maxRetries,
    backoff: { baseMs: 250, maxMs: 10_000, jitter: 0.2 },
  });

  const openrouterConfig = config.providers.openrouter;
  let openrouter: LlmClient | undefined;
  if (openrouterConfig) {
    const inner = new LimitedClient(
      new OpenRouterClient({
        apiKey: openrouterConfig.apiKey,
        baseUrl: openrouterConfig.baseUrl,
        timeoutMs: openrouterConfig.timeoutMs,
        httpReferer: openrouterConfig.app.httpReferer,
        title: openrouterConfig.app.title,
      }),
      createConcurrencyLimiter(openrouterConfig.concurrency),
    );
    openrouter = new RetriableClient(inner, {
      maxRetries: openrouterConfig.maxRetries,
      backoff: { baseMs: 250, maxMs: 10_000, jitter: 0.2 },
    });
  }

  return { deepseek, openrouter };
}
