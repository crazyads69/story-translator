import { describe, expect, it } from "vitest";
import { JinaRerankerClient } from "../../src/infrastructure/rerank/jina";

describe("JinaRerankerClient", () => {
  it("returns rerank results", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          results: [
            { index: 1, score: 0.9 },
            { index: 0, score: 0.1 },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const client = new JinaRerankerClient({
      apiKey: "x",
      baseUrl: "https://api.jina.ai/v1",
      model: "jina-reranker-v2-base-multilingual",
      timeoutMs: 10_000,
      maxRetries: 0,
      fetchImpl,
    });

    const out = await client.rerank({
      query: "q",
      documents: ["a", "b"],
      topN: 2,
    });
    expect(out[0]?.index).toBe(1);
    expect(out[0]?.score).toBeCloseTo(0.9);
  });
});
