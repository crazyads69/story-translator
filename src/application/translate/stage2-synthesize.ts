import type { LlmClient } from "../../infrastructure/llm/types";
import { generateStructured } from "../../infrastructure/llm/structured";
import {
  FinalTranslationSchema,
  type FinalTranslation,
  type Stage1Draft,
} from "../../domain/translate/schemas";
import { buildStage2Messages } from "../../prompts/v1/stage2.synthesize";

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export async function runStage2(params: {
  client: LlmClient;
  model: string;
  source: string;
  deepseekDraft?: Stage1Draft;
  openrouterDraft?: Stage1Draft;
  promptVersion: string;
}): Promise<FinalTranslation> {
  const { messages } = buildStage2Messages({
    source: params.source,
    deepseekDraftJson: params.deepseekDraft ? safeJsonStringify(params.deepseekDraft) : undefined,
    openrouterDraftJson: params.openrouterDraft ? safeJsonStringify(params.openrouterDraft) : undefined,
  });

  // DeepSeek recommends temperature=1.3 for translation tasks
  // See: https://api-docs.deepseek.com/quick_start/parameter_settings
  const out = await generateStructured({
    client: params.client,
    model: params.model,
    messages,
    schema: FinalTranslationSchema,
    temperature: 1.3,
    topP: 1,
    maxTokens: 3072,
    maxAttempts: 2,
  });

  return {
    ...out,
    metadata: {
      ...out.metadata,
      promptVersion: params.promptVersion,
    },
  };
}
