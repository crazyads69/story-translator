import { ProviderError } from "../../domain/common/errors";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type SafeFetchArgs = {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
  accept?: string;
  fetchImpl?: FetchLike;
};

export type SafeFetchTextResult = {
  url: string;
  status: number;
  contentType?: string;
  text: string;
};

export type SafeFetchBinaryResult = {
  url: string;
  status: number;
  contentType?: string;
  bytes: Uint8Array;
};

/**
 * Fetches a URL with:
 * - timeout (AbortController)
 * - max response size (hard cap)
 *
 * This keeps enrichment bounded and avoids "download forever" failures.
 */
export async function safeFetchText(
  args: SafeFetchArgs,
): Promise<SafeFetchTextResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const res = await fetchImpl(args.url, {
      method: args.method ?? "GET",
      headers: {
        ...(args.accept ? { Accept: args.accept } : {}),
        ...(args.headers ?? {}),
      },
      body: args.body,
      signal: controller.signal,
    });

    const contentType = res.headers.get("content-type") ?? undefined;
    const reader = res.body?.getReader();
    if (!reader) {
      return { url: args.url, status: res.status, contentType, text: "" };
    }

    const decoder = new TextDecoder();
    let total = 0;
    let out = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > args.maxBytes) {
        throw new ProviderError({
          provider: "brave",
          retryable: false,
          message: `Response exceeded maxBytes (${args.maxBytes})`,
        });
      }
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return { url: args.url, status: res.status, contentType, text: out };
  } finally {
    clearTimeout(timeout);
  }
}

export async function safeFetchBinary(
  args: SafeFetchArgs,
): Promise<SafeFetchBinaryResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const res = await fetchImpl(args.url, {
      method: args.method ?? "GET",
      headers: {
        ...(args.accept ? { Accept: args.accept } : {}),
        ...(args.headers ?? {}),
      },
      body: args.body,
      signal: controller.signal,
    });

    const contentType = res.headers.get("content-type") ?? undefined;
    const reader = res.body?.getReader();
    if (!reader) {
      return {
        url: args.url,
        status: res.status,
        contentType,
        bytes: new Uint8Array(),
      };
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > args.maxBytes) {
        throw new ProviderError({
          provider: "brave",
          retryable: false,
          message: `Response exceeded maxBytes (${args.maxBytes})`,
        });
      }
      chunks.push(value);
    }

    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return { url: args.url, status: res.status, contentType, bytes: out };
  } finally {
    clearTimeout(timeout);
  }
}
