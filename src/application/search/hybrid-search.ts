import type { StoredChunkRow } from "../../domain/ingest/chunk";
import type { OpenRouterEmbeddings } from "../../infrastructure/embeddings/openrouter";
import type { LanceDbChunkStore } from "../../infrastructure/vectordb/lancedb";
import type { JinaRerankerClient } from "../../infrastructure/rerank/jina";

export type HybridSearchConfig = {
  vectorTopK: number;
  ftsTopK: number;
  rrfK: number;
  rerankTopK: number;
  ftsColumns?: string | string[];
};

export type HybridSearchResult = {
  id: string;
  text: string;
  metadata: StoredChunkRow["metadata"];
  scores: {
    rrf: number;
    jina?: number;
  };
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
    const [queryVector] = await this.embeddings.embedBatch([query]);

    const [vec, fts] = await Promise.all([
      this.store.vectorSearch({ vector: queryVector!, limit: config.vectorTopK }),
      this.store.fullTextSearch({
        query,
        limit: config.ftsTopK,
        ftsColumns: config.ftsColumns,
      }),
    ]);

    const fused = reciprocalRankFusion(vec, fts, config.rrfK);
    const top = fused.slice(0, config.rerankTopK);

    if (!this.reranker) {
      return top.map((r) => ({
        id: r.row.id,
        text: r.row.text,
        metadata: r.row.metadata,
        scores: { rrf: r.rrfScore },
      }));
    }

    const docs = top.map((r) => r.row.summaryForEmbedding || r.row.text);
    const rerank = await this.reranker.rerank({
      query,
      documents: docs,
      topN: Math.min(docs.length, config.rerankTopK),
    });

    const jinaByIndex = new Map<number, number>();
    for (const r of rerank) jinaByIndex.set(r.index, r.score);

    const withJina = top.map((r, i) => ({
      row: r.row,
      rrfScore: r.rrfScore,
      jina: jinaByIndex.get(i),
    }));

    withJina.sort((a, b) => (b.jina ?? -Infinity) - (a.jina ?? -Infinity));

    return withJina.map((r) => ({
      id: r.row.id,
      text: r.row.text,
      metadata: r.row.metadata,
      scores: { rrf: r.rrfScore, jina: r.jina },
    }));
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

