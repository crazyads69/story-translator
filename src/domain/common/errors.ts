export type ErrorKind = "config" | "validation" | "provider" | "io" | "unknown";

export class AppError extends Error {
  readonly kind: ErrorKind;
  override readonly cause?: unknown;

  constructor(kind: ErrorKind, message: string, cause?: unknown) {
    super(message);
    this.kind = kind;
    this.cause = cause;
  }
}

export class ConfigError extends AppError {
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, cause?: unknown) {
    super("validation", message, cause);
  }
}

export class ProviderError extends AppError {
  readonly provider?: string;
  readonly statusCode?: number;
  readonly retryable: boolean;

  constructor(params: {
    message: string;
    provider?: string;
    statusCode?: number;
    retryable: boolean;
    cause?: unknown;
  }) {
    super("provider", params.message, params.cause);
    this.provider = params.provider;
    this.statusCode = params.statusCode;
    this.retryable = params.retryable;
  }
}

export class IOError extends AppError {
  readonly path?: string;

  constructor(message: string, cause?: unknown, path?: string) {
    super("io", message, cause);
    this.path = path;
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error)
    return new AppError("unknown", error.message, error);
  return new AppError("unknown", String(error));
}
