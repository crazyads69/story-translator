import { z } from "zod";
import { SourceTypeSchema } from "./chunk";

export const IngestSourceSchema = z.object({
  type: SourceTypeSchema,
  uri: z.string().min(1),
});

export type IngestSource = z.infer<typeof IngestSourceSchema>;

export const IngestRequestSchema = z.object({
  sources: z.array(IngestSourceSchema).min(1),
  mode: z.enum(["vector", "hybrid"]).default("hybrid"),
});

export type IngestRequest = z.infer<typeof IngestRequestSchema>;

