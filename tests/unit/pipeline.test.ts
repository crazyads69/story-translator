import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/infrastructure/config/schema";
import type { LlmClient } from "../../src/infrastructure/llm/types";
import { TranslationPipeline } from "../../src/application/pipeline/orchestrator";
import { PROMPT_VERSION } from "../../src/prompts/v1/shared.system";

function fakeClient(handler: (req: any) => string): LlmClient {
  return {
    provider: "deepseek",
    async chatComplete(request) {
      return {
        provider: "deepseek",
        model: request.model,
        content: handler(request),
      };
    },
  };
}

describe("TranslationPipeline", () => {
  it("runs stage1+stage2 with deterministic structured outputs", async () => {
    const stage1Json =
      '{"language":"Vietnamese","translation":"Xin chào","glossary":[],"warnings":[],"evidence":[]}';
    const stage2Json =
      `{"language":"Vietnamese","translation":"Xin chào","decisions":[],"glossary":[],"metadata":{"promptVersion":"${PROMPT_VERSION}","providers":[]}}`;
    // Stage 3 linkage response
    const stage3Json =
      '{"report":{"issues":[],"linkableTerms":[],"consistencyChecks":[]},"result":{"enhancedParagraph":"Xin chào","changesSummary":[]}}';

    const deepseek = fakeClient((req) => {
      const content = req.messages.map((m: any) => String(m.content)).join("");
      // Stage 3: Linkage fix - check for linkage-specific markers
      if (content.includes("KIỂM ĐỊNH LIÊN KẾT") || content.includes("ĐOẠN DỊCH HIỆN TẠI")) {
        return stage3Json;
      }
      // Stage 2: Synthesis - check for draft translation markers
      if (content.includes("DRAFT TRANSLATIONS") || content.includes("DeepSeek Draft")) {
        return stage2Json;
      }
      // Stage 1: Draft generation
      return stage1Json;
    });

    const openrouter: LlmClient = {
      provider: "openrouter",
      async chatComplete(request) {
        return {
          provider: "openrouter",
          model: request.model,
          content: stage1Json,
        };
      },
    };

    const config: AppConfig = {
      logLevel: "silent",
      providers: {
        deepseek: {
          apiKey: "x",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-chat",
          timeoutMs: 120000,
          maxRetries: 0,
          concurrency: 1,
        },
        openrouter: {
          apiKey: "y",
          baseUrl: "https://openrouter.ai/api/v1",
          model: "openai/gpt-4o-mini",
          timeoutMs: 120000,
          maxRetries: 0,
          concurrency: 1,
          app: {},
        },
      },
      embeddings: { model: "text-embedding-3-small", concurrency: 1 },
      vectordb: { path: "lancedb", table: "chunks" },
      ingest: {
        originalChaptersPath: "data/original",
        translatedChaptersPath: "data/translated",
        chunk: {
          chunkSize: 1200,
          chunkOverlap: 150,
          strategy: "markdown",
          normalize: true,
        },
        enrichment: {
          enabled: false,
          maxUrls: 0,
          maxCharsPerUrl: 10_000,
          maxConcurrentFetches: 1,
        },
        llm: { enabled: false },
        indexing: {
          createVectorIndex: false,
          createFtsIndex: false,
          ftsColumn: "text",
          vectorColumn: "vector",
        },
      },
      braveSearch: {
        enabled: false,
        baseUrl: "https://api.search.brave.com/res/v1",
        country: "US",
        searchLang: "en",
        count: 5,
        extraSnippets: true,
        timeoutMs: 20000,
        maxRetries: 0,
      },
      reranker: {
        enabled: false,
        baseUrl: "https://api.jina.ai/v1",
        model: "jina-reranker-v2-base-multilingual",
        topN: 10,
        maxDocuments: 50,
        timeoutMs: 30000,
        maxRetries: 0,
        concurrency: 1,
      },
    };

    const pipeline = new TranslationPipeline(config, { deepseek, openrouter });
    const out = await pipeline.run({ language: "Vietnamese", source: "Hello" });
    expect(out.final.translation).toBe("Xin chào");
    expect(out.stage1.deepseek.draft?.translation).toBe("Xin chào");
  });
});
