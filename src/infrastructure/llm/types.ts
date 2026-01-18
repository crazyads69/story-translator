export type ProviderName = "deepseek" | "openrouter";

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ResponseFormat = "text" | "json_object";

export type LlmUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type ChatCompletionRequest = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  seed?: number;
  responseFormat?: ResponseFormat;
  stream?: boolean;
  includeReasoning?: boolean;
};

export type ChatCompletionResponse = {
  provider: ProviderName;
  model: string;
  content: string;
  usage?: LlmUsage;
  raw?: unknown;
};

export interface LlmClient {
  readonly provider: ProviderName;
  chatComplete(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
}

