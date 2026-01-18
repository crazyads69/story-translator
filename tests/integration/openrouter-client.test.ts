import { describe, expect, it } from "vitest";
import nock from "nock";
import { OpenRouterClient } from "../../src/infrastructure/llm/providers/openrouter";
import { ProviderError } from "../../src/domain/common/errors";

describe("OpenRouterClient", () => {
  it("throws on in-band error with HTTP 200", async () => {
    nock("https://openrouter.ai")
      .post("/api/v1/chat/completions")
      .reply(200, { error: { code: 429, message: "rate limited" } });

    const client = new OpenRouterClient({
      apiKey: "x",
      baseUrl: "https://openrouter.ai/api/v1",
      timeoutMs: 10_000,
    });

    await expect(
      client.chatComplete({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

