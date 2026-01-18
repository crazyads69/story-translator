import { readdir } from "node:fs/promises";
import path from "node:path";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { Document } from "@langchain/core/documents";
import type { AppConfig } from "../../infrastructure/config/schema";
import { createLlmClients } from "../../infrastructure/llm/factory";
import { createConcurrencyLimiter } from "../../infrastructure/llm/rate-limit/limiter";
import { OpenRouterEmbeddings } from "../../infrastructure/embeddings/openrouter";
import { FileLoader } from "../../infrastructure/loaders/file-loader";
import { UrlLoader } from "../../infrastructure/loaders/url-loader";
import { chunkText } from "../../infrastructure/splitting/chunking";
import { normalizeTextForSearch } from "../../infrastructure/text/normalize";
import { sha256HexUtf8 } from "../../infrastructure/crypto/hash";
import { LanceDbChunkStore } from "../../infrastructure/vectordb/lancedb";
import type {
  ChunkDocument,
  ContentType,
  SourceType,
} from "../../domain/ingest/chunk";
import { BraveSearchClient } from "../../infrastructure/research/brave-search";
import { isSafePublicHttpUrl } from "../../infrastructure/http/url-safety";
import { enrichChunk, enrichChunkTwoStage } from "./enrich-chunk";
import { HybridSearchService } from "../search/hybrid-search";
import { JinaRerankerClient } from "../../infrastructure/rerank/jina";

export type IngestStats = {
  sources: number;
  documentsLoaded: number;
  chunksStored: number;
  webResearchFetched: number;
  elapsedMs: number;
};

type LoadedSource = {
  sourceType: SourceType;
  sourceUri: string;
  contentType: ContentType;
  docs: Document[];
};

type ChunkDraft = {
  sourceType: SourceType;
  sourceUri: string;
  sourceId: string;
  contentType: ContentType;
  chunkIndex: number;
  sectionPath: string[];
  text: string;
  language?: string;
};

const State = Annotation.Root({
  config: Annotation<AppConfig>(),
  explicitSources: Annotation<string[]>(),
  sources: Annotation<LoadedSource[]>(),
  chunks: Annotation<ChunkDraft[]>(),
  stored: Annotation<number>(),
  webResearchFetched: Annotation<number>(),
  elapsedMs: Annotation<number>(),
});

/**
 * LangGraph orchestration for ingest:
 * - fetch/load documents
 * - optional Brave-based web enrichment
 * - chunking
 * - optional LLM normalization/summarization
 * - embeddings + LanceDB storage
 * - optional hybrid retrieval smoke-check (vector+FTS+Jina)
 */
export class IngestGraph {
  async run(
    config: AppConfig,
    explicitSources: string[] = [],
  ): Promise<IngestStats> {
    const started = Date.now();

    const graph = new StateGraph(State)
      .addNode("loadDocuments", async (state) => {
        const inputs =
          state.explicitSources.length > 0
            ? state.explicitSources
            : await discoverInputFiles(state.config);

        const loaded: LoadedSource[] = [];
        for (const src of inputs) {
          if (isSafePublicHttpUrl(src)) {
            const loader = new UrlLoader(src, {
              timeoutMs: state.config.braveSearch.timeoutMs,
              maxBytes: 2_000_000,
            });
            const docs = await loader.load();
            loaded.push({
              sourceType: "url",
              sourceUri: src,
              contentType: "html",
              docs,
            });
            continue;
          }
          const ct = inferContentTypeFromPath(src);
          const loader = new FileLoader(src, {
            contentType:
              ct === "pdf" ? "pdf" : ct === "markdown" ? "markdown" : "text",
          });
          const docs = await loader.load();
          loaded.push({
            sourceType: "file",
            sourceUri: src,
            contentType: ct,
            docs,
          });
        }
        return { sources: loaded };
      })
      .addNode("webEnrich", async (state) => {
        if (!state.config.ingest.enrichment.enabled) {
          return { sources: state.sources, webResearchFetched: 0 };
        }
        if (
          !state.config.braveSearch.enabled ||
          !state.config.braveSearch.apiKey
        ) {
          return { sources: state.sources, webResearchFetched: 0 };
        }
        const brave = new BraveSearchClient({
          apiKey: state.config.braveSearch.apiKey,
          baseUrl: state.config.braveSearch.baseUrl,
          country: state.config.braveSearch.country,
          searchLang: state.config.braveSearch.searchLang,
          count: state.config.braveSearch.count,
          extraSnippets: state.config.braveSearch.extraSnippets,
          timeoutMs: state.config.braveSearch.timeoutMs,
          maxRetries: state.config.braveSearch.maxRetries,
        });

        const urls: string[] = [];
        for (const src of state.sources) {
          const seed = src.docs[0]?.pageContent?.slice(0, 500) ?? "";
          const query = seed.length > 0 ? seed : path.basename(src.sourceUri);
          const results = await brave.webSearch(query);
          for (const r of results) {
            if (isSafePublicHttpUrl(r.url)) urls.push(r.url);
          }
          if (urls.length >= state.config.ingest.enrichment.maxUrls) break;
        }

        const limiter = createConcurrencyLimiter(
          state.config.ingest.enrichment.maxConcurrentFetches,
        );
        const fetched = await Promise.all(
          urls.slice(0, state.config.ingest.enrichment.maxUrls).map((u) =>
            limiter.run(async () => {
              const loader = new UrlLoader(u, {
                timeoutMs: state.config.braveSearch.timeoutMs,
                maxBytes: state.config.ingest.enrichment.maxCharsPerUrl * 2,
              });
              const docs = await loader.load();
              return {
                sourceType: "web_research" as const,
                sourceUri: u,
                contentType: "html" as const,
                docs,
              };
            }),
          ),
        );

        return {
          sources: [...state.sources, ...fetched],
          webResearchFetched: fetched.length,
        };
      })
      .addNode("chunk", async (state) => {
        const drafts: ChunkDraft[] = [];
        for (const src of state.sources) {
          const sourceId = sha256HexUtf8(`${src.sourceType}:${src.sourceUri}`);
          // Infer language from path if available (hacky but consistent with current config layout)
          // Default to 'unknown' which is safe
          const isTranslated = src.sourceUri.includes(
            state.config.ingest.translatedChaptersPath,
          );
          const lang = isTranslated ? "vi" : "en"; // Assumption: original=en, translated=vi

          for (const doc of src.docs) {
            const chunks = chunkText(
              doc.pageContent,
              state.config.ingest.chunk,
            );
            for (let i = 0; i < chunks.length; i++) {
              const c = chunks[i]!;
              const text = state.config.ingest.chunk.normalize
                ? normalizeTextForSearch(c.text)
                : c.text;
              drafts.push({
                sourceType: src.sourceType,
                sourceUri: src.sourceUri,
                sourceId,
                contentType: src.contentType,
                chunkIndex: i,
                sectionPath: c.sectionPath,
                text,
                language: lang,
              });
            }
          }
        }
        return { chunks: drafts };
      })
      .addNode("embedAndStore", async (state) => {
        const openrouter = state.config.providers.openrouter;
        if (!openrouter)
          throw new Error(
            "OpenRouter config is required for embeddings during ingest",
          );

        const store = new LanceDbChunkStore({
          path: state.config.vectordb.path,
          table: state.config.vectordb.table,
        });
        await store.connect();
        await store.ensureIndexes({
          vectorColumn: state.config.ingest.indexing.vectorColumn,
          textColumn: state.config.ingest.indexing.ftsColumn,
          createVectorIndex: state.config.ingest.indexing.createVectorIndex,
          createFtsIndex: state.config.ingest.indexing.createFtsIndex,
        });

        const embeddings = new OpenRouterEmbeddings({
          apiKey: openrouter.apiKey,
          baseUrl: openrouter.baseUrl,
          model: state.config.embeddings.model,
          timeoutMs: openrouter.timeoutMs,
        });

        const llmClients = createLlmClients(state.config);
        const llmLimiter = createConcurrencyLimiter(
          state.config.providers.deepseek.concurrency,
        );
        const llmEnabled = state.config.ingest.llm.enabled;
        const llmModel =
          state.config.ingest.llm.model ??
          state.config.providers.deepseek.model;

        const batchSize = 24;
        let stored = 0;
        for (let i = 0; i < state.chunks.length; i += batchSize) {
          const slice = state.chunks.slice(i, i + batchSize);

          const enriched = llmEnabled
            ? await Promise.all(
                slice.map((c) =>
                  llmLimiter.run(async () => {
                    try {
                      // Use 2-stage enrichment if OpenRouter is available, otherwise single stage
                      if (llmClients.openrouter) {
                        return await enrichChunkTwoStage({
                          deepseekClient: llmClients.deepseek,
                          deepseekModel: llmModel,
                          openrouterClient: llmClients.openrouter,
                          openrouterModel: "xiaomi/mimo-v2-flash:free", // Hardcoded per requirement or config
                          input: {
                            sourceUri: c.sourceUri,
                            contentTypeHint: c.contentType,
                            chunkText: c.text,
                          },
                        });
                      }
                      return await enrichChunk({
                        client: llmClients.deepseek,
                        model: llmModel,
                        input: {
                          sourceUri: c.sourceUri,
                          contentTypeHint: c.contentType,
                          chunkText: c.text,
                        },
                      });
                    } catch {
                      return undefined;
                    }
                  }),
                ),
              )
            : slice.map(() => undefined);

          const summaryForEmbedding = slice.map((c, idx) => {
            const e = enriched[idx];
            return e?.summaryForEmbedding ?? c.text.slice(0, 1_000);
          });

          const vectors = await embeddings.embedBatch(summaryForEmbedding);
          const now = Date.now();
          const rows: ChunkDocument[] = slice.map((c, idx) => {
            const e = enriched[idx];
            const normalizedText = e?.normalizedText ?? c.text;
            const hash = sha256HexUtf8(normalizedText);
            const id = sha256HexUtf8(`${c.sourceId}:${c.chunkIndex}:${hash}`);
            return {
              id,
              text: normalizedText,
              normalizedText,
              summaryForEmbedding: summaryForEmbedding[idx]!,
              vector: vectors[idx]!,
              metadata: {
                sourceType: c.sourceType,
                sourceId: c.sourceId,
                sourceUri: c.sourceUri,
                contentType: e?.contentType ?? c.contentType,
                language: e?.language ?? c.language ?? "unknown",
                title: e?.title,
                sectionPath: c.sectionPath,
                chunkIndex: c.chunkIndex,
                createdAtMs: now,
                version: "v1",
                hash,
              },
            };
          });

          await store.upsertChunks(rows);
          stored += rows.length;
        }

        if (state.config.reranker.enabled && state.config.reranker.jinaApiKey) {
          const reranker = new JinaRerankerClient({
            apiKey: state.config.reranker.jinaApiKey,
            baseUrl: state.config.reranker.baseUrl,
            model: state.config.reranker.model,
            timeoutMs: state.config.reranker.timeoutMs,
            maxRetries: state.config.reranker.maxRetries,
          });
          const search = new HybridSearchService({
            store,
            embeddings,
            reranker,
          });
          await search
            .search("smoke test query", {
              vectorTopK: 10,
              ftsTopK: 10,
              rrfK: 60,
              rerankTopK: Math.min(20, state.config.reranker.maxDocuments),
              ftsColumns: state.config.ingest.indexing.ftsColumn,
            })
            .catch(() => {});
        }

        return { stored };
      })
      .addEdge(START, "loadDocuments")
      .addEdge("loadDocuments", "webEnrich")
      .addEdge("webEnrich", "chunk")
      .addEdge("chunk", "embedAndStore")
      .addEdge("embedAndStore", END)
      .compile();

    const result = await graph.invoke({
      config,
      explicitSources,
      sources: [],
      chunks: [],
      stored: 0,
      webResearchFetched: 0,
      elapsedMs: 0,
    });

    return {
      sources: result.sources.length,
      documentsLoaded: result.sources.reduce((a, b) => a + b.docs.length, 0),
      chunksStored: result.stored,
      webResearchFetched: result.webResearchFetched,
      elapsedMs: Date.now() - started,
    };
  }
}

async function discoverInputFiles(config: AppConfig): Promise<string[]> {
  const originals = await listFiles(config.ingest.originalChaptersPath);
  const translated = await listFiles(config.ingest.translatedChaptersPath);
  return [...originals, ...translated].filter((p) => {
    const ext = path.extname(p).toLowerCase();
    return ext === ".md" || ext === ".mdx" || ext === ".txt" || ext === ".pdf";
  });
}

async function listFiles(dir: string): Promise<string[]> {
  const abs = path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir);
  const entries = await readdir(abs, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const p = path.join(abs, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function inferContentTypeFromPath(p: string): ContentType {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".md" || ext === ".mdx") return "markdown";
  if (ext === ".txt") return "text";
  return "unknown";
}
