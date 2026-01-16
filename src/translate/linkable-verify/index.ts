// This service receive a paragraph have been translated and check with the previouse generated translated paragraphs
// to verify if the linkable words are still linkable after translation. Also perform read full orginal chapter to understand the context.
// Then perform enhancement on the translated paragraph to make sure the new paragprahs is link and connected with the previous paragraphs and all chapter, also the translate (phóng tác) still respoect the original context.
import { createLLMService, type LLMService, GeminiLLM } from "../llm";
import type { ChatMessage } from "../llm";
import type { StoryMetadata } from "../interface";

export class LinkableVerify {
  private llm: LLMService;

  constructor() {
    this.llm = createLLMService({ type: "gemini", model: "gemini-2.5-pro" });
  }

  async verifyAndEnhance(params: {
    originalChapter: string;
    previousTranslatedParagraphs: string[];
    currentTranslatedParagraph: string;
    storyMetadata?: StoryMetadata;
    originalLanguage?: string;
    targetLanguage?: string;
    maxContextChars?: number;
  }): Promise<{
    report: {
      issues: { type: string; description: string; span?: string }[];
      linkableTerms: {
        term: string;
        type: string;
        decision: "keep" | "translate" | "normalize";
        note?: string;
      }[];
      consistencyChecks: {
        aspect: string;
        status: "ok" | "warning" | "error";
        note?: string;
      }[];
    };
    result: {
      enhancedParagraph: string;
      changesSummary: string[];
      openerSentence?: string;
      connectorSuggestions?: string[];
    };
  }> {
    const originalLang = params.originalLanguage || "Unknown";
    const targetLang = params.targetLanguage || "Vietnamese";
    const maxChars = params.maxContextChars ?? 200000;
    const truncate = (t: string) =>
      t.length > maxChars ? t.slice(0, maxChars) : t;

    const meta = params.storyMetadata
      ? [
          `Tên: ${params.storyMetadata.title}`,
          `Tác giả: ${params.storyMetadata.author || "Unknown"}`,
          `Thể loại: ${params.storyMetadata.category || "N/A"}`,
          `Ngôn ngữ gốc: ${
            params.storyMetadata.originalLanguage || originalLang
          }`,
          `Ngôn ngữ đích: ${params.storyMetadata.targetLanguage || targetLang}`,
          params.storyMetadata.description
            ? `Mô tả: ${params.storyMetadata.description}`
            : "",
        ]
          .filter(Boolean)
          .join("\n")
      : `Ngôn ngữ gốc: ${originalLang}\nNgôn ngữ đích: ${targetLang}`;

    const systemPrompt = [
      "Bạn là chuyên gia kiểm định liên kết văn bản dịch văn học.",
      "Mục tiêu: kiểm tra và tăng cường tính liên kết của đoạn dịch hiện tại với các đoạn dịch trước và toàn bộ chương gốc.",
      "Bắt buộc giữ nguyên SỰ THẬT: nhân vật, sự kiện, quan hệ, mốc thời gian, địa điểm, giọng kể.",
      "Cho phép phóng tác ở mức diễn đạt để tiếng Việt mượt, giàu hình ảnh, tự nhiên, nhưng không thay đổi nội dung sự kiện.",
      "Yêu cầu:",
      "- Phát hiện thuật ngữ/tên riêng/danh xưng/địa danh cần giữ nguyên hay chuẩn hóa.",
      "- Kiểm tra tính nhất quán xưng hô, ngôi kể, thời tính, giọng điệu.",
      "- Đề xuất câu mở đầu hoặc cầu nối nếu đoạn hiện tại chưa liền mạch.",
      "- Trả về JSON theo schema yêu cầu, không kèm văn bản khác.",
    ].join("\n");

    const prevTranslated = params.previousTranslatedParagraphs
      .map((p, i) => `[#${i + 1}] ${p}`)
      .join("\n\n");

    const userPrompt = [
      "**THÔNG TIN TRUYỆN:**",
      meta,
      "",
      "**CHƯƠNG GỐC:**",
      truncate(params.originalChapter),
      "",
      "**CÁC ĐOẠN DỊCH TRƯỚC:**",
      prevTranslated || "(Không có)",
      "",
      "**ĐOẠN DỊCH HIỆN TẠI:**",
      params.currentTranslatedParagraph,
      "",
      "**NHIỆM VỤ:**",
      [
        "1) Phân tích liên kết và phát hiện sai lệch sự thật.",
        "2) Liệt kê thuật ngữ/tên riêng/danh xưng/địa danh và quyết định keep/translate/normalize.",
        "3) Kiểm tra nhất quán: xưng hô, ngôi kể, thời tính, sự kiện, địa điểm.",
        "4) Viết phiên bản ENHANCED của đoạn dịch hiện tại bằng tiếng Việt:",
        "   - Giữ nguyên sự thật, không thay đổi nội dung sự kiện.",
        "   - Cho phép phóng tác diễn đạt để mượt mà, giàu hình ảnh.",
        "   - Nếu cần, thêm 1 câu mở đầu tự nhiên để nối mạch, hoặc đề xuất từ nối.",
      ].join("\n"),
      "",
      "**OUTPUT JSON:**",
      [
        "{",
        '  "report": {',
        '    "issues": [ { "type": "entity_mismatch", "description": "", "span": "" } ],',
        '    "linkableTerms": [ { "term": "", "type": "", "decision": "keep", "note": "" } ],',
        '    "consistencyChecks": [ { "aspect": "voice", "status": "ok", "note": "" } ]',
        "  },",
        '  "result": {',
        '    "enhancedParagraph": "",',
        '    "changesSummary": [ "..." ],',
        '    "openerSentence": "",',
        '    "connectorSuggestions": [ "..." ]',
        "  }",
        "}",
      ].join("\n"),
      "",
      "Chỉ trả về JSON hợp lệ, không thêm văn bản nào khác.",
    ].join("\n");

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const provider = this.llm.getProvider();
    let raw: string;
    if (provider instanceof GeminiLLM) {
      const r = await provider.generate(messages, {
        maxTokens: 4000,
        temperature: 0.3,
        stop: [],
        thinking: { budget: -1 },
      });
      raw = r.content;
    } else {
      const r = await this.llm.generate(messages, {
        maxTokens: 4000,
        temperature: 0.3,
        stop: [],
      });
      raw = r.content;
    }

    const jsonBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr =
      (jsonBlock && jsonBlock[1] ? jsonBlock[1].trim() : null) ||
      raw.match(/\{[\s\S]*\}/)?.[0] ||
      null;

    if (!jsonStr) {
      return {
        report: {
          issues: [],
          linkableTerms: [],
          consistencyChecks: [],
        },
        result: {
          enhancedParagraph: params.currentTranslatedParagraph,
          changesSummary: [],
          openerSentence: undefined,
          connectorSuggestions: [],
        },
      };
    }

    try {
      const parsed = JSON.parse(jsonStr);
      return {
        report: {
          issues: Array.isArray(parsed?.report?.issues)
            ? parsed.report.issues
            : [],
          linkableTerms: Array.isArray(parsed?.report?.linkableTerms)
            ? parsed.report.linkableTerms
            : [],
          consistencyChecks: Array.isArray(parsed?.report?.consistencyChecks)
            ? parsed.report.consistencyChecks
            : [],
        },
        result: {
          enhancedParagraph:
            typeof parsed?.result?.enhancedParagraph === "string"
              ? parsed.result.enhancedParagraph
              : params.currentTranslatedParagraph,
          changesSummary: Array.isArray(parsed?.result?.changesSummary)
            ? parsed.result.changesSummary
            : [],
          openerSentence:
            typeof parsed?.result?.openerSentence === "string"
              ? parsed.result.openerSentence
              : undefined,
          connectorSuggestions: Array.isArray(
            parsed?.result?.connectorSuggestions
          )
            ? parsed.result.connectorSuggestions
            : [],
        },
      };
    } catch {
      return {
        report: {
          issues: [],
          linkableTerms: [],
          consistencyChecks: [],
        },
        result: {
          enhancedParagraph: params.currentTranslatedParagraph,
          changesSummary: [],
          openerSentence: undefined,
          connectorSuggestions: [],
        },
      };
    }
  }
}
