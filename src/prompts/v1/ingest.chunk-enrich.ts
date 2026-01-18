import type { ChatMessage } from "../../infrastructure/llm/types";
import { SYSTEM_PROMPT, PROMPT_VERSION } from "./shared.system";

export type ChunkEnrichPromptInput = {
  sourceUri: string;
  contentTypeHint?: string;
  chunkText: string;
};

export function buildChunkEnrichMessages(input: ChunkEnrichPromptInput): {
  promptVersion: string;
  messages: ChatMessage[];
} {
  const developer = [
    "Task: normalize chunk text for retrieval and produce an embedding-oriented summary.",
    "Return JSON matching the provided schema exactly.",
    "Safety: do not include secrets; do not output external links unless present in the source.",
    `PromptVersion: ${PROMPT_VERSION}`,
  ].join("\n");

  const user = [
    `SOURCE_URI: ${input.sourceUri}`,
    `CONTENT_TYPE_HINT: ${input.contentTypeHint ?? "(none)"}`,
    "",
    "CHUNK_TEXT:",
    input.chunkText,
  ].join("\n");

  return {
    promptVersion: PROMPT_VERSION,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "system", content: developer },
      { role: "user", content: user },
    ],
  };
}

