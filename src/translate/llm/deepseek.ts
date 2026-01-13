import OpenAI from 'openai';

// Import shared types
import type { ChatMessage, LLMResponse } from './index';

// DeepSeek API base URL
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

// DeepSeek models
export type DeepSeekModel = 'deepseek-chat' | 'deepseek-reasoner';

// DeepSeek-specific generation options
export interface DeepSeekGenerateOptions {
  temperature?: number;
  maxTokens?: number;
  stop?: string | string[];
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  /** 
   * Enable reasoning/thinking mode
   * Only works with deepseek-reasoner model
   * Set to true to get reasoning_content in response
   */
  reasoning?: boolean;
}

// Extended response for DeepSeek with reasoning content
export interface DeepSeekLLMResponse extends LLMResponse {
  /** Chain of thought reasoning content (only available with deepseek-reasoner) */
  reasoningContent?: string;
}

export class DeepSeekLLM {
  private apiKey: string;
  private model: DeepSeekModel;
  private client: OpenAI;

  constructor(apiKey: string, model: DeepSeekModel = 'deepseek-chat') {
    if (!apiKey) {
      throw new Error('DeepSeek API key is required');
    }
    this.apiKey = apiKey;
    this.model = model;

    // Initialize OpenAI client with DeepSeek base URL
    // DeepSeek API is OpenAI-compatible
    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: DEEPSEEK_BASE_URL,
    });
  }

  /**
   * Generate a completion from messages
   * Supports reasoning/thinking for deepseek-reasoner model
   */
  async generate(
    messages: ChatMessage[],
    options: DeepSeekGenerateOptions = {}
  ): Promise<DeepSeekLLMResponse> {
    try {
      // Build request parameters
      const requestParams: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
        model: this.model,
        messages: messages.map(msg => ({
          role: msg.role,
          content: msg.content,
        })),
        stream: false,
      };

      // Add optional parameters (not supported for deepseek-reasoner)
      if (this.model === 'deepseek-chat') {
        if (options.temperature !== undefined) {
          requestParams.temperature = options.temperature;
        }
        if (options.topP !== undefined) {
          requestParams.top_p = options.topP;
        }
        if (options.frequencyPenalty !== undefined) {
          requestParams.frequency_penalty = options.frequencyPenalty;
        }
        if (options.presencePenalty !== undefined) {
          requestParams.presence_penalty = options.presencePenalty;
        }
      }

      // max_tokens works for both models
      if (options.maxTokens !== undefined) {
        requestParams.max_tokens = options.maxTokens;
      }
      if (options.stop !== undefined) {
        requestParams.stop = options.stop;
      }

      // Make API request
      const response = await this.client.chat.completions.create(requestParams);

      // Extract content
      const choice = response.choices?.[0];
      const content = choice?.message?.content ?? '';

      // Extract reasoning content if available (deepseek-reasoner only)
      // @ts-ignore - reasoning_content is DeepSeek-specific extension
      const reasoningContent = choice?.message?.reasoning_content as string | undefined;

      // Extract usage
      const usage = response.usage ? {
        promptTokens: response.usage.prompt_tokens ?? 0,
        completionTokens: response.usage.completion_tokens ?? 0,
        totalTokens: response.usage.total_tokens ?? 0,
        // @ts-ignore - reasoning_tokens may be available for reasoner model
        reasoningTokens: response.usage.completion_tokens_details?.reasoning_tokens ?? undefined,
      } : undefined;

      return {
        content,
        model: response.model ?? this.model,
        usage,
        reasoningContent,
      };
    } catch (error) {
      console.error('Error generating completion:', error);
      throw new Error(
        `DeepSeek LLM error: ${error instanceof Error ? error.message : String(error)}`
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
    options: DeepSeekGenerateOptions = {}
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
   * Generate with reasoning - returns both content and reasoning
   * Automatically uses deepseek-reasoner model
   */
  async generateWithReasoning(
    messages: ChatMessage[],
    options: Omit<DeepSeekGenerateOptions, 'reasoning'> = {}
  ): Promise<DeepSeekLLMResponse> {
    // Temporarily switch to reasoner model if not already
    const originalModel = this.model;
    this.model = 'deepseek-reasoner';

    try {
      const response = await this.generate(messages, { ...options, reasoning: true });
      return response;
    } finally {
      // Restore original model
      this.model = originalModel;
    }
  }

  /**
   * Get the current model being used
   */
  getModel(): DeepSeekModel {
    return this.model;
  }

  /**
   * Set a new model for future requests
   */
  setModel(model: DeepSeekModel): void {
    this.model = model;
  }
}

/**
 * Create DeepSeek LLM instance from environment variables
 */
export function createDeepSeekLLM(): DeepSeekLLM {
  const apiKey = process.env.DEEPSEEK_API_KEY;

  if (!apiKey) {
    throw new Error(
      'DEEPSEEK_API_KEY environment variable is required.\n' +
      'Get your API key at: https://platform.deepseek.com/'
    );
  }

  const model = (process.env.DEEPSEEK_MODEL || 'deepseek-chat') as DeepSeekModel;

  return new DeepSeekLLM(apiKey, model);
}
