import { ProviderError } from "../../../domain/common/errors";
import { computeBackoffMs, sleep, type BackoffConfig } from "./backoff";

export type RetryConfig = {
  maxRetries: number;
  backoff: BackoffConfig;
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retryable =
        error instanceof ProviderError ? error.retryable : error instanceof Error;
      if (!retryable || attempt > config.maxRetries) break;
      const waitMs = computeBackoffMs(attempt, config.backoff);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

