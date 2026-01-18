import { Document } from "@langchain/core/documents";
import { BaseRetriever } from "@langchain/core/retrievers";
import type { CallbackManagerForRetrieverRun } from "@langchain/core/callbacks/manager";
import type { HybridSearchService, HybridSearchConfig } from "./hybrid-search";

export type LanceDbHybridRetrieverOptions = {
  search: HybridSearchService;
  config: HybridSearchConfig;
};

/**
 * LangChain Retriever backed by:
 * - LanceDB vector search
 * - LanceDB FTS (BM25)
 * - Optional Jina reranking
 *
 * This retriever returns LangChain Documents with chunk text and metadata
 * suitable for downstream RAG chains.
 */
export class LanceDbHybridRetriever extends BaseRetriever {
  lc_namespace = ["story-trans", "retrievers", "lancedb-hybrid"];
  private readonly search: HybridSearchService;
  private readonly config: HybridSearchConfig;

  constructor(options: LanceDbHybridRetrieverOptions) {
    super({});
    this.search = options.search;
    this.config = options.config;
  }

  override async _getRelevantDocuments(
    query: string,
    _callbacks?: CallbackManagerForRetrieverRun,
  ): Promise<Document[]> {
    const results = await this.search.search(query, this.config);
    return results.map(
      (r) =>
        new Document({
          pageContent: r.text,
          metadata: {
            ...r.metadata,
            scores: r.scores,
          },
        }),
    );
  }
}
