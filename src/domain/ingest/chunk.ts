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

/**
 * Differentiates original content from translated content.
 * Used for bilingual story ingestion (like old_code.md pattern).
 */
export const ParagraphContentTypeSchema = z.enum(["original", "translated"]);
export type ParagraphContentType = z.infer<typeof ParagraphContentTypeSchema>;

export const ChunkMetadataSchema = z.object({
  sourceType: SourceTypeSchema,
  sourceId: z.string().min(1),
  sourceUri: z.string().min(1),
  contentType: ContentTypeSchema,
  /** Whether this is original or translated content (for bilingual stories) */
  paragraphContentType: ParagraphContentTypeSchema.optional(),
  language: z.string().min(1).default("unknown"),
  title: z.string().optional(),
  sectionPath: z.array(z.string()).default([]),
  chunkIndex: z.number().int().min(0),
  /** Total paragraphs in the source document */
  totalParagraphs: z.number().int().min(0).optional(),
  /** Whether this chunk has previous context (for context window) */
  hasPrevContext: z.boolean().optional(),
  /** Whether this chunk has next context (for context window) */
  hasNextContext: z.boolean().optional(),
  /** Whether this is a grouped chunk (multiple short paragraphs combined) */
  isGrouped: z.boolean().optional(),
  /** Number of paragraphs in this group */
  groupSize: z.number().int().min(1).optional(),
  /** All paragraph indices included in this chunk */
  groupIndices: z.array(z.number().int().min(0)).optional(),
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

