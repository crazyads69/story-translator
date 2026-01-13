import { OpenRouter } from '@openrouter/sdk';

// Message types for chat completions
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// Reasoning effort levels supported by OpenRouter
export type ReasoningEffort = 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none';

// Options for generation
export interface GenerateOptions {
  temperature?: number;
  maxTokens?: number;
  stop?: string | string[];
  seed?: number;
  /** Enable reasoning/thinking for supported models (e.g., o1, o3, Claude with extended thinking) */
  reasoning?: {
    effort?: ReasoningEffort;
  };
}

// Response type for completions
export interface LLMResponse {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
  };
}

export class OpenRouterLLM {
  private apiKey: string;
  private model: string;
  private openRouterClient: OpenRouter;

  constructor(apiKey: string, model: string = "openai/gpt-4o") {
    if (!apiKey) {
      throw new Error("OpenRouter API key is required");
    }
    this.apiKey = apiKey;
    this.model = model;

    // Initialize OpenRouter SDK client
    this.openRouterClient = new OpenRouter({
      apiKey: this.apiKey,
    });
  }

  /**
   * Generate a completion from messages
   * Supports reasoning/thinking for compatible models (o1, o3, Claude, etc.)
   */
  async generate(
    messages: ChatMessage[],
    options: GenerateOptions = {}
  ): Promise<LLMResponse> {
    try {
      const result = await this.openRouterClient.chat.send({
        model: this.model,
        messages: messages.map(msg => ({
          role: msg.role,
          content: msg.content,
        })),
        stream: false,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        stop: options.stop,
        seed: options.seed,
        reasoning: options.reasoning,
      });

      // Extract content - handle both string and array content types
      const rawContent = result.choices?.[0]?.message?.content;
      let content: string;
      
      if (typeof rawContent === 'string') {
        content = rawContent;
      } else if (Array.isArray(rawContent)) {
        // Extract text from content array (multimodal response)
        content = rawContent
          .filter((item): item is { type: 'text'; text: string } => 
            item && typeof item === 'object' && 'type' in item && item.type === 'text'
          )
          .map(item => item.text)
          .join('');
      } else {
        content = '';
      }

      // Extract usage including reasoning tokens if available
      const usage = result.usage ? {
        promptTokens: result.usage.promptTokens ?? 0,
        completionTokens: result.usage.completionTokens ?? 0,
        totalTokens: result.usage.totalTokens ?? 0,
        reasoningTokens: result.usage.completionTokensDetails?.reasoningTokens ?? undefined,
      } : undefined;

      return {
        content,
        model: result.model ?? this.model,
        usage,
      };
    } catch (error) {
      console.error("Error generating completion:", error);
      throw new Error(
        `OpenRouter LLM error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Simple text completion with a single prompt
   * Convenience method for quick completions
   */
  async complete(
    prompt: string,
    systemPrompt?: string,
    options: GenerateOptions = {}
  ): Promise<string> {
    const messages: ChatMessage[] = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    messages.push({ role: 'user', content: prompt });

    const response = await this.generate(messages, options);
    return response.content;
  }

  /**
   * Get the current model being used
   */
  getModel(): string {
    return this.model;
  }

  /**
   * Set a new model for future requests
   */
  setModel(model: string): void {
    this.model = model;
  }
}

/**
 * Create OpenRouter LLM instance from environment variables
 */
export function createOpenRouterLLM(): OpenRouterLLM {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY environment variable is required.\n" +
      "Get your API key at: https://openrouter.ai/keys"
    );
  }

  const model = process.env.LLM_MODEL || "openai/gpt-4o";

  return new OpenRouterLLM(apiKey, model);
}