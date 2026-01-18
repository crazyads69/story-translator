import { z } from "zod";
import { ContentTypeSchema } from "./chunk";

export const ExtractedMetadataSchema = z.object({
  title: z.string().optional(),
  language: z.string().min(1).default("unknown"),
  contentType: ContentTypeSchema.default("unknown"),
  tags: z.array(z.string()).default([]),
  entities: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]), // Added for better FTS
  summaryForEmbedding: z.string().min(1),
  normalizedText: z.string().min(1),
});

export type ExtractedMetadata = z.infer<typeof ExtractedMetadataSchema>;

