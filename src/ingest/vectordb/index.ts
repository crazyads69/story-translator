import * as lancedb from "@lancedb/lancedb";
import type { Table, Connection } from "@lancedb/lancedb";
import type { ParagraphDocument } from "../interface";

/**
 * Search result with relevance score
 */
export interface SearchResult extends ParagraphDocument {
  _distance?: number; // Vector distance (lower is more similar)
  _relevance_score?: number; // Combined score for hybrid search
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
}

export class LanceDBVectorStore {
  private db: Connection | null = null;
  private tableName: string;
  private dbPath: string;
  private ftsIndexCreated: boolean = false;

  constructor(dbPath: string, tableName: string = "story_chapters") {
    this.dbPath = dbPath;
    this.tableName = tableName;
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
    } = options;

    // Perform hybrid search combining text and vector
    let query = table
      .query()
      .nearestToText(queryText, [ftsColumn])
      .nearestTo(queryVector)
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
 */
export function createLanceDBService(): LanceDBVectorStore {
  const dbPath = process.env.LANCEDB_PATH || "./lancedb";
  const tableName = process.env.LANCEDB_TABLE_NAME || "story_chapters";

  return new LanceDBVectorStore(dbPath, tableName);
}
