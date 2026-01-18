import type { ChatMessage } from "../../infrastructure/llm/types";
import { SYSTEM_PROMPT, PROMPT_VERSION } from "./shared.system";

/**
 * Prompt template: normalize noisy extracted text into stable, retrieval-ready prose.
 *
 * Intended output: JSON with a single key `normalizedText`.
 */
export function buildNormalizeTextMessages(input: {
  sourceUri: string;
  rawText: string;
}): { promptVersion: string; messages: ChatMessage[] } {
  const developer = [
    "Task: rewrite the given text into a normalized form suitable for retrieval and chunking.",
    "Rules:",
    "- preserve meaning and factual claims",
    "- remove obvious extraction artifacts (broken hyphenation, duplicated headers/footers)",
    "- keep paragraphs and lists readable",
    "Return JSON only: {\"normalizedText\": string}.",
    `PromptVersion: ${PROMPT_VERSION}`,
  ].join("\n");

  const user = [`SOURCE_URI: ${input.sourceUri}`, "RAW_TEXT:", input.rawText].join("\n");

  return {
    promptVersion: PROMPT_VERSION,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "system", content: developer },
      { role: "user", content: user },
    ],
  };
}

