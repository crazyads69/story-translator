import type { LlmClient } from "../../infrastructure/llm/types";
import { generateStructured } from "../../infrastructure/llm/structured";
import { Stage1DraftSchema, type Stage1Draft } from "../../domain/translate/schemas";
import { buildStage1Messages, type Stage1PromptInput } from "../../prompts/v1/stage1.generate";

export type Stage1Result = {
  provider: "deepseek" | "openrouter";
  model: string;
  draft?: Stage1Draft;
  error?: string;
  promptVersion: string;
};

export async function runStage1(params: {
  provider: "deepseek" | "openrouter";
  client: LlmClient;
  model: string;
  input: Stage1PromptInput;
  seed?: number;
}): Promise<Stage1Result> {
  const { messages, promptVersion } = buildStage1Messages(params.input);
  try {
    // DeepSeek recommends temperature=1.3 for translation tasks
    // See: https://api-docs.deepseek.com/quick_start/parameter_settings
    const draft = await generateStructured({
      client: params.client,
      model: params.model,
      messages,
      schema: Stage1DraftSchema,
      temperature: 1.3,
      topP: 1,
      seed: params.seed,
      maxTokens: 2048,
      maxAttempts: 2,
    });
    return { provider: params.provider, model: params.model, draft, promptVersion };
  } catch (error) {
    return {
      provider: params.provider,
      model: params.model,
      error: error instanceof Error ? error.message : String(error),
      promptVersion,
    };
  }
}

