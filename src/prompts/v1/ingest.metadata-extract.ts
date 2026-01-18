import type { ChatMessage } from "../../infrastructure/llm/types";
import { SYSTEM_PROMPT, PROMPT_VERSION } from "./shared.system";

/**
 * Prompt template: extract document-level metadata for indexing and filtering.
 *
 * Intended output (JSON):
 * {
 *   "title"?: string,
 *   "language": string,
 *   "tags": string[],
 *   "entities": string[]
 * }
 */
export function buildMetadataExtractMessages(input: {
  sourceUri: string;
  text: string;
}): { promptVersion: string; messages: ChatMessage[] } {
  const developer = [
    "Task: extract minimal metadata for retrieval filtering.",
    "Return JSON only with keys: title (optional), language, tags, entities.",
    "Do not hallucinate authors or publication dates.",
    `PromptVersion: ${PROMPT_VERSION}`,
  ].join("\n");

  const user = [`SOURCE_URI: ${input.sourceUri}`, "TEXT:", input.text].join("\n");

  return {
    promptVersion: PROMPT_VERSION,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "system", content: developer },
      { role: "user", content: user },
    ],
  };
}

