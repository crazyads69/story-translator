/**
 * Jina AI Reranker Service
 * Enhances hybrid search results by reranking documents based on query relevance
 * 
 * API Documentation: https://jina.ai/reranker/
 * Endpoint: https://api.jina.ai/v1/rerank
 */

export interface JinaRerankerConfig {
  apiKey: string;
  model?: JinaRerankerModel;
  baseUrl?: string;
}

/**
 * Available Jina Reranker models
 * - jina-reranker-v2-base-multilingual: Best for multilingual retrieval (100+ languages)
 * - jina-reranker-v1-base-en: English only, legacy
 * - jina-reranker-v1-turbo-en: Fast English reranking
 * - jina-reranker-v1-tiny-en: Smallest, fastest English model
 */
export type JinaRerankerModel =
  | "jina-reranker-v2-base-multilingual"
  | "jina-reranker-v1-base-en"
  | "jina-reranker-v1-turbo-en"
  | "jina-reranker-v1-tiny-en"
    | "jina-reranker-v3";

/**
 * Request payload for Jina Reranker API
 */
export interface JinaRerankerRequest {
  /** The search query to rank documents against */
  query: string;
  /** Array of documents to rerank (strings or objects with text field) */
  documents: string[] | { text: string }[];
  /** Model to use for reranking */
  model?: JinaRerankerModel;
  /** Maximum number of top-ranked documents to return */
  top_n?: number;
  /** Whether to return document content in response */
  return_documents?: boolean;
}

/**
 * Single result from reranking
 */
export interface JinaRerankerResult {
  /** Original index of the document in input array */
  index: number;
  /** Relevance score (0-1, higher is more relevant) */
  relevance_score: number;
  /** Document content (if return_documents=true) */
  document?: {
    text: string;
  };
}

/**
 * Response from Jina Reranker API
 */
export interface JinaRerankerResponse {
  model: string;
  usage: {
    total_tokens: number;
    prompt_tokens?: number;
  };
  results: JinaRerankerResult[];
}

/**
 * Error response from Jina API
 */
export interface JinaAPIError {
  detail?: string;
  message?: string;
}

/**
 * Jina AI Reranker Service
 * 
 * Reranks search results to improve relevance using Jina AI's neural reranker.
 * Best used after initial retrieval from vector search or hybrid search.
 * 
 * @example
 * ```typescript
 * const reranker = new JinaReranker({ apiKey: 'your-api-key' });
 * 
 * const documents = [
 *   "Document about cats and dogs",
 *   "Document about machine learning",
 *   "Document about pets and animals"
 * ];
 * 
 * const results = await reranker.rerank("What pets are popular?", documents, 2);
 * // Returns top 2 most relevant documents
 * ```
 */
export class JinaReranker {
  private apiKey: string;
  private model: JinaRerankerModel;
  private baseUrl: string;

  constructor(config: JinaRerankerConfig) {
    if (!config.apiKey) {
      throw new Error("Jina API key is required");
    }

    this.apiKey = config.apiKey;
    this.model = config.model || "jina-reranker-v2-base-multilingual";
    this.baseUrl = config.baseUrl || "https://api.jina.ai/v1/rerank";
  }

  /**
   * Rerank documents based on query relevance
   * 
   * @param query - The search query
   * @param documents - Array of document strings or objects
   * @param topN - Number of top results to return (default: all)
   * @param returnDocuments - Whether to include document content in response
   * @returns Reranked results with scores
   */
  async rerank(
    query: string,
    documents: string[] | { text: string }[],
    topN?: number,
    returnDocuments: boolean = true
  ): Promise<JinaRerankerResult[]> {
    if (!documents || documents.length === 0) {
      return [];
    }

    // Validate inputs
    if (!query || query.trim() === "") {
      throw new Error("Query cannot be empty");
    }

    const requestBody: JinaRerankerRequest = {
      query,
      documents,
      model: this.model,
      return_documents: returnDocuments,
    };

    if (topN !== undefined && topN > 0) {
      requestBody.top_n = topN;
    }

    try {
      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as JinaAPIError;
        const errorMessage = errorData.detail || errorData.message || `HTTP ${response.status}`;
        throw new Error(`Jina Reranker API error: ${errorMessage}`);
      }

      const data = await response.json() as JinaRerankerResponse;
      return data.results;
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Failed to rerank documents: ${String(error)}`);
    }
  }

  /**
   * Rerank with full response including usage stats
   */
  async rerankWithUsage(
    query: string,
    documents: string[] | { text: string }[],
    topN?: number
  ): Promise<JinaRerankerResponse> {
    if (!documents || documents.length === 0) {
      return {
        model: this.model,
        usage: { total_tokens: 0 },
        results: [],
      };
    }

    const requestBody: JinaRerankerRequest = {
      query,
      documents,
      model: this.model,
      top_n: topN,
      return_documents: true,
    };

    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as JinaAPIError;
      throw new Error(`Jina Reranker API error: ${errorData.detail || response.statusText}`);
    }

    return response.json() as Promise<JinaRerankerResponse>;
  }

  /**
   * Change the reranker model
   */
  setModel(model: JinaRerankerModel): void {
    this.model = model;
  }

  /**
   * Get current model being used
   */
  getModel(): JinaRerankerModel {
    return this.model;
  }
}

/**
 * Create Jina Reranker from environment variable
 */
export function createJinaReranker(
  model?: JinaRerankerModel
): JinaReranker {
  const apiKey = process.env.JINA_API_KEY;

  if (!apiKey) {
    throw new Error(
      "JINA_API_KEY environment variable is required. " +
      "Get your API key from https://jina.ai/reranker/"
    );
  }

  return new JinaReranker({
    apiKey,
    model,
  });
}
