import type { ChatMessage } from "../../infrastructure/llm/types";
import { PROMPT_VERSION, SYSTEM_PROMPT } from "./shared.system";

export type Stage1PromptInput = {
  language: string;
  source: string;
  metadata?: Record<string, string>;
  ragSnippets?: Array<{ id: string; snippet: string }>;
  groundTruthSnippets?: Array<{ id: string; snippet: string }>;
  existingGlossary?: Array<{ source: string; target: string }>;
};

function formatKv(meta: Record<string, string> | undefined): string {
  if (!meta) return "";
  return Object.entries(meta)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

function formatSnippets(snippets: Array<{ id: string; snippet: string }> | undefined): string {
  if (!snippets || snippets.length === 0) return "(none)";
  return snippets.map((s) => `[${s.id}] ${s.snippet}`).join("\n\n");
}

function formatGlossary(glossary: Array<{ source: string; target: string }> | undefined): string {
  if (!glossary || glossary.length === 0) return "(none)";
  return glossary.map((g) => `- ${g.source}: ${g.target}`).join("\n");
}

export function buildStage1Messages(input: Stage1PromptInput): {
  promptVersion: string;
  messages: ChatMessage[];
} {
  const developer = [
    "Task: produce a draft translation and glossary suggestions.",
    "Constraints: preserve named entities and factual content; keep paragraph boundaries.",
    "Return JSON that matches the provided schema exactly.",
    `PromptVersion: ${PROMPT_VERSION}`,
  ].join("\n");

  const user = [
    "METADATA:",
    formatKv(input.metadata),
    "",
    "SOURCE_PARAGRAPH:",
    input.source,
    "",
    "GROUNDING_RAG:",
    formatSnippets(input.ragSnippets),
    "",
    "GROUNDING_WEB:",
    formatSnippets(input.groundTruthSnippets),
    "",
    "EXISTING_GLOSSARY (Use these terms):",
    formatGlossary(input.existingGlossary),
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

