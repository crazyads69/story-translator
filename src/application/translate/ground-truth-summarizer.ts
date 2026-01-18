import { z } from "zod";
import type { LlmClient } from "../../infrastructure/llm/types";
import { generateStructured } from "../../infrastructure/llm/structured";

export const TranslationGuidanceSchema = z.object({
  keepOriginal: z.array(z.string()),
  suggestedTranslations: z.record(z.string()),
  culturalNotes: z.array(z.string()),
  toneGuidance: z.string().optional(),
});

export type TranslationGuidance = z.infer<typeof TranslationGuidanceSchema>;

export type SummarizerInput = {
  paragraph: string;
  searchResults: string[]; // Formatted snippets
  storyMetadata: {
    targetLanguage?: string;
    originalLanguage?: string;
  };
};

/**
 * Summarizes ground truth search results into actionable translation guidance.
 * Ported from old_code.md (lines 3313-3441)
 */
export async function summarizeGroundTruth(
  client: LlmClient,
  model: string,
  input: SummarizerInput
): Promise<TranslationGuidance> {
  if (input.searchResults.length === 0) {
    return {
      keepOriginal: [],
      suggestedTranslations: {},
      culturalNotes: [],
    };
  }

  const resultsText = input.searchResults.join("\n\n");

  const systemPrompt = `Bạn là chuyên gia tư vấn dịch thuật. Dựa trên kết quả tra cứu, hãy đưa ra hướng dẫn dịch thuật cụ thể.

**OUTPUT FORMAT (JSON):**
{
  "keepOriginal": ["term1", "term2"], // Từ nên giữ nguyên không dịch
  "suggestedTranslations": { // Gợi ý cách dịch cụ thể
    "original_term": "suggested_translation"
  },
  "culturalNotes": [ // Ghi chú văn hóa quan trọng
    "note about cultural context"
  ],
  "toneGuidance": "guidance about tone/style" // Optional
}`;

  const userPrompt = `**Đoạn văn gốc:**
"${input.paragraph}"

**Ngôn ngữ đích:** ${input.storyMetadata.targetLanguage || "Vietnamese"}

**Kết quả tra cứu:**
${resultsText}

**Nhiệm vụ:**
Phân tích và đưa ra:
1. Những từ/tên nên GIỮ NGUYÊN (tên riêng, thương hiệu, thuật ngữ quốc tế...)
2. Gợi ý dịch CỤ THỂ cho tiếng lóng, thành ngữ, thuật ngữ
3. Ghi chú văn hóa giúp dịch tự nhiên hơn
4. Hướng dẫn về giọng điệu/phong cách (nếu cần)

Chỉ trả về JSON, không có text khác.`;

  try {
    return await generateStructured({
      client,
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      schema: TranslationGuidanceSchema,
      // DeepSeek recommends temperature=1.0 for data analysis tasks
      // See: https://api-docs.deepseek.com/quick_start/parameter_settings
      temperature: 1.0,
      maxTokens: 1000,
    });
  } catch (error) {
    console.warn("Guidance extraction failed, returning default", error);
    return {
      keepOriginal: [],
      suggestedTranslations: {},
      culturalNotes: [],
    };
  }
}
