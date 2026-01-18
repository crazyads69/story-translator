import { createHash } from "node:crypto";

/**
 * Computes a stable SHA-256 hex digest for the given UTF-8 string.
 *
 * Use this for:
 * - idempotent chunk IDs (same input -> same ID)
 * - detecting content changes for versioning
 */
export function sha256HexUtf8(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

