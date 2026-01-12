import * as lancedb from "@lancedb/lancedb";
import type { Table, Connection } from "@lancedb/lancedb";
import type { ParagraphDocument } from "../interface";
import { JinaReranker, type JinaRerankerResult } from "../reranker";

/**
 * Search result with relevance score
 */
export interface SearchResult extends ParagraphDocument {
  _distance?: number; // Vector distance (lower is more similar)
  _relevance_score?: number; // Combined score for hybrid search
  _rerank_score?: number; // Jina reranker score (0-1, higher is better)
}

/**
 * Hybrid search options
 */
export interface HybridSearchOptions {
  limit?: number;
  filter?: Record<string, any>;
  // Full-text search column (defaults to paragraph_text)
  ftsColumn?: string;
  // Vector column name (defaults to vector)
  vectorColumn?: string;
  // Enable Jina reranking for improved relevance
  rerank?: boolean;
  // Number of candidates to fetch before reranking (should be > limit)
  rerankCandidates?: number;
}

/**
 * Reranker configuration options
 */
export interface RerankerOptions {
  apiKey?: string;
  model?: "jina-reranker-v2-base-multilingual" | "jina-reranker-v1-base-en" | "jina-reranker-v1-turbo-en" | "jina-reranker-v1-tiny-en" | "jina-reranker-v3";
}

export class LanceDBVectorStore {
  private db: Connection | null = null;
  private tableName: string;
  private dbPath: string;
  private ftsIndexCreated: boolean = false;
  private reranker: JinaReranker | null = null;

  constructor(dbPath: string, tableName: string = "story_chapters") {
    this.dbPath = dbPath;
    this.tableName = tableName;
  }

  /**
   * Initialize Jina Reranker for enhanced search
   * Call this method to enable reranking in hybrid search
   */
  initReranker(options?: RerankerOptions): void {
    const apiKey = options?.apiKey || process.env.JINA_API_KEY;
    
    if (!apiKey) {
      throw new Error(
        "Jina API key is required. Set JINA_API_KEY env variable or pass apiKey in options."
      );
    }

    this.reranker = new JinaReranker({
      apiKey,
      model: options?.model || "jina-reranker-v2-base-multilingual",
    });
    console.log("✓ Jina Reranker initialized");
  }

  /**
   * Check if reranker is available
   */
  hasReranker(): boolean {
    return this.reranker !== null;
  }

  /**
   * Connect to LanceDB
   * Creates database directory if it doesn't exist
   */
  async connect(): Promise<void> {
    console.log(`Connecting to LanceDB at: ${this.dbPath}`);
    this.db = await lancedb.connect(this.dbPath);
    console.log("✓ Connected to LanceDB");
  }

  /**
   * Ensure database is connected
   */
  private ensureConnected(): Connection {
    if (!this.db) {
      throw new Error("Database not connected. Call connect() first.");
    }
    return this.db;
  }

  /**
   * Create table if it doesn't exist
   * Based on LanceDB docs schema definition
   */
  async ensureTable(): Promise<Table | null> {
    const db = this.ensureConnected();
    try {
      const table = await db.openTable(this.tableName);
      console.log(`✓ Using existing table: ${this.tableName}`);
      return table;
    } catch (error) {
      console.log(`Table '${this.tableName}' will be created on first insert`);
      return null;
    }
  }

  /**
   * Create Full-Text Search index on paragraph_text column
   * Required for hybrid search functionality
   */
  async createFTSIndex(column: string = "paragraph_text"): Promise<void> {
    const db = this.ensureConnected();
    try {
      const table = await db.openTable(this.tableName);
      await table.createIndex(column, {
        config: lancedb.Index.fts(),
      });
      this.ftsIndexCreated = true;
      console.log(`✓ Created FTS index on column: ${column}`);
    } catch (error: any) {
      // Index might already exist
      if (error.message?.includes("already exists")) {
        this.ftsIndexCreated = true;
        console.log(`FTS index already exists on column: ${column}`);
      } else {
        console.error("Error creating FTS index:", error);
        throw error;
      }
    }
  }

  /**
   * Create vector index for faster similarity search
   * Recommended for large datasets (> 10k rows)
   */
  async createVectorIndex(
    column: string = "vector",
    options?: {
      numPartitions?: number;
      numSubVectors?: number;
      distanceType?: "l2" | "cosine" | "dot";
    }
  ): Promise<void> {
    const db = this.ensureConnected();
    try {
      const table = await db.openTable(this.tableName);
      await table.createIndex(column, {
        config: lancedb.Index.ivfPq({
          numPartitions: options?.numPartitions ?? 256,
          numSubVectors: options?.numSubVectors ?? 16,
          distanceType: options?.distanceType ?? "cosine",
        }),
      });
      console.log(`✓ Created vector index on column: ${column}`);
    } catch (error: any) {
      if (error.message?.includes("already exists")) {
        console.log(`Vector index already exists on column: ${column}`);
      } else {
        console.error("Error creating vector index:", error);
        throw error;
      }
    }
  }

  /**
   * Insert a single paragraph document
   */
  async insertParagraph(doc: ParagraphDocument): Promise<void> {
    const db = this.ensureConnected();
    try {
      const table = await db.openTable(this.tableName);
      await table.add([doc]);
    } catch (error: any) {
      if (error.message?.includes("not found") || error.message?.includes("does not exist")) {
        await db.createTable(this.tableName, [doc]);
      } else {
        throw error;
      }
    }
  }

  /**
   * Insert multiple paragraph documents in batch
   * More efficient for bulk inserts
   */
  async insertBatch(docs: ParagraphDocument[]): Promise<void> {
    if (docs.length === 0) {
      return;
    }

    const db = this.ensureConnected();
    try {
      const table = await db.openTable(this.tableName);
      await table.add(docs);
      console.log(`    ✓ Inserted ${docs.length} paragraphs in batch`);
    } catch (error: any) {
      if (error.message?.includes("not found") || error.message?.includes("does not exist")) {
        await db.createTable(this.tableName, docs);
        console.log(`    ✓ Created table and inserted ${docs.length} paragraphs`);
      } else {
        throw error;
      }
    }
  }

  /**
   * Build WHERE clause from filter object
   */
  private buildWhereClause(filter: Record<string, any>): string {
    return Object.entries(filter)
      .map(([key, value]) => {
        if (typeof value === "string") {
          return `${key} = '${value}'`;
        } else if (typeof value === "number") {
          return `${key} = ${value}`;
        } else if (typeof value === "boolean") {
          return `${key} = ${value}`;
        } else {
          return `${key} = '${String(value)}'`;
        }
      })
      .join(" AND ");
  }

  /**
   * Vector similarity search
   * Returns top K most similar documents by vector distance
   */
  async searchByVector(
    queryVector: number[],
    limit: number = 5,
    filter?: Record<string, any>
  ): Promise<SearchResult[]> {
    const db = this.ensureConnected();
    const table = await db.openTable(this.tableName);

    let query = table.search(queryVector).limit(limit);

    if (filter) {
      const whereClause = this.buildWhereClause(filter);
      if (whereClause) {
        query = query.where(whereClause);
      }
    }

    const results = await query.toArray();
    return results as SearchResult[];
  }

  /**
   * Full-text search on paragraph_text
   * Returns documents matching the text query
   */
  async searchByText(
    queryText: string,
    limit: number = 5,
    filter?: Record<string, any>,
    column: string = "paragraph_text"
  ): Promise<SearchResult[]> {
    const db = this.ensureConnected();
    const table = await db.openTable(this.tableName);

    let query = table
      .query()
      .nearestToText(queryText, [column])
      .limit(limit);

    if (filter) {
      const whereClause = this.buildWhereClause(filter);
      if (whereClause) {
        query = query.where(whereClause);
      }
    }

    const results = await query.toArray();
    return results as SearchResult[];
  }

  /**
   * Hybrid search combining vector similarity + full-text search
   * Best for finding contextually relevant paragraphs for translation enrichment
   * 
   * This method combines:
   * 1. Vector similarity (semantic meaning)
   * 2. Full-text search (keyword matching)
   * 3. Optional: Jina AI reranking for improved relevance
   * 
   * @param queryText - Text to search for (used for both FTS and embedding)
   * @param queryVector - Pre-computed embedding vector for the query
   * @param options - Search options including limit and filters
   */
  async hybridSearch(
    queryText: string,
    queryVector: number[],
    options: HybridSearchOptions = {}
  ): Promise<SearchResult[]> {
    const db = this.ensureConnected();
    const table = await db.openTable(this.tableName);

    const {
      limit = 10,
      filter,
      ftsColumn = "paragraph_text",
      rerank = false,
      rerankCandidates = Math.max(limit * 3, 20), // Fetch more candidates for reranking
    } = options;

    // Determine how many results to fetch
    const fetchLimit = rerank && this.reranker ? rerankCandidates : limit;

    // Perform hybrid search combining text and vector
    let query = table
      .query()
      .nearestToText(queryText, [ftsColumn])
      .nearestTo(queryVector)
      .limit(fetchLimit);

    if (filter) {
      const whereClause = this.buildWhereClause(filter);
      if (whereClause) {
        query = query.where(whereClause);
      }
    }

    const results = (await query.toArray()) as SearchResult[];

    // Apply Jina reranking if enabled
    if (rerank && this.reranker && results.length > 0) {
      return this.applyReranking(queryText, results, limit);
    }

    return results;
  }

  /**
   * Apply Jina AI reranking to search results
   * Reorders results based on neural relevance scoring
   */
  private async applyReranking(
    query: string,
    results: SearchResult[],
    limit: number
  ): Promise<SearchResult[]> {
    if (!this.reranker) {
      return results.slice(0, limit);
    }

    try {
      // Extract text content for reranking
      const documents = results.map((r) => r.paragraph_text || "");

      // Get reranked results from Jina
      const rerankedResults = await this.reranker.rerank(query, documents, limit);

      // Map reranked results back to original documents with scores
      const rerankedDocs = rerankedResults.map((r: JinaRerankerResult) => {
        const originalDoc = results[r.index]!;
        return {
          ...originalDoc,
          _rerank_score: r.relevance_score,
        } as SearchResult;
      });

      console.log(`    ✓ Reranked ${results.length} → ${rerankedDocs.length} results`);
      return rerankedDocs;
    } catch (error) {
      console.error("Reranking failed, returning original results:", error);
      return results.slice(0, limit);
    }
  }

  /**
   * Enhanced hybrid search with Jina reranking (convenience method)
   * Automatically enables reranking if reranker is initialized
   * 
   * @param queryText - Search query text
   * @param queryVector - Query embedding vector
   * @param limit - Number of results to return
   * @param filter - Optional filter criteria
   */
  async hybridSearchWithRerank(
    queryText: string,
    queryVector: number[],
    limit: number = 10,
    filter?: Record<string, any>
  ): Promise<SearchResult[]> {
    if (!this.reranker) {
      console.warn("Reranker not initialized. Call initReranker() first. Falling back to standard hybrid search.");
      return this.hybridSearch(queryText, queryVector, { limit, filter });
    }

    return this.hybridSearch(queryText, queryVector, {
      limit,
      filter,
      rerank: true,
      rerankCandidates: Math.max(limit * 3, 30),
    });
  }

  /**
   * Standalone rerank method for custom use cases
   * Rerank any array of documents against a query
   */
  async rerankDocuments(
    query: string,
    documents: string[],
    topN?: number
  ): Promise<JinaRerankerResult[]> {
    if (!this.reranker) {
      throw new Error("Reranker not initialized. Call initReranker() first.");
    }

    return this.reranker.rerank(query, documents, topN);
  }

  /**
   * Search for similar paragraphs - alias for searchByVector for backward compatibility
   */
  async searchSimilar(
    queryVector: number[],
    limit: number = 5,
    filter?: Record<string, any>
  ): Promise<ParagraphDocument[]> {
    return this.searchByVector(queryVector, limit, filter);
  }

  /**
   * Get all documents with optional filtering
   */
  async getAllDocuments(filter?: Record<string, any>): Promise<ParagraphDocument[]> {
    const db = this.ensureConnected();
    const table = await db.openTable(this.tableName);

    let query = table.query();

    if (filter) {
      const whereClause = this.buildWhereClause(filter);
      if (whereClause) {
        query = query.where(whereClause);
      }
    }

    const results = await query.toArray();
    return results as ParagraphDocument[];
  }

  /**
   * Get document by ID
   */
  async getDocumentById(id: string): Promise<ParagraphDocument | null> {
    const db = this.ensureConnected();
    try {
      const table = await db.openTable(this.tableName);
      const results = await table
        .query()
        .where(`id = '${id}'`)
        .limit(1)
        .toArray();

      if (results.length > 0) {
        return results[0] as ParagraphDocument;
      }
      return null;
    } catch (error) {
      console.error(`Error getting document ${id}:`, error);
      return null;
    }
  }

  /**
   * Delete documents by filter
   */
  async deleteDocuments(filter: Record<string, any>): Promise<void> {
    const db = this.ensureConnected();
    const table = await db.openTable(this.tableName);

    const whereClause = this.buildWhereClause(filter);

    if (!whereClause) {
      throw new Error("Filter is required for deletion");
    }

    await table.delete(whereClause);
    console.log(`✓ Deleted documents matching: ${whereClause}`);
  }

  /**
   * Count rows in the table
   */
  async countRows(filter?: string): Promise<number> {
    const db = this.ensureConnected();
    const table = await db.openTable(this.tableName);
    return table.countRows(filter);
  }

  /**
   * Get table statistics
   */
  async getStats(): Promise<{
    total_documents: number;
    by_type: Record<string, number>;
    by_language: Record<string, number>;
  }> {
    try {
      const db = this.ensureConnected();
      const table = await db.openTable(this.tableName);
      const allDocs = await table.query().toArray();

      const stats = {
        total_documents: allDocs.length,
        by_type: {} as Record<string, number>,
        by_language: {} as Record<string, number>,
      };

      allDocs.forEach((doc: any) => {
        const type = doc.content_type || "unknown";
        stats.by_type[type] = (stats.by_type[type] || 0) + 1;

        const lang = doc.language || "unknown";
        stats.by_language[lang] = (stats.by_language[lang] || 0) + 1;
      });

      return stats;
    } catch (error) {
      return {
        total_documents: 0,
        by_type: {},
        by_language: {},
      };
    }
  }

  /**
   * Optimize table for better performance
   * Compacts fragments and indexes all data
   */
  async optimize(): Promise<void> {
    const db = this.ensureConnected();
    const table = await db.openTable(this.tableName);
    const stats = await table.optimize();
    console.log(`✓ Optimized table:`, stats);
  }

  /**
   * Drop the entire table (use with caution!)
   */
  async dropTable(): Promise<void> {
    const db = this.ensureConnected();
    try {
      await db.dropTable(this.tableName);
      console.log(`✓ Dropped table: ${this.tableName}`);
    } catch (error) {
      console.error("Error dropping table:", error);
    }
  }

  /**
   * List all available indexes on the table
   */
  async listIndexes(): Promise<any[]> {
    const db = this.ensureConnected();
    const table = await db.openTable(this.tableName);
    return table.listIndices();
  }
}

/**
 * Create LanceDB service from environment variables
 * Optionally initializes Jina reranker if JINA_API_KEY is available
 */
export function createLanceDBService(options?: {
  initReranker?: boolean;
  rerankerModel?: "jina-reranker-v2-base-multilingual" | "jina-reranker-v1-base-en" | "jina-reranker-v1-turbo-en" | "jina-reranker-v1-tiny-en" | "jina-reranker-v3";
}): LanceDBVectorStore {
  const dbPath = process.env.LANCEDB_PATH || "./lancedb";
  const tableName = process.env.LANCEDB_TABLE_NAME || "story_chapters";

  const store = new LanceDBVectorStore(dbPath, tableName);

  // Initialize reranker if requested and API key is available
  if (options?.initReranker !== false && process.env.JINA_API_KEY) {
    try {
      store.initReranker({ model: options?.rerankerModel  });
    } catch (error) {
      console.warn("Failed to initialize reranker:", error);
    }
  }

  return store;
}
