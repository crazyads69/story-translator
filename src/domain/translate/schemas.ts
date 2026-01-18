import { z } from "zod";

export const GlossaryEntrySchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
});

export const EvidenceSchema = z.object({
  kind: z.enum(["source", "rag", "ground_truth"]),
  id: z.string().min(1),
  snippet: z.string().min(1),
});

export const Stage1DraftSchema = z.object({
  language: z.string().min(1),
  translation: z.string().min(1),
  glossary: z.array(GlossaryEntrySchema).default([]),
  warnings: z.array(z.string()).default([]),
  evidence: z.array(EvidenceSchema).default([]),
});

export type Stage1Draft = z.infer<typeof Stage1DraftSchema>;

export const DecisionSchema = z.object({
  issue: z.string().min(1),
  resolution: z.string().min(1),
  chosen_from: z.enum(["deepseek", "openrouter", "merged"]),
});

export const FinalTranslationSchema = z.object({
  language: z.string().min(1),
  translation: z.string().min(1),
  decisions: z.array(DecisionSchema).default([]),
  glossary: z.array(GlossaryEntrySchema).default([]),
  metadata: z.object({
    promptVersion: z.string().min(1),
    providers: z.array(
      z.object({
        provider: z.enum(["deepseek", "openrouter"]),
        model: z.string().min(1),
        status: z.enum(["ok", "error"]).default("ok"),
      }),
    ),
  }),
});

export type FinalTranslation = z.infer<typeof FinalTranslationSchema>;

