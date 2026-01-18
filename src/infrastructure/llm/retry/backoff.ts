export type BackoffConfig = {
  baseMs: number;
  maxMs: number;
  jitter: number;
};

export function computeBackoffMs(
  attempt: number,
  config: BackoffConfig,
): number {
  const exp = config.baseMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exp, config.maxMs);
  const jitter = 1 + (Math.random() * 2 - 1) * config.jitter;
  return Math.max(0, Math.round(capped * jitter));
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

