import type {
  ParagraphContentType,
  StoredChunkRow,
} from "../../domain/ingest/chunk";
import type { OpenRouterEmbeddings } from "../../infrastructure/embeddings/openrouter";
import type { LanceDbChunkStore } from "../../infrastructure/vectordb/lancedb";
import type { JinaRerankerClient } from "../../infrastructure/rerank/jina";

/**
 * Filter options for hybrid search.
 * Used to filter by paragraph content type (original vs translated).
 */
export type HybridSearchFilter = {
  /** Filter by content type: "original" or "translated" */
  paragraphContentType?: ParagraphContentType;
  /** Filter by source language (e.g., "en", "vi") */
  language?: string;
};

export type HybridSearchConfig = {
  vectorTopK: number;
  ftsTopK: number;
  rrfK: number;
  rerankTopK: number;
  ftsColumns?: string | string[];
  /** Optional filter for bilingual search (original vs translated) */
  filter?: HybridSearchFilter;
  /**
   * Fusion strategy for combining vector and FTS results.
   * - "rrf": Reciprocal Rank Fusion (default) - separate searches + manual fusion
   * - "native": LanceDB native hybrid search - single query with internal fusion
   *
   * RRF gives more control and is more predictable.
   * Native may be faster but uses LanceDB's internal fusion algorithm.
   */
  fusionStrategy?: "rrf" | "native";
  /** Maximum retries for transient failures */
  maxRetries?: number;
  /** Enable timing metrics */
  enableMetrics?: boolean;
};

export type HybridSearchMetrics = {
  embeddingMs: number;
  vectorSearchMs: number;
  ftsSearchMs: number;
  fusionMs: number;
  rerankMs: number;
  totalMs: number;
};

export type HybridSearchResult = {
  id: string;
  text: string;
  metadata: StoredChunkRow["metadata"];
  scores: {
    rrf: number;
    jina?: number;
  };
  /** Timing metrics (if enabled) */
  metrics?: HybridSearchMetrics;
};

/**
 * Hybrid retrieval:
 * 1) Dense vector search (embeddings)
 * 2) Sparse keyword search (LanceDB FTS / BM25)
 * 3) Reciprocal Rank Fusion (RRF) to combine candidate sets
 * 4) Optional Jina reranker on the top fused candidates
 */
export class HybridSearchService {
  private readonly store: LanceDbChunkStore;
  private readonly embeddings: OpenRouterEmbeddings;
  private readonly reranker?: JinaRerankerClient;

  constructor(args: {
    store: LanceDbChunkStore;
    embeddings: OpenRouterEmbeddings;
    reranker?: JinaRerankerClient;
  }) {
    this.store = args.store;
    this.embeddings = args.embeddings;
    this.reranker = args.reranker;
  }

  async search(
    query: string,
    config: HybridSearchConfig,
  ): Promise<HybridSearchResult[]> {
    const maxRetries = config.maxRetries ?? 2;
    const enableMetrics = config.enableMetrics ?? false;
    const startTime = enableMetrics ? Date.now() : 0;
    const metrics: Partial<HybridSearchMetrics> = {};

    // Retry wrapper for transient failures
    const withRetry = async <T>(fn: () => Promise<T>, name: string): Promise<T> => {
      let lastError: Error | undefined;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          return await fn();
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (attempt < maxRetries) {
            // Exponential backoff: 100ms, 200ms, 400ms...
            await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt - 1)));
          }
        }
      }
      throw new Error(`${name} failed after ${maxRetries} attempts: ${lastError?.message}`);
    };

    // 1. Generate embedding for query
    const embeddingStart = enableMetrics ? Date.now() : 0;
    const [queryVector] = await withRetry(
      () => this.embeddings.embedBatch([query]),
      "embedding",
    );
    if (enableMetrics) metrics.embeddingMs = Date.now() - embeddingStart;

    if (!queryVector) {
      throw new Error("Failed to generate query embedding");
    }

    // Build filter for LanceDB if provided
    const lanceFilter = this.buildLanceFilter(config.filter);

    let candidates: StoredChunkRow[];
    let rrfScores = new Map<string, number>();

    if (config.fusionStrategy === "native") {
      // Use LanceDB's native hybrid search (like old code)
      // Single query combining vector + FTS with internal fusion
      const searchStart = enableMetrics ? Date.now() : 0;
      candidates = await withRetry(
        () =>
          this.store.nativeHybridSearch({
            queryText: query,
            queryVector,
            limit: config.rerankTopK,
            ftsColumn: Array.isArray(config.ftsColumns)
              ? config.ftsColumns[0]
              : config.ftsColumns,
            filter: lanceFilter,
          }),
        "nativeHybridSearch",
      );
      if (enableMetrics) {
        const elapsed = Date.now() - searchStart;
        metrics.vectorSearchMs = elapsed;
        metrics.ftsSearchMs = 0; // Combined in native mode
        metrics.fusionMs = 0;
      }
    } else {
      // Default: Separate searches + RRF fusion (more control)
      const vectorStart = enableMetrics ? Date.now() : 0;
      const vecPromise = withRetry(
        () =>
          this.store.vectorSearch({
            vector: queryVector,
            limit: config.vectorTopK,
            filter: lanceFilter,
          }),
        "vectorSearch",
      );

      const ftsStart = enableMetrics ? Date.now() : 0;
      const ftsPromise = withRetry(
        () =>
          this.store.fullTextSearch({
            query,
            limit: config.ftsTopK,
            ftsColumns: config.ftsColumns,
            filter: lanceFilter,
          }),
        "fullTextSearch",
      );

      const [vec, fts] = await Promise.all([vecPromise, ftsPromise]);
      if (enableMetrics) {
        metrics.vectorSearchMs = Date.now() - vectorStart;
        metrics.ftsSearchMs = Date.now() - ftsStart;
      }

      const fusionStart = enableMetrics ? Date.now() : 0;
      const fused = reciprocalRankFusion(vec, fts, config.rrfK);
      candidates = fused.slice(0, config.rerankTopK).map((r) => r.row);
      fused.forEach((r) => rrfScores.set(r.row.id, r.rrfScore));
      if (enableMetrics) metrics.fusionMs = Date.now() - fusionStart;
    }

    // Apply Jina reranking if available
    if (!this.reranker || candidates.length === 0) {
      if (enableMetrics) {
        metrics.rerankMs = 0;
        metrics.totalMs = Date.now() - startTime;
      }
      return candidates.map((row) => ({
        id: row.id,
        text: row.text,
        metadata: row.metadata,
        scores: { rrf: rrfScores.get(row.id) ?? 0 },
        metrics: enableMetrics ? (metrics as HybridSearchMetrics) : undefined,
      }));
    }

    const rerankStart = enableMetrics ? Date.now() : 0;
    const docs = candidates.map((r) => r.summaryForEmbedding || r.text);
    const rerank = await withRetry(
      () =>
        this.reranker!.rerank({
          query,
          documents: docs,
          topN: Math.min(docs.length, config.rerankTopK),
        }),
      "rerank",
    );
    if (enableMetrics) metrics.rerankMs = Date.now() - rerankStart;

    const jinaByIndex = new Map<number, number>();
    for (const r of rerank) jinaByIndex.set(r.index, r.score);

    const withJina = candidates.map((row, i) => ({
      row,
      jina: jinaByIndex.get(i),
      rrf: rrfScores.get(row.id) ?? 0,
    }));

    withJina.sort((a, b) => (b.jina ?? -Infinity) - (a.jina ?? -Infinity));

    if (enableMetrics) metrics.totalMs = Date.now() - startTime;

    return withJina.map((r) => ({
      id: r.row.id,
      text: r.row.text,
      metadata: r.row.metadata,
      scores: { rrf: r.rrf, jina: r.jina },
      metrics: enableMetrics ? (metrics as HybridSearchMetrics) : undefined,
    }));
  }

  /**
   * Convert HybridSearchFilter to LanceDB filter format.
   * Maps paragraphContentType and language to metadata field filters.
   */
  private buildLanceFilter(
    filter?: HybridSearchFilter,
  ): Record<string, string | number | boolean> | undefined {
    if (!filter) return undefined;

    const lanceFilter: Record<string, string | number | boolean> = {};

    if (filter.paragraphContentType) {
      // Note: LanceDB stores nested metadata as JSON, so we use the flattened field name
      // The field is stored at metadata.paragraphContentType but accessed via SQL-like syntax
      lanceFilter["metadata.paragraphContentType"] =
        filter.paragraphContentType;
    }

    if (filter.language) {
      lanceFilter["metadata.language"] = filter.language;
    }

    return Object.keys(lanceFilter).length > 0 ? lanceFilter : undefined;
  }
}

type RankedRow = { row: StoredChunkRow; rrfScore: number };

/**
 * Reciprocal Rank Fusion:
 *   score(d) = Σ_i 1 / (k + rank_i(d))
 *
 * This avoids brittle score normalization between dense distance and BM25 scores.
 */
export function reciprocalRankFusion(
  vec: StoredChunkRow[],
  fts: StoredChunkRow[],
  k: number,
): RankedRow[] {
  const scores = new Map<string, number>();
  const byId = new Map<string, StoredChunkRow>();

  const add = (rows: StoredChunkRow[]) => {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      byId.set(row.id, row);
      const prior = scores.get(row.id) ?? 0;
      scores.set(row.id, prior + 1 / (k + (i + 1)));
    }
  };

  add(vec);
  add(fts);

  const out: RankedRow[] = [];
  for (const [id, score] of scores.entries()) {
    const row = byId.get(id);
    if (!row) continue;
    out.push({ row, rrfScore: score });
  }

  out.sort((a, b) => b.rrfScore - a.rrfScore);
  return out;
}

