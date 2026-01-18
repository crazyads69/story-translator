export type Limiter = {
  run<T>(fn: () => Promise<T>): Promise<T>;
};

export function createConcurrencyLimiter(maxConcurrency: number): Limiter {
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    const job = queue.shift();
    if (job) job();
  };

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (maxConcurrency <= 0) return fn();

      if (active >= maxConcurrency) {
        await new Promise<void>((resolve) => queue.push(resolve));
      }

      active += 1;
      try {
        return await fn();
      } finally {
        active -= 1;
        next();
      }
    },
  };
}

