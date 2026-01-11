import { OpenRouter } from '@openrouter/sdk';
import type { CreateEmbeddingsResponseBody } from '@openrouter/sdk/models/operations';

export class OpenRouterEmbeddings {
  private apiKey: string;
  private model: string;
  private openRouterClient: OpenRouter;

  constructor(apiKey: string, model: string = "openai/text-embedding-3-small") {
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
   * Generate embedding for a single text
   * Based on OpenRouter API docs: https://openrouter.ai/docs#embeddings
   */
  async embedText(text: string): Promise<number[]> {
    // Truncate text to prevent token limit issues
    const truncatedText = text.slice(0, 8000);

    try {
      const response = await this.openRouterClient.embeddings.generate({
        model: this.model,
        input: truncatedText,
      });

      // Response can be CreateEmbeddingsResponseBody or string
      if (typeof response === 'string') {
        throw new Error("Unexpected string response from OpenRouter API");
      }

      const body = response as CreateEmbeddingsResponseBody;
      
      // Extract embedding from response
      if (!body.data || !body.data[0] || !body.data[0].embedding) {
        throw new Error("Invalid response from OpenRouter API");
      }

      const embedding = body.data[0].embedding;
      // embedding can be number[] or string (base64)
      if (typeof embedding === 'string') {
        throw new Error("Base64 embedding format not supported");
      }

      return embedding;
    } catch (error) {
      console.error("Error generating embedding:", error);
      throw new Error(`OpenRouter API error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Generate embeddings for multiple texts in batch
   * More efficient for bulk operations
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    // Truncate all texts
    const truncatedTexts = texts.map(text => text.slice(0, 8000));

    try {
      const response = await this.openRouterClient.embeddings.generate({
        model: this.model,
        input: truncatedTexts,
      });

      // Response can be CreateEmbeddingsResponseBody or string
      if (typeof response === 'string') {
        throw new Error("Unexpected string response from OpenRouter API");
      }

      const body = response as CreateEmbeddingsResponseBody;

      // Extract embeddings from batch response
      if (!body.data || !Array.isArray(body.data)) {
        throw new Error("Invalid batch response from OpenRouter API");
      }

      return body.data.map((item) => {
        if (typeof item.embedding === 'string') {
          throw new Error("Base64 embedding format not supported");
        }
        return item.embedding;
      });
    } catch (error) {
      console.error("Error generating batch embeddings:", error);
      throw new Error(`OpenRouter API batch error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get embedding dimension for the current model
   */
  getEmbeddingDimension(): number {
    // Common dimensions for OpenAI models via OpenRouter
    const dimensions: Record<string, number> = {
      "openai/text-embedding-3-small": 1536,
      "openai/text-embedding-3-large": 3072,
      "openai/text-embedding-ada-002": 1536,
    };

    return dimensions[this.model] || 1536;
  }
}

/**
 * Create OpenRouter embeddings instance from environment variables
 */
export function createOpenRouterEmbeddings(): OpenRouterEmbeddings {
  const apiKey = process.env.OPENROUTER_API_KEY;
  
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY environment variable is required.\n" +
      "Get your API key at: https://openrouter.ai/keys"
    );
  }

  const model = process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small";
  
  return new OpenRouterEmbeddings(apiKey, model);
}