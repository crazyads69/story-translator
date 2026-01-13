// ============================================================================
// Shared Types
// ============================================================================

/** Message types for chat completions */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Common generation options across all providers */
export interface BaseGenerateOptions {
  temperature?: number;
  maxTokens?: number;
  stop?: string | string[];
}

/** Response type for completions */
export interface LLMResponse {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
  };
  /** Chain of thought reasoning (provider-specific) */
  reasoningContent?: string;
}

// ============================================================================
// LLM Provider Interface
// ============================================================================

/** Common interface that all LLM providers must implement */
export interface ILLMProvider {
  /** Generate a completion from messages */
  generate(messages: ChatMessage[], options?: BaseGenerateOptions): Promise<LLMResponse>;
  
  /** Simple text completion with a single prompt */
  complete(prompt: string, systemPrompt?: string, options?: BaseGenerateOptions): Promise<string>;
  
  /** Get the current model being used */
  getModel(): string;
  
  /** Set a new model for future requests */
  setModel(model: string): void;
}

// ============================================================================
// Provider Types
// ============================================================================

export type LLMProviderType = 'openrouter' | 'gemini' | 'deepseek';

export interface LLMProviderConfig {
  type: LLMProviderType;
  apiKey?: string;
  model?: string;
}

// ============================================================================
// Re-exports from individual providers
// ============================================================================

export { OpenRouterLLM, createOpenRouterLLM, type GenerateOptions, type ReasoningEffort } from './open_router';
export { GeminiLLM, createGeminiLLM, type GeminiGenerateOptions } from './gemini';
export { DeepSeekLLM, createDeepSeekLLM, type DeepSeekModel, type DeepSeekGenerateOptions, type DeepSeekLLMResponse } from './deepseek';

// ============================================================================
// Factory Function
// ============================================================================

import { OpenRouterLLM } from './open_router';
import { GeminiLLM } from './gemini';
import { DeepSeekLLM } from './deepseek';

/**
 * Create an LLM provider instance based on configuration
 * 
 * @example
 * ```typescript
 * // Create OpenRouter provider
 * const llm = createLLM({ type: 'openrouter' });
 * 
 * // Create Gemini provider with custom model
 * const llm = createLLM({ type: 'gemini', model: 'gemini-2.5-flash' });
 * 
 * // Create DeepSeek provider with explicit API key
 * const llm = createLLM({ type: 'deepseek', apiKey: 'sk-...', model: 'deepseek-reasoner' });
 * ```
 */
export function createLLM(config: LLMProviderConfig): ILLMProvider {
  switch (config.type) {
    case 'openrouter': {
      const apiKey = config.apiKey ?? process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error(
          'OPENROUTER_API_KEY environment variable is required.\n' +
          'Get your API key at: https://openrouter.ai/keys'
        );
      }
      const model = config.model ?? process.env.LLM_MODEL ?? 'openai/gpt-4o';
      return new OpenRouterLLM(apiKey, model);
    }

    case 'gemini': {
      const apiKey = config.apiKey ?? process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error(
          'GEMINI_API_KEY environment variable is required.\n' +
          'Get your API key at: https://aistudio.google.com/apikey'
        );
      }
      const model = config.model ?? process.env.GEMINI_MODEL ?? 'gemini-2.0-flash';
      return new GeminiLLM(apiKey, model);
    }

    case 'deepseek': {
      const apiKey = config.apiKey ?? process.env.DEEPSEEK_API_KEY;
      if (!apiKey) {
        throw new Error(
          'DEEPSEEK_API_KEY environment variable is required.\n' +
          'Get your API key at: https://platform.deepseek.com/'
        );
      }
      const model = (config.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-chat') as 'deepseek-chat' | 'deepseek-reasoner';
      return new DeepSeekLLM(apiKey, model);
    }

    default:
      throw new Error(`Unknown LLM provider type: ${config.type}`);
  }
}

/**
 * Create an LLM provider from environment variables
 * Automatically detects which provider to use based on available API keys
 * Priority: OPENROUTER_API_KEY > GEMINI_API_KEY > DEEPSEEK_API_KEY
 */
export function createLLMFromEnv(): ILLMProvider {
  if (process.env.OPENROUTER_API_KEY) {
    return createLLM({ type: 'openrouter' });
  }
  
  if (process.env.GEMINI_API_KEY) {
    return createLLM({ type: 'gemini' });
  }
  
  if (process.env.DEEPSEEK_API_KEY) {
    return createLLM({ type: 'deepseek' });
  }
  
  throw new Error(
    'No LLM API key found. Please set one of:\n' +
    '- OPENROUTER_API_KEY\n' +
    '- GEMINI_API_KEY\n' +
    '- DEEPSEEK_API_KEY'
  );
}

// ============================================================================
// LLM Service Class (for dependency injection)
// ============================================================================

/**
 * LLM Service wrapper that can switch providers at runtime
 * Useful for dependency injection and testing
 */
export class LLMService implements ILLMProvider {
  private provider: ILLMProvider;

  constructor(provider: ILLMProvider) {
    this.provider = provider;
  }

  /** Switch to a different LLM provider */
  setProvider(provider: ILLMProvider): void {
    this.provider = provider;
  }

  /** Get the current provider */
  getProvider(): ILLMProvider {
    return this.provider;
  }

  /** Get provider type name */
  getProviderType(): string {
    if (this.provider instanceof OpenRouterLLM) return 'openrouter';
    if (this.provider instanceof GeminiLLM) return 'gemini';
    if (this.provider instanceof DeepSeekLLM) return 'deepseek';
    return 'unknown';
  }

  async generate(messages: ChatMessage[], options?: BaseGenerateOptions): Promise<LLMResponse> {
    return this.provider.generate(messages, options);
  }

  async complete(prompt: string, systemPrompt?: string, options?: BaseGenerateOptions): Promise<string> {
    return this.provider.complete(prompt, systemPrompt, options);
  }

  getModel(): string {
    return this.provider.getModel();
  }

  setModel(model: string): void {
    this.provider.setModel(model);
  }
}

/**
 * Create LLM Service from configuration
 */
export function createLLMService(config: LLMProviderConfig): LLMService {
  const provider = createLLM(config);
  return new LLMService(provider);
}

/**
 * Create LLM Service from environment variables
 */
export function createLLMServiceFromEnv(): LLMService {
  const provider = createLLMFromEnv();
  return new LLMService(provider);
}
