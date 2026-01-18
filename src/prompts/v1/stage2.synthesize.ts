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
    "You will receive two draft translations produced independently.",
    "Resolve conflicts, merge the best parts, and output FINAL JSON matching the schema.",
    "Explain key decisions in the `decisions` array.",
    `PromptVersion: ${PROMPT_VERSION}`,
  ].join("\n");

  const user = [
    "SOURCE:",
    input.source,
    "",
    "DRAFTS:",
    `deepseek: ${input.deepseekDraftJson ?? "(missing)"}`,
    `openrouter: ${input.openrouterDraftJson ?? "(missing)"}`,
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

