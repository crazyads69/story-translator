import { z } from "zod";

export const LogLevelSchema = z
  .enum(["silent", "error", "warn", "info", "debug"])
  .default("info");

export const ProviderDeepSeekSchema = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.string().url().default("https://api.deepseek.com"),
  model: z
    .enum(["deepseek-chat", "deepseek-reasoner"])
    .default("deepseek-chat"),
  timeoutMs: z.number().int().positive().default(120_000),
  maxRetries: z.number().int().min(0).default(3),
  concurrency: z.number().int().positive().default(2),
});

export const ProviderOpenRouterSchema = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.string().url().default("https://openrouter.ai/api/v1"),
  model: z.string().min(1).default("openai/gpt-4o-mini"),
  timeoutMs: z.number().int().positive().default(120_000),
  maxRetries: z.number().int().min(0).default(3),
  concurrency: z.number().int().positive().default(2),
  app: z
    .object({
      httpReferer: z.string().url().optional(),
      title: z.string().min(1).optional(),
    })
    .default({}),
});

export const EmbeddingsSchema = z.object({
  model: z.string().min(1).default("text-embedding-3-small"),
  concurrency: z.number().int().positive().default(4),
});

export const VectorDbSchema = z.object({
  path: z.string().min(1).default("lancedb"),
  table: z.string().min(1).default("chunks"),
});

export const IngestSchema = z.object({
  originalChaptersPath: z.string().min(1).default("data/original"),
  translatedChaptersPath: z.string().min(1).default("data/translated"),
  taskChaptersPath: z.string().min(1).default("data/task"),
  metadataPath: z.string().min(1).default("data/metadata"),
  /** Language settings for content detection */
  language: z
    .object({
      /** Language code for original content (e.g., "en", "zh", "ja") */
      original: z.string().min(2).default("en"),
      /** Language code for translated content (e.g., "vi", "ko", "th") */
      translated: z.string().min(2).default("vi"),
    })
    .default({}),
  chunk: z
    .object({
      chunkSize: z.number().int().positive().default(1200),
      chunkOverlap: z.number().int().min(0).default(150),
      strategy: z.enum(["markdown", "recursive", "paragraph"]).default("markdown"),
      normalize: z.boolean().default(true),
      /** Enable grouping of short paragraphs (dialogue, etc.) */
      groupShortParagraphs: z.boolean().default(true),
      /** Paragraphs shorter than this are considered "short" (chars) */
      groupShortThreshold: z.number().int().positive().default(80),
      /** Maximum paragraphs per group */
      groupMaxSize: z.number().int().positive().default(4),
      /** Context window configuration for paragraph strategy */
      contextWindow: z
        .object({
          prevChars: z.number().int().min(0).default(500),
          nextChars: z.number().int().min(0).default(300),
          enabled: z.boolean().default(true),
        })
        .default({}),
    })
    .default({}),
  enrichment: z
    .object({
      enabled: z.boolean().default(false),
      maxUrls: z.number().int().min(0).default(5),
      maxCharsPerUrl: z.number().int().positive().default(20_000),
      maxConcurrentFetches: z.number().int().positive().default(4),
    })
    .default({}),
  llm: z
    .object({
      enabled: z.boolean().default(false),
      model: z.string().min(1).optional(),
    })
    .default({}),
  indexing: z
    .object({
      createVectorIndex: z.boolean().default(true),
      createFtsIndex: z.boolean().default(true),
      ftsColumn: z.string().min(1).default("text"),
      vectorColumn: z.string().min(1).default("vector"),
    })
    .default({}),
});

export const BraveSearchSchema = z.object({
  apiKey: z.string().min(1).optional(),
  enabled: z.boolean().default(false),
  baseUrl: z.string().url().default("https://api.search.brave.com/res/v1"),
  country: z.string().min(2).max(2).default("US"),
  searchLang: z.string().min(2).default("en"),
  count: z.number().int().min(1).max(20).default(5),
  extraSnippets: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(20_000),
  maxRetries: z.number().int().min(0).default(2),
});

export const RerankerSchema = z.object({
  jinaApiKey: z.string().min(1).optional(),
  enabled: z.boolean().default(false),
  baseUrl: z.string().url().default("https://api.jina.ai/v1"),
  model: z.string().min(1).default("jina-reranker-v2-base-multilingual"),
  topN: z.number().int().positive().default(10),
  maxDocuments: z.number().int().positive().default(50),
  timeoutMs: z.number().int().positive().default(30_000),
  maxRetries: z.number().int().min(0).default(2),
  concurrency: z.number().int().positive().default(2),
});

export const TranslationSchema = z.object({
  /** Model for Stage 1 draft generation (DeepSeek) */
  stage1Model: z.string().min(1).default("deepseek-chat"),
  /** Model for Stage 2 synthesis (DeepSeek Reasoner) */
  stage2Model: z.string().min(1).default("deepseek-reasoner"),
  /** Model for Stage 3 linkage verification */
  stage3Model: z.string().min(1).default("deepseek-chat"),
  /** Model for OpenRouter Stage 1 (optional second opinion) */
  openrouterStage1Model: z.string().min(1).default("xiaomi/mimo-v2-flash:free"),
});

export const AppConfigSchema = z.object({
  logLevel: LogLevelSchema,
  providers: z.object({
    deepseek: ProviderDeepSeekSchema,
    openrouter: ProviderOpenRouterSchema.optional(),
  }),
  embeddings: EmbeddingsSchema,
  vectordb: VectorDbSchema,
  ingest: IngestSchema,
  braveSearch: BraveSearchSchema,
  reranker: RerankerSchema,
  translation: TranslationSchema.default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
