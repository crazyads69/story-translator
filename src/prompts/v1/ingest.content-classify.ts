import type { ChatMessage } from "../../infrastructure/llm/types";
import { SYSTEM_PROMPT, PROMPT_VERSION } from "./shared.system";

/**
 * Prompt template: classify content to support routing and safety checks.
 *
 * Intended output (JSON): {"contentType": "markdown"|"pdf"|"text"|"html"|"unknown"}
 */
export function buildContentClassifyMessages(input: {
  sourceUri: string;
  sample: string;
}): { promptVersion: string; messages: ChatMessage[] } {
  const developer = [
    "Task: classify the content type from the sample.",
    "Return JSON only with key: contentType.",
    `PromptVersion: ${PROMPT_VERSION}`,
  ].join("\n");

  const user = [`SOURCE_URI: ${input.sourceUri}`, "SAMPLE:", input.sample].join("\n");

  return {
    promptVersion: PROMPT_VERSION,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "system", content: developer },
      { role: "user", content: user },
    ],
  };
}

