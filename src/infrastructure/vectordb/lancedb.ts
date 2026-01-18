import * as lancedb from "@lancedb/lancedb";
import type { Connection, Table } from "@lancedb/lancedb";
import type { ChunkDocument, StoredChunkRow } from "../../domain/ingest/chunk";

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

export class LanceDbChunkStore {
  private readonly path: string;
  private readonly tableName: string;
  private db?: Connection;
  private table?: Table;

  constructor(config: LanceDbConfig) {
    this.path = config.path;
    this.tableName = config.table;
  }

  async connect(): Promise<void> {
    this.db = await lancedb.connect(this.path);
    try {
      this.table = await this.db.openTable(this.tableName);
    } catch (error: unknown) {
      this.table = undefined;
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

  async upsertChunks(chunks: ChunkDocument[]): Promise<void> {
    if (!this.db) throw new Error("LanceDB not connected");
    if (chunks.length === 0) return;
    if (!this.table) {
      this.table = await this.db.createTable(this.tableName, chunks);
      return;
    }
    await this.table.add(chunks);
  }

  async vectorSearch(params: {
    vector: number[];
    limit: number;
    filter?: Record<string, string | number | boolean>;
  }): Promise<StoredChunkRow[]> {
    if (!this.table) throw new Error("LanceDB table not available");
    const query = this.table
      .search(params.vector, "vector")
      .limit(params.limit)
      .withRowId();
    if (params.filter) {
      const where = Object.entries(params.filter)
        .map(([k, v]) =>
          typeof v === "string" ? `${k} = '${v}'` : `${k} = ${v}`,
        )
        .join(" AND ");
      query.where(where);
    }
    return (await query.toArray()) as StoredChunkRow[];
  }

  async fullTextSearch(params: {
    query: string;
    limit: number;
    ftsColumns?: string | string[];
    filter?: Record<string, string | number | boolean>;
  }): Promise<StoredChunkRow[]> {
    if (!this.table) throw new Error("LanceDB table not available");
    const query = this.table
      .search(params.query, "fts", params.ftsColumns)
      .limit(params.limit)
      .withRowId();
    if (params.filter) {
      const where = Object.entries(params.filter)
        .map(([k, v]) =>
          typeof v === "string" ? `${k} = '${v}'` : `${k} = ${v}`,
        )
        .join(" AND ");
      query.where(where);
    }
    return (await query.toArray()) as StoredChunkRow[];
  }
}
