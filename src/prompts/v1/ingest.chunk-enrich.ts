import type { ChatMessage } from "../../infrastructure/llm/types";
import { PROMPT_VERSION } from "./shared.system";

export type ChunkEnrichPromptInput = {
  sourceUri: string;
  contentTypeHint?: string;
  chunkText: string;
};

const ENRICHMENT_SYSTEM_PROMPT = [
  "You are an expert content analyst specializing in text normalization and semantic extraction.",
  "",
  "Your role is to:",
  "1. Clean and normalize text for optimal retrieval",
  "2. Extract structured metadata for indexing",
  "3. Generate embedding-focused summaries that capture semantic meaning",
  "",
  "Be concise, accurate, and consistent in your output format.",
].join("\n");

export function buildChunkEnrichMessages(input: ChunkEnrichPromptInput): {
  promptVersion: string;
  messages: ChatMessage[];
} {
  const developer = [
    "## TASK: CHUNK ENRICHMENT FOR RAG",
    "",
    "Process the provided text chunk for optimal vector retrieval:",
    "",
    "### 1. NORMALIZE TEXT",
    "- Remove HTML artifacts, encoding errors, extra whitespace",
    "- Fix obvious OCR/parsing errors if detectable",
    "- Preserve paragraph structure and meaningful formatting",
    "",
    "### 2. EXTRACT METADATA",
    "- **language**: Detect primary language (ISO 639-1 code: en, vi, zh, ja, ko, etc.)",
    "- **contentType**: Classify as markdown, pdf, text, html, or unknown",
    "- **title**: Extract or infer section/chapter title if present",
    "- **tags**: Key themes, genres, or categories (max 5)",
    "- **entities**: Named entities: characters, locations, organizations (max 10)",
    "",
    "### 3. GENERATE SUMMARY FOR EMBEDDING",
    "Create a 2-4 sentence summary optimized for semantic search:",
    "- Include key entities, actions, and themes",
    "- Focus on searchable concepts, not style",
    "- Use the SAME language as the source text",
    "",
    "## OUTPUT",
    "Return JSON matching the schema exactly. No markdown fences.",
    "",
    "## SAFETY",
    "- Do NOT include secrets, passwords, or API keys",
    "- Do NOT generate external links not present in source",
    "",
    `PromptVersion: ${PROMPT_VERSION}`,
  ].join("\n");

  const user = [
    `# CHUNK METADATA`,
    `- Source URI: ${input.sourceUri}`,
    `- Content Type Hint: ${input.contentTypeHint ?? "(auto-detect)"}`,
    "",
    "# CHUNK TEXT",
    "```",
    input.chunkText,
    "```",
    "",
    "---",
    "Process this chunk and return the enriched metadata JSON.",
  ].join("\n");

  return {
    promptVersion: PROMPT_VERSION,
    messages: [
      { role: "system", content: ENRICHMENT_SYSTEM_PROMPT },
      { role: "system", content: developer },
      { role: "user", content: user },
    ],
  };
}

