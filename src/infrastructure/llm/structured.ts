import { z } from "zod";
import { ValidationError } from "../../domain/common/errors";
import type { ChatMessage, LlmClient } from "./types";

export type StructuredCallArgs<TSchema extends z.ZodTypeAny> = {
  client: LlmClient;
  model: string;
  messages: ChatMessage[];
  schema: TSchema;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  seed?: number;
  maxAttempts?: number;
};

function extractJson(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const inline = raw.match(/\{[\s\S]*\}/);
  return inline?.[0] ?? null;
}

function formatIssues(issues: z.ZodIssue[]): string {
  return issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

export async function generateStructured<TSchema extends z.ZodTypeAny>(
  args: StructuredCallArgs<TSchema>,
): Promise<z.infer<TSchema>> {
  const attempts = args.maxAttempts ?? 2;
  let messages = args.messages;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await args.client.chatComplete({
      model: args.model,
      messages,
      temperature: args.temperature ?? 0,
      topP: args.topP,
      maxTokens: args.maxTokens,
      seed: args.seed,
      responseFormat: "json_object",
    });

    const jsonStr = extractJson(res.content);
    if (!jsonStr) {
      if (attempt >= attempts) {
        throw new ValidationError("Model did not return JSON output", res.content);
      }
      messages = messages.concat([
        {
          role: "user",
          content:
            "You must respond with ONLY valid JSON matching the schema. No markdown, no prose.",
        },
      ]);
      continue;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(jsonStr);
    } catch (error) {
      if (attempt >= attempts) {
        throw new ValidationError("Model returned invalid JSON", error);
      }
      messages = messages.concat([
        {
          role: "user",
          content:
            "Your last response was not valid JSON. Respond again with ONLY valid JSON.",
        },
      ]);
      continue;
    }

    const validated = args.schema.safeParse(parsedJson);
    if (validated.success) return validated.data;

    if (attempt >= attempts) {
      throw new ValidationError(
        `Model returned JSON that does not match schema:\n${formatIssues(validated.error.issues)}`,
        validated.error,
      );
    }

    messages = messages.concat([
      {
        role: "user",
        content:
          "The JSON did not match the required schema. Fix it and output ONLY valid JSON.\n" +
          formatIssues(validated.error.issues),
      },
    ]);
  }
  throw new ValidationError("Structured generation failed");
}

