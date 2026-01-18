import type { ChatMessage } from "../../infrastructure/llm/types";
import { PROMPT_VERSION, SYSTEM_PROMPT } from "./shared.system";

export type Stage2PromptInput = {
  source: string;
  deepseekDraftJson?: string;
  openrouterDraftJson?: string;
};

export function buildStage2Messages(input: Stage2PromptInput): {
  promptVersion: string;
  messages: ChatMessage[];
} {
  const developer = [
    "## TASK: MERGE & SYNTHESIZE TRANSLATIONS",
    "",
    "You will receive TWO independently produced draft translations:",
    "1. **DeepSeek Draft**: Typically more structured and literal",
    "2. **OpenRouter/MiMo Draft**: Typically more creative and reasoning-focused",
    "",
    "## YOUR JOB",
    "1. **Compare** both drafts for accuracy, fluency, and style.",
    "2. **Resolve conflicts** by choosing the best phrasing for each segment.",
    "3. **Merge** the best parts into a FINAL, polished translation.",
    "4. **Document decisions** in the `decisions` array explaining key choices.",
    "",
    "## DECISION CRITERIA",
    "- **Accuracy**: Does it preserve the original meaning exactly?",
    "- **Fluency**: Does it sound natural in the target language?",
    "- **Consistency**: Does it match established terms from the glossaries?",
    "- **Style**: Does it maintain the author's voice and tone?",
    "",
    "## OUTPUT",
    "Return the final JSON matching the schema exactly.",
    "Include `chosen_from` field: 'deepseek', 'openrouter', or 'merged' (if you combined both).",
    "",
    `PromptVersion: ${PROMPT_VERSION}`,
  ].join("\n");

  const user = [
    "# SOURCE PARAGRAPH",
    "```",
    input.source,
    "```",
    "",
    "# DRAFT TRANSLATIONS",
    "",
    "## DeepSeek Draft",
    "```json",
    input.deepseekDraftJson ?? "(missing - provider failed)",
    "```",
    "",
    "## OpenRouter/MiMo Draft",
    "```json",
    input.openrouterDraftJson ?? "(missing - provider failed)",
    "```",
    "",
    "---",
    "Now synthesize the FINAL translation following all merge guidelines.",
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

