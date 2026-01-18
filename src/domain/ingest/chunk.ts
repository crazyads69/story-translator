import { z } from "zod";

export const SourceTypeSchema = z.enum(["file", "url", "web_research"]);
export type SourceType = z.infer<typeof SourceTypeSchema>;

export const ContentTypeSchema = z.enum([
  "markdown",
  "pdf",
  "text",
  "html",
  "unknown",
]);
export type ContentType = z.infer<typeof ContentTypeSchema>;

export const ChunkMetadataSchema = z.object({
  sourceType: SourceTypeSchema,
  sourceId: z.string().min(1),
  sourceUri: z.string().min(1),
  contentType: ContentTypeSchema,
  language: z.string().min(1).default("unknown"),
  title: z.string().optional(),
  sectionPath: z.array(z.string()).default([]),
  chunkIndex: z.number().int().min(0),
  createdAtMs: z.number().int().min(0),
  version: z.string().min(1).default("v1"),
  hash: z.string().min(1),
});

export type ChunkMetadata = z.infer<typeof ChunkMetadataSchema>;

export const ChunkDocumentSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  normalizedText: z.string().min(1),
  summaryForEmbedding: z.string().min(1),
  vector: z.array(z.number()),
  metadata: ChunkMetadataSchema,
});

export type ChunkDocument = z.infer<typeof ChunkDocumentSchema>;

export type StoredChunkRow = Omit<ChunkDocument, "metadata"> & {
  metadata: ChunkMetadata;
  _rowid?: number;
  _distance?: number;
  _score?: number;
};

