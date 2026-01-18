import { z } from "zod";
import type { LlmClient } from "../../infrastructure/llm/types";
import { generateStructured } from "../../infrastructure/llm/structured";

// ----------------------------------------------------------------------------
// RAG Query Generation (Internal Context)
// ----------------------------------------------------------------------------

export const RagQuerySchema = z.array(z.string()).min(1);
export type RagQueries = z.infer<typeof RagQuerySchema>;

export type RagQueryInput = {
  paragraph: string;
  storyMetadata: {
    title?: string;
    author?: string;
    description?: string;
  };
};

export async function generateRagQueries(
  client: LlmClient,
  model: string,
  input: RagQueryInput,
): Promise<string[]> {
  const systemPrompt = `Bạn là chuyên gia phân tích văn bản tiểu thuyết và tối ưu hóa truy vấn tìm kiếm vector.

**NHIỆM VỤ:** Tạo các truy vấn tìm kiếm tối ưu để tìm các đoạn văn LIÊN QUAN trong cùng câu chuyện từ cơ sở dữ liệu đã lưu trữ.

**MỤC ĐÍCH TÌM KIẾM:**
1. **Ngữ cảnh nhân vật**: Các đoạn trước đó giới thiệu, mô tả nhân vật xuất hiện trong đoạn hiện tại
2. **Phong cách dịch**: Cách các thuật ngữ, tên riêng, danh xưng đã được dịch trước đó
3. **Tính nhất quán**: Giọng điệu, cách xưng hô, phong cách viết đã sử dụng
4. **Bối cảnh câu chuyện**: Các sự kiện, địa điểm liên quan đã được đề cập

**CHIẾN LƯỢC TẠO TRUY VẤN:**
- Truy vấn 1: Tập trung vào TÊN NHÂN VẬT chính + hành động/tình huống
- Truy vấn 2: Tập trung vào ĐỊA ĐIỂM/BỐI CẢNH + không khí/cảm xúc
- Truy vấn 3: Tập trung vào MỐI QUAN HỆ giữa các nhân vật
- Truy vấn 4: Tập trung vào THUẬT NGỮ/DANH XƯNG đặc biệt
- Truy vấn 5: Tập trung vào CHỦ ĐỀ/SỰ KIỆN quan trọng

**QUY TẮC:**
- Mỗi truy vấn 5-20 từ, tập trung vào từ khóa semantic
- Sử dụng ngôn ngữ GỐC của đoạn văn (không dịch)
- Ưu tiên tên riêng, địa danh, thuật ngữ đặc trưng
- Truy vấn phải đủ cụ thể để tìm đúng ngữ cảnh

**OUTPUT:** JSON array chứa 3-5 truy vấn. Không giải thích.`;

  const userPrompt = `**THÔNG TIN TRUYỆN:**
- Tên: ${input.storyMetadata.title || "N/A"}
- Tác giả: ${input.storyMetadata.author || "Unknown"}
- Mô tả: ${input.storyMetadata.description || "N/A"}

**ĐOẠN VĂN CẦN TÌM NGỮ CẢNH:**
"""
${input.paragraph}
"""

**PHÂN TÍCH VÀ TẠO TRUY VẤN:**
1. Xác định các THỰC THỂ quan trọng (nhân vật, địa điểm, đồ vật)
2. Xác định HÀNH ĐỘNG/SỰ KIỆN chính đang diễn ra
3. Xác định MỐI QUAN HỆ giữa các thực thể
4. Xác định TÂM TRẠNG/KHÔNG KHÍ của đoạn văn
5. Tạo truy vấn tối ưu cho vector search

Chỉ trả về JSON array, không có text khác.`;

  try {
    const result = await generateStructured({
      client,
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      schema: z.object({ queries: RagQuerySchema }), // Wrap in object for stable parsing
      temperature: 0.3,
      maxTokens: 500,
    });
    return result.queries.slice(0, 5);
  } catch (error) {
    console.warn(
      "Failed to generate RAG queries, falling back to heuristic",
      error,
    );
    // Fallback: simple keyword extraction heuristic
    return [input.paragraph.slice(0, 100)];
  }
}

// ----------------------------------------------------------------------------
// Ground Truth Query Generation (External Web Search)
// ----------------------------------------------------------------------------

export const ResearchCategorySchema = z.enum([
  "location",
  "culture",
  "slang",
  "idiom",
  "trending",
  "knowledge",
  "season",
  "event",
  "food",
  "fashion",
  "name",
  "history",
  "mythology",
  "pop_culture",
  "dialect",
  "onomatopoeia",
  "measurement",
  "profession",
]);

export const GroundTruthQuerySchema = z.object({
  query: z.string(),
  category: ResearchCategorySchema,
  reason: z.string(),
  priority: z.number().optional(),
  searchLang: z.string().optional(),
});

export const GroundTruthQueriesResponseSchema = z.object({
  queries: z.array(GroundTruthQuerySchema),
});

export type GroundTruthQuery = z.infer<typeof GroundTruthQuerySchema>;

export type GroundTruthQueryInput = {
  paragraph: string;
  storyMetadata: {
    title?: string;
    author?: string;
    description?: string;
    originalLanguage?: string;
    targetLanguage?: string;
  };
  maxQueries?: number;
};

export async function generateGroundTruthQueries(
  client: LlmClient,
  model: string,
  input: GroundTruthQueryInput,
): Promise<GroundTruthQuery[]> {
  const maxQueries = input.maxQueries ?? 5;

  const systemPrompt = `Bạn là chuyên gia phân tích văn bản và nghiên cứu đa lĩnh vực để hỗ trợ dịch thuật chuyên nghiệp.

**NHIỆM VỤ:** Phân tích đoạn văn và xác định TẤT CẢ các khía cạnh cần tra cứu thêm để dịch chính xác và tự nhiên.

**CÁC DANH MỤC CẦN XEM XÉT:**
1. **location** - Địa điểm: tên địa danh, đặc điểm địa lý, địa chỉ cụ thể
2. **culture** - Văn hóa: phong tục, tập quán, lễ nghi, đồ ăn, trang phục
3. **slang** - Tiếng lóng: từ ngữ bình dân, tiếng lóng internet
4. **idiom** - Thành ngữ: tục ngữ, thành ngữ, cách nói cố định
5. **knowledge** - Kiến thức: thuật ngữ chuyên môn, định nghĩa
6. **history** - Lịch sử: bối cảnh thời đại, sự kiện lịch sử
7. **mythology** - Thần thoại: truyền thuyết, tham chiếu tôn giáo
8. **pop_culture** - Văn hóa đại chúng: phim, nhạc, người nổi tiếng
9. **dialect** - Phương ngữ: cách nói vùng miền
10. **profession** - Nghề nghiệp: thuật ngữ ngành nghề

**QUY TẮC:**
- Mỗi truy vấn phải CỤ THỂ và có thể tìm kiếm được trên Google/Brave
- Ưu tiên những gì QUAN TRỌNG NHẤT cho việc dịch
- Gán priority: 1 (rất quan trọng) đến 3 (bổ sung)
- **QUAN TRỌNG**: Với mỗi vấn đề cần tra cứu, hãy tạo 2 truy vấn:
  1. Một truy vấn bằng ngôn ngữ gốc (ví dụ: tiếng Anh/Trung/Nhật) để tìm thông tin chính xác.
  2. Một truy vấn bằng tiếng Việt (hoặc ngôn ngữ đích) để tìm cách dịch phổ biến.
- Gợi ý searchLang phù hợp (vi, en, zh, ja, ko...)
- Tối đa ${maxQueries} cặp truy vấn (tổng cộng ${maxQueries * 2} truy vấn đơn lẻ, nhưng output JSON chỉ cần danh sách phẳng)

**OUTPUT:** JSON object chứa mảng "queries".`;

  const userPrompt = `**THÔNG TIN TRUYỆN:**
- Tên: ${input.storyMetadata.title || "N/A"}
- Tác giả: ${input.storyMetadata.author || "Unknown"}
- Ngôn ngữ gốc: ${input.storyMetadata.originalLanguage || "Unknown"}
- Ngôn ngữ đích: ${input.storyMetadata.targetLanguage || "Vietnamese"}
- Bối cảnh: ${input.storyMetadata.description || "N/A"}

**ĐOẠN VĂN CẦN PHÂN TÍCH:**
"""
${input.paragraph}
"""

**YÊU CẦU:**
Phân tích đoạn văn và tạo truy vấn tìm kiếm cho các thực thể, văn hóa, thuật ngữ, tên riêng, v.v. cần tra cứu.`;

  try {
    const result = await generateStructured({
      client,
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      schema: GroundTruthQueriesResponseSchema,
      temperature: 0.3,
      maxTokens: 1000,
    });

    return result.queries
      .sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2))
      .slice(0, maxQueries);
  } catch (error) {
    console.warn("Failed to generate Ground Truth queries", error);
    return [];
  }
}
