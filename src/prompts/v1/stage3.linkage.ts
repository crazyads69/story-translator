import type { ChatMessage } from "../../infrastructure/llm/types";

export type LinkagePromptInput = {
  originalChapter: string;
  previousTranslatedParagraphs: string[];
  currentTranslatedParagraph: string;
  storyMetadata?: {
    title?: string;
    author?: string;
    category?: string;
    originalLanguage?: string;
    targetLanguage?: string;
    description?: string;
  };
  originalLanguage?: string;
  targetLanguage?: string;
  maxContextChars?: number;
};

const truncate = (t: string, max: number) =>
  t.length > max ? t.slice(0, max) : t;

export function buildLinkageMessages(input: LinkagePromptInput): {
  messages: ChatMessage[];
} {
  const originalLang = input.originalLanguage || "Unknown";
  const targetLang = input.targetLanguage || "Vietnamese";
  const maxChars = input.maxContextChars ?? 200000;

  const meta = input.storyMetadata
    ? [
        `Tên: ${input.storyMetadata.title || "Unknown"}`,
        `Tác giả: ${input.storyMetadata.author || "Unknown"}`,
        `Thể loại: ${input.storyMetadata.category || "N/A"}`,
        `Ngôn ngữ gốc: ${
          input.storyMetadata.originalLanguage || originalLang
        }`,
        `Ngôn ngữ đích: ${
          input.storyMetadata.targetLanguage || targetLang
        }`,
        input.storyMetadata.description
          ? `Mô tả: ${input.storyMetadata.description}`
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

  const prevTranslated = input.previousTranslatedParagraphs
    .map((p, i) => `[#${i + 1}] ${p}`)
    .join("\n\n");

  const userPrompt = [
    "**THÔNG TIN TRUYỆN:**",
    meta,
    "",
    "**CHƯƠNG GỐC (Trích đoạn):**",
    truncate(input.originalChapter, maxChars),
    "",
    "**CÁC ĐOẠN DỊCH TRƯỚC:**",
    prevTranslated || "(Không có)",
    "",
    "**ĐOẠN DỊCH HIỆN TẠI:**",
    input.currentTranslatedParagraph,
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
      '  },',
      '  "result": {',
      '    "enhancedParagraph": "...",',
      '    "changesSummary": [ "..." ],',
      '    "openerSentence": "...",',
      '    "connectorSuggestions": [ "..." ]',
      '  }',
      "}",
    ].join("\n"),
    "",
    "Chỉ trả về JSON hợp lệ, không thêm văn bản nào khác.",
  ].join("\n");

  return {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  };
}
