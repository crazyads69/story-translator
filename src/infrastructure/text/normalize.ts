/**
 * Lightweight normalization for retrieval:
 * - normalize newlines
 * - trim
 * - collapse excessive whitespace
 *
 * This is intentionally not language-specific stemming. LanceDB FTS supports stemming
 * via its FTS index configuration when enabled.
 */
export function normalizeTextForSearch(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * A conservative tokenizer for keyword features & debugging.
 *
 * Keep it deterministic and low-risk: lowercase, ASCII fold-ish (partial),
 * and split on non-letter/digit.
 */
export function tokenize(input: string): string[] {
  const normalized = normalizeTextForSearch(input)
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9\u00C0-\u024F]+/gi, " ");
  return normalized.split(" ").map((t) => t.trim()).filter(Boolean);
}

