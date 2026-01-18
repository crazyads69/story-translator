import type { LlmClient } from "../../infrastructure/llm/types";
import { generateStructured } from "../../infrastructure/llm/structured";
import {
  ExtractedMetadataSchema,
  type ExtractedMetadata,
} from "../../domain/ingest/enrichment";
import {
  buildChunkEnrichMessages,
  type ChunkEnrichPromptInput,
} from "../../prompts/v1/ingest.chunk-enrich";

export type EnrichChunkArgs = {
  client: LlmClient;
  model: string;
  input: ChunkEnrichPromptInput;
};

/**
 * Optional LLM-based enrichment step.
 *
 * Use when:
 * - content is noisy (HTML/PDF extraction artifacts)
 * - you want better cross-lingual retrieval and stable summaries for embeddings
 *
 * Cost controls:
 * - temperature=0
 * - schema validated outputs with bounded retries
 */
export type TwoStageEnrichChunkArgs = {
  deepseekClient: LlmClient;
  deepseekModel: string;
  openrouterClient?: LlmClient;
  openrouterModel?: string; // e.g. "xiaomi/mimo-v2-flash:free"
  input: ChunkEnrichPromptInput;
};

/**
 * 2-Stage Enrichment:
 * 1. Parallel Branch A: DeepSeek extraction
 * 2. Parallel Branch B: OpenRouter (MiMo) reasoning/analysis
 * 3. Merge: DeepSeek synthesizes the final metadata using both inputs
 */
export async function enrichChunkTwoStage(
  args: TwoStageEnrichChunkArgs,
): Promise<ExtractedMetadata> {
  const { messages: deepseekMessages } = buildChunkEnrichMessages(args.input);

  // Define tasks
  const deepseekTask = generateStructured({
    client: args.deepseekClient,
    model: args.deepseekModel,
    messages: deepseekMessages,
    schema: ExtractedMetadataSchema,
    temperature: 0,
    topP: 1,
    maxTokens: 800,
    maxAttempts: 2,
  });

  const openrouterTask = (async () => {
    if (!args.openrouterClient || !args.openrouterModel) return null;
    try {
      const res = await args.openrouterClient.chatComplete({
        model: args.openrouterModel,
        messages: [
          {
            role: "system",
            content:
              "You are an expert content analyzer. Analyze the following text deeply. Identify key entities, themes, and language nuances. Provide a detailed analysis.",
          },
          { role: "user", content: args.input.chunkText },
        ],
        temperature: 0.6,
        maxTokens: 1000,
        includeReasoning: true,
      });
      return res.content;
    } catch (err) {
      console.warn("OpenRouter enrichment failed", err);
      return null;
    }
  })();

  // Run in parallel
  const [deepseekResult, mimoAnalysis] = await Promise.all([
    deepseekTask,
    openrouterTask,
  ]);

  if (!mimoAnalysis) {
    return deepseekResult;
  }

  // Stage 3: Merge/Refine using DeepSeek
  // We ask DeepSeek to refine its own extraction based on MiMo's insight
  const mergeSystemPrompt = `You are a data merging expert. You have an initial structured extraction and a deep reasoning analysis from another model.
Your task is to IMPROVE the structured data based on the deep analysis.
- Update 'normalizedText' if the analysis suggests better phrasing or context.
- Refine 'summaryForEmbedding' to include deep insights.
- Ensure 'title' and 'keywords' capture the core themes identified.
- Verify 'language' and 'contentType'.

Return the final JSON strictly following the schema.`;

  const mergeUserPrompt = `**ORIGINAL TEXT:**
${args.input.chunkText}

**INITIAL EXTRACTION:**
${JSON.stringify(deepseekResult, null, 2)}

**DEEP ANALYSIS:**
${mimoAnalysis}

**TASK:** Merge and refine the extraction.`;

  return generateStructured({
    client: args.deepseekClient,
    model: args.deepseekModel,
    messages: [
      { role: "system", content: mergeSystemPrompt },
      { role: "user", content: mergeUserPrompt },
    ],
    schema: ExtractedMetadataSchema,
    temperature: 0,
    maxTokens: 1000,
  });
}

export async function enrichChunk(
  args: EnrichChunkArgs,
): Promise<ExtractedMetadata> {
  const { messages } = buildChunkEnrichMessages(args.input);
  return generateStructured({
    client: args.client,
    model: args.model,
    messages,
    schema: ExtractedMetadataSchema,
    temperature: 0,
    topP: 1,
    maxTokens: 800,
    maxAttempts: 2,
  });
}
