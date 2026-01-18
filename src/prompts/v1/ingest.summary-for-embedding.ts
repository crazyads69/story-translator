import type { ChatMessage } from "../../infrastructure/llm/types";
import { SYSTEM_PROMPT, PROMPT_VERSION } from "./shared.system";

/**
 * Prompt template: produce a compact, information-dense summary optimized for embeddings.
 *
 * Intended output (JSON): {"summaryForEmbedding": string}
 */
export function buildSummaryForEmbeddingMessages(input: {
  text: string;
}): { promptVersion: string; messages: ChatMessage[] } {
  const developer = [
    "Task: summarize the text for embedding-based retrieval.",
    "Rules:",
    "- keep named entities, technical terms, and key facts",
    "- remove fluff, keep under ~800 characters",
    "Return JSON only with key: summaryForEmbedding.",
    `PromptVersion: ${PROMPT_VERSION}`,
  ].join("\n");

  return {
    promptVersion: PROMPT_VERSION,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "system", content: developer },
      { role: "user", content: input.text },
    ],
  };
}

