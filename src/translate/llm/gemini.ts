import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
  type GenerativeModel,
  type GenerationConfig,
} from '@google/generative-ai';

// Import shared types
import type { ChatMessage, LLMResponse } from './index';

// Gemini-specific generation options
export interface GeminiGenerateOptions {
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  /** Enable thinking/reasoning for Gemini 2.5 models */
  thinking?: {
    /** Token budget for thinking: 0 to disable, -1 for dynamic, or specific count */
    budget?: number;
  };
}

// Safety settings that disable all content filtering
const SAFETY_SETTINGS_OFF = [
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
];

export class GeminiLLM {
  private apiKey: string;
  private modelName: string;
  private genAI: GoogleGenerativeAI;
  private model: GenerativeModel;

  constructor(apiKey: string, model: string = 'gemini-2.0-flash') {
    if (!apiKey) {
      throw new Error('Gemini API key is required');
    }
    this.apiKey = apiKey;
    this.modelName = model;

    // Initialize Google Generative AI client
    this.genAI = new GoogleGenerativeAI(this.apiKey);

    // Create model with safety settings disabled
    this.model = this.genAI.getGenerativeModel({
      model: this.modelName,
      safetySettings: SAFETY_SETTINGS_OFF,
    });
  }

  /**
   * Generate a completion from messages
   * Supports thinking for Gemini 2.5 models
   */
  async generate(
    messages: ChatMessage[],
    options: GeminiGenerateOptions = {}
  ): Promise<LLMResponse> {
    try {
      // Build generation config
      const generationConfig: GenerationConfig = {};
      
      if (options.temperature !== undefined) {
        generationConfig.temperature = options.temperature;
      }
      if (options.maxTokens !== undefined) {
        generationConfig.maxOutputTokens = options.maxTokens;
      }
      if (options.stop !== undefined) {
        generationConfig.stopSequences = options.stop;
      }

      // Extract system instruction if present
      const systemMessage = messages.find(m => m.role === 'system');
      const chatMessages = messages.filter(m => m.role !== 'system');

      // Create model with current options
      const modelWithConfig = this.genAI.getGenerativeModel({
        model: this.modelName,
        safetySettings: SAFETY_SETTINGS_OFF,
        generationConfig,
        systemInstruction: systemMessage?.content,
      });

      // Convert messages to Gemini format
      const contents = chatMessages.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      }));

      // Generate content
      const result = await modelWithConfig.generateContent({
        contents,
        generationConfig: options.thinking?.budget !== undefined ? {
          ...generationConfig,
          // @ts-ignore - thinkingConfig is available for Gemini 2.5 models
          thinkingConfig: {
            thinkingBudget: options.thinking.budget,
          },
        } : generationConfig,
      });

      const response = result.response;
      const content = response.text();

      // Extract usage metadata
      const usageMetadata = response.usageMetadata;
      const usage = usageMetadata ? {
        promptTokens: usageMetadata.promptTokenCount ?? 0,
        completionTokens: usageMetadata.candidatesTokenCount ?? 0,
        totalTokens: usageMetadata.totalTokenCount ?? 0,
        // @ts-ignore - thoughtsTokenCount may be available for thinking models
        reasoningTokens: usageMetadata.thoughtsTokenCount ?? undefined,
      } : undefined;

      return {
        content,
        model: this.modelName,
        usage,
      };
    } catch (error) {
      console.error('Error generating completion:', error);
      throw new Error(
        `Gemini LLM error: ${error instanceof Error ? error.message : String(error)}`
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
    options: GeminiGenerateOptions = {}
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
    return this.modelName;
  }

  /**
   * Set a new model for future requests
   */
  setModel(model: string): void {
    this.modelName = model;
    this.model = this.genAI.getGenerativeModel({
      model: this.modelName,
      safetySettings: SAFETY_SETTINGS_OFF,
    });
  }
}

/**
 * Create Gemini LLM instance from environment variables
 */
export function createGeminiLLM(): GeminiLLM {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY environment variable is required.\n' +
      'Get your API key at: https://aistudio.google.com/apikey'
    );
  }

  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

  return new GeminiLLM(apiKey, model);
}