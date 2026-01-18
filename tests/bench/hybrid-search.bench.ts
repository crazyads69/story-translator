import { describe, test } from "bun:test";
import { reciprocalRankFusion } from "../../src/application/search/hybrid-search";
import { chunkText } from "../../src/infrastructure/splitting/chunking";

describe("bench: hybrid search primitives", () => {
  test("RRF fusion (1k + 1k)", () => {
    const vec = Array.from({ length: 1000 }, (_, i) => ({
      id: `v${i}`,
    })) as any;
    const fts = Array.from({ length: 1000 }, (_, i) => ({
      id: `v${i}`,
    })) as any;
    reciprocalRankFusion(vec, fts, 60);
  });

  test("chunking (markdown strategy)", () => {
    const text = Array.from(
      { length: 200 },
      (_, i) => `## H${i}\n\n${"x".repeat(400)}\n`,
    ).join("\n");
    chunkText(text, {
      chunkSize: 1200,
      chunkOverlap: 150,
      strategy: "markdown",
    });
  });
});
