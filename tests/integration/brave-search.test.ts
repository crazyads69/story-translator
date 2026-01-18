import { describe, expect, it } from "vitest";
import { BraveSearchClient } from "../../src/infrastructure/research/brave-search";

describe("BraveSearchClient", () => {
  it("parses web results", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          web: {
            results: [
              { title: "t", url: "https://example.com", description: "d" },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const client = new BraveSearchClient({
      apiKey: "x",
      baseUrl: "https://api.search.brave.com/res/v1",
      country: "US",
      searchLang: "en",
      count: 5,
      extraSnippets: true,
      timeoutMs: 10_000,
      maxRetries: 0,
      fetchImpl,
    });

    const out = await client.webSearch("hello");
    expect(out.length).toBe(1);
    expect(out[0]?.url).toBe("https://example.com");
  });
});
