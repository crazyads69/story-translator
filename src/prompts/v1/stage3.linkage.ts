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
    "# CHUYÊN GIA KIỂM ĐỊNH LIÊN KẾT VĂN BẢN DỊCH",
    "",
    "Bạn là chuyên gia kiểm định chất lượng bản dịch văn học, đảm bảo tính liên kết và nhất quán của văn bản.",
    "",
    "## MỤC TIÊU",
    "1. **Kiểm tra liên kết**: Đoạn dịch hiện tại phải mượt mà với các đoạn trước.",
    "2. **Bảo toàn sự thật**: Giữ nguyên nhân vật, sự kiện, quan hệ, mốc thời gian, địa điểm.",
    "3. **Nhất quán xưng hô**: Đảm bảo cách xưng hô (anh/em, tôi/bạn, etc.) nhất quán xuyên suốt.",
    "4. **Giọng kể thống nhất**: Duy trì ngôi kể (ngôi 1, ngôi 3) và thời tính nhất quán.",
    "",
    "## NGUYÊN TẮC CHỈNH SỬA",
    "- **BẮT BUỘC giữ nguyên**: Nội dung sự kiện, tên riêng, địa danh, mốc thời gian.",
    "- **CHO PHÉP phóng tác**: Diễn đạt để tiếng Việt mượt mà, giàu hình ảnh, tự nhiên.",
    "- **CÂU MỞ ĐẦU**: Nếu đoạn hiện tại chưa liền mạch, thêm/sửa câu mở để nối mạch.",
    "- **TỪ NỐI**: Đề xuất từ nối phù hợp (rồi, sau đó, thế là, vậy mà, tuy nhiên...).",
    "",
    "## LINKABLE TERMS",
    "Phân loại các thuật ngữ:",
    "- **keep**: Giữ nguyên không dịch (tên riêng quốc tế, thương hiệu)",
    "- **translate**: Dịch ra tiếng Việt",
    "- **normalize**: Chuẩn hóa theo cách dịch đã dùng trước đó",
    "",
    "## OUTPUT",
    "Trả về JSON theo schema, không kèm văn bản khác.",
  ].join("\n");

  const prevTranslated = input.previousTranslatedParagraphs
    .map((p, i) => `[#${i + 1}] ${p}`)
    .join("\n\n");

  const userPrompt = [
    "# THÔNG TIN TRUYỆN",
    meta,
    "",
    "# CHƯƠNG GỐC (Trích đoạn)",
    "```",
    truncate(input.originalChapter, maxChars),
    "```",
    "",
    "# CÁC ĐOẠN DỊCH TRƯỚC",
    prevTranslated || "(Không có - đây là đoạn đầu tiên)",
    "",
    "# ĐOẠN DỊCH HIỆN TẠI (Cần kiểm tra)",
    "```",
    input.currentTranslatedParagraph,
    "```",
    "",
    "---",
    "",
    "# NHIỆM VỤ",
    "1. **Phân tích liên kết**: Phát hiện sai lệch sự thật so với đoạn trước.",
    "2. **Liệt kê thuật ngữ**: Tên riêng, danh xưng, địa danh → quyết định keep/translate/normalize.",
    "3. **Kiểm tra nhất quán**: Xưng hô, ngôi kể, thời tính, sự kiện, địa điểm.",
    "4. **Viết phiên bản ENHANCED**:",
    "   - Giữ nguyên sự thật, không thay đổi nội dung sự kiện.",
    "   - Phóng tác diễn đạt để mượt mà, giàu hình ảnh.",
    "   - Thêm câu mở đầu tự nhiên nếu cần.",
    "",
    "# OUTPUT JSON SCHEMA",
    "```json",
    "{",
    '  "report": {',
    '    "issues": [ { "type": "entity_mismatch|pronoun_inconsistency|timeline_error|...", "description": "", "span": "" } ],',
    '    "linkableTerms": [ { "term": "", "type": "character|location|title|...", "decision": "keep|translate|normalize", "note": "" } ],',
    '    "consistencyChecks": [ { "aspect": "voice|pronoun|tense|event|location", "status": "ok|warning|error", "note": "" } ]',
    '  },',
    '  "result": {',
    '    "enhancedParagraph": "Đoạn dịch đã được cải thiện...",',
    '    "changesSummary": [ "Sửa xưng hô từ X sang Y", "Thêm câu mở đầu..." ],',
    '    "openerSentence": "Câu mở đầu gợi ý nếu cần",',
    '    "connectorSuggestions": [ "rồi", "sau đó", "thế là" ]',
    '  }',
    "}",
    "```",
  ].join("\n");

  return {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  };
}
