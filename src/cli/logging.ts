import type { AppConfig } from "../infrastructure/config/schema";

export type Logger = {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export function createLogger(config: Pick<AppConfig, "logLevel">): Logger {
  const level = config.logLevel;
  const enabled = (target: AppConfig["logLevel"]) => {
    const order: AppConfig["logLevel"][] = ["silent", "error", "warn", "info", "debug"];
    return order.indexOf(level) >= order.indexOf(target) && level !== "silent";
  };

  return {
    debug: (m) => enabled("debug") && console.error(m),
    info: (m) => enabled("info") && console.error(m),
    warn: (m) => enabled("warn") && console.error(m),
    error: (m) => enabled("error") && console.error(m),
  };
}

