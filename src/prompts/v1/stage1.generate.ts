import type { ChatMessage } from "../../infrastructure/llm/types";
import { PROMPT_VERSION, SYSTEM_PROMPT, VIETNAMESE_TRANSLATION_GUIDANCE } from "./shared.system";

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
  const isVietnamese = input.language.toLowerCase().includes("vietnam");
  
  const developer = [
    "## TASK",
    "Produce a high-quality draft translation with glossary suggestions.",
    "",
    "## CONSTRAINTS",
    "- Preserve named entities and factual content exactly.",
    "- Keep paragraph boundaries intact.",
    "- Use provided RAG context for style consistency.",
    "- Use provided ground truth for cultural/entity translations.",
    "- Maintain glossary consistency with existing terms.",
    "",
    "## EVIDENCE",
    "For each translation decision, note which evidence source supported it:",
    "- `source`: from the original text itself",
    "- `rag`: from similar passages in the story database",
    "- `ground_truth`: from web research results",
    "",
    "## OUTPUT",
    "Return JSON that matches the provided schema exactly. No markdown, no explanations.",
    "",
    `PromptVersion: ${PROMPT_VERSION}`,
  ].join("\n");

  const user = [
    "# TRANSLATION REQUEST",
    "",
    `**Target Language:** ${input.language}`,
    "",
    "## STORY CONTEXT",
    formatKv(input.metadata),
    "",
    "## SOURCE PARAGRAPH",
    "```",
    input.source,
    "```",
    "",
    "## RAG CONTEXT (Similar passages from this story)",
    formatSnippets(input.ragSnippets),
    "",
    "## GROUND TRUTH (Research results)",
    formatSnippets(input.groundTruthSnippets),
    "",
    "## EXISTING GLOSSARY (Must use these terms consistently)",
    formatGlossary(input.existingGlossary),
    "",
    "---",
    "Now produce the draft translation following all guidelines.",
  ].join("\n");

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...(isVietnamese ? [{ role: "system" as const, content: VIETNAMESE_TRANSLATION_GUIDANCE }] : []),
    { role: "system", content: developer },
    { role: "user", content: user },
  ];

  return {
    promptVersion: PROMPT_VERSION,
    messages,
  };
}

