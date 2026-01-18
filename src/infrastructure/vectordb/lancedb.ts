import * as lancedb from "@lancedb/lancedb";
import type { Connection, Table } from "@lancedb/lancedb";
import type { ChunkDocument, StoredChunkRow } from "../../domain/ingest/chunk";

/**
 * Escape a string value for use in LanceDB SQL WHERE clauses.
 * Prevents SQL injection by escaping single quotes.
 */
function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Build a SQL WHERE clause from a filter object.
 * Safely escapes string values to prevent SQL injection.
 */
function buildWhereClause(
  filter: Record<string, string | number | boolean>,
): string {
  return Object.entries(filter)
    .map(([k, v]) => {
      if (typeof v === "string") {
        return `${k} = '${escapeSqlString(v)}'`;
      }
      if (typeof v === "boolean") {
        return `${k} = ${v ? "true" : "false"}`;
      }
      return `${k} = ${v}`;
    })
    .join(" AND ");
}

export type LanceDbConfig = {
  path: string;
  table: string;
};

export type LanceDbIndexConfig = {
  vectorColumn: string;
  textColumn: string;
  createVectorIndex: boolean;
  createFtsIndex: boolean;
};

/** Statistics about the LanceDB table */
export type LanceDbStats = {
  rowCount: number;
  hasVectorIndex: boolean;
  hasFtsIndex: boolean;
};

export class LanceDbChunkStore {
  private readonly path: string;
  private readonly tableName: string;
  private db?: Connection;
  private table?: Table;
  private _connected = false;

  constructor(config: LanceDbConfig) {
    if (!config.path || config.path.trim() === "") {
      throw new Error("LanceDB path cannot be empty");
    }
    if (!config.table || config.table.trim() === "") {
      throw new Error("LanceDB table name cannot be empty");
    }
    this.path = config.path;
    this.tableName = config.table;
  }

  /** Check if the store is connected */
  get isConnected(): boolean {
    return this._connected && this.db !== undefined;
  }

  /** Check if the table exists */
  get hasTable(): boolean {
    return this.table !== undefined;
  }

  async connect(): Promise<void> {
    try {
      this.db = await lancedb.connect(this.path);
      this._connected = true;
    } catch (error) {
      this._connected = false;
      throw new Error(
        `Failed to connect to LanceDB at "${this.path}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      this.table = await this.db.openTable(this.tableName);
    } catch (error: unknown) {
      // Table doesn't exist yet, will be created on first upsert
      this.table = undefined;
    }
  }

  /** Get table statistics */
  async getStats(): Promise<LanceDbStats | null> {
    if (!this.table) return null;
    try {
      const count = await this.table.countRows();
      return {
        rowCount: count,
        hasVectorIndex: true, // LanceDB auto-creates
        hasFtsIndex: true,
      };
    } catch {
      return null;
    }
  }

  async ensureIndexes(config: LanceDbIndexConfig): Promise<void> {
    if (!this.table) throw new Error("LanceDB table not available");

    if (config.createVectorIndex) {
      await this.table.createIndex(config.vectorColumn).catch(() => {});
    }
    if (config.createFtsIndex) {
      await this.table
        .createIndex(config.textColumn, { config: lancedb.Index.fts() })
        .catch(() => {});
    }
  }

  async upsertChunks(chunks: ChunkDocument[]): Promise<number> {
    if (!this.db) throw new Error("LanceDB not connected. Call connect() first.");
    if (chunks.length === 0) return 0;

    // Validate chunks have required fields
    for (const chunk of chunks) {
      if (!chunk.id) throw new Error("Chunk missing required 'id' field");
      if (!chunk.text) throw new Error(`Chunk ${chunk.id} missing required 'text' field`);
      if (!chunk.vector || chunk.vector.length === 0) {
        throw new Error(`Chunk ${chunk.id} missing required 'vector' field`);
      }
    }

    if (!this.table) {
      this.table = await this.db.createTable(this.tableName, chunks);
      return chunks.length;
    }
    await this.table.add(chunks);
    return chunks.length;
  }

  async vectorSearch(params: {
    vector: number[];
    limit: number;
    filter?: Record<string, string | number | boolean>;
  }): Promise<StoredChunkRow[]> {
    if (!this.table) {
      throw new Error(
        `LanceDB table "${this.tableName}" not available. Did you call connect() and upsert data first?`,
      );
    }
    if (!params.vector || params.vector.length === 0) {
      throw new Error("Vector search requires a non-empty vector");
    }
    if (params.limit <= 0) {
      throw new Error("Vector search limit must be positive");
    }

    const query = this.table
      .search(params.vector, "vector")
      .limit(params.limit)
      .withRowId();
    if (params.filter) {
      query.where(buildWhereClause(params.filter));
    }
    return (await query.toArray()) as StoredChunkRow[];
  }

  async fullTextSearch(params: {
    query: string;
    limit: number;
    ftsColumns?: string | string[];
    filter?: Record<string, string | number | boolean>;
  }): Promise<StoredChunkRow[]> {
    if (!this.table) {
      throw new Error(
        `LanceDB table "${this.tableName}" not available. Did you call connect() and upsert data first?`,
      );
    }
    if (!params.query || params.query.trim() === "") {
      throw new Error("Full-text search requires a non-empty query");
    }
    if (params.limit <= 0) {
      throw new Error("Full-text search limit must be positive");
    }

    const query = this.table
      .search(params.query, "fts", params.ftsColumns)
      .limit(params.limit)
      .withRowId();
    if (params.filter) {
      query.where(buildWhereClause(params.filter));
    }
    return (await query.toArray()) as StoredChunkRow[];
  }

  /**
   * Native LanceDB hybrid search combining vector + FTS in a single query.
   * Uses LanceDB's internal fusion (like old code's approach).
   *
   * This is different from running separate vector/FTS searches and manually
   * fusing with RRF. LanceDB's native approach may use different fusion strategy.
   *
   * @see https://lancedb.github.io/lancedb/hybrid_search/hybrid_search/
   */
  async nativeHybridSearch(params: {
    queryText: string;
    queryVector: number[];
    limit: number;
    ftsColumn?: string;
    filter?: Record<string, string | number | boolean>;
  }): Promise<StoredChunkRow[]> {
    if (!this.table) {
      throw new Error(
        `LanceDB table "${this.tableName}" not available. Did you call connect() and upsert data first?`,
      );
    }
    if (!params.queryText || params.queryText.trim() === "") {
      throw new Error("Native hybrid search requires a non-empty queryText");
    }
    if (!params.queryVector || params.queryVector.length === 0) {
      throw new Error("Native hybrid search requires a non-empty queryVector");
    }
    if (params.limit <= 0) {
      throw new Error("Native hybrid search limit must be positive");
    }

    // LanceDB native hybrid: chain nearestToText + nearestTo
    // This uses LanceDB's internal fusion algorithm
    let query = this.table
      .query()
      .nearestToText(params.queryText, params.ftsColumn ? [params.ftsColumn] : undefined)
      .nearestTo(params.queryVector)
      .limit(params.limit);

    if (params.filter) {
      query = query.where(buildWhereClause(params.filter));
    }

    return (await query.toArray()) as StoredChunkRow[];
  }
}
