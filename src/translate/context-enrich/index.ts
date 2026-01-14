import { createLanceDBService, type SearchResult } from "../../ingest/vectordb";
import { createOpenRouterEmbeddings } from '../../ingest/embedding/index';
import { createLLMService, type LLMService } from "../llm";
import type { EnrichedContext, StoryMetadata } from "../interface";

export class ContextEnricher {
  private lancedb: ReturnType<typeof createLanceDBService>;
  private embeddings: ReturnType<typeof createOpenRouterEmbeddings>;
  private llmService: LLMService;

  constructor() {
    this.lancedb = createLanceDBService({ initReranker: true });
    this.embeddings = createOpenRouterEmbeddings();
    this.llmService = createLLMService({ type: 'deepseek', model: 'deepseek-reasoner' });
  }

  async initialize(): Promise<void> {
    await this.lancedb.connect();
  }

  /**
   * Build character info string for prompt
   */
  private buildCharacterInfo(storyMetadata: StoryMetadata): string {
    if (!storyMetadata.characters || storyMetadata.characters.length === 0) {
      return 'N/A';
    }

    return storyMetadata.characters
      .map(c => {
        let info = c.name;
        if (c.role) info += ` (${c.role})`;
        if (c.description) info += `: ${c.description}`;
        if (c.aliases && c.aliases.length > 0) info += ` [biệt danh: ${c.aliases.join(', ')}]`;
        return info;
      })
      .join('\n  - ');
  }

  /**
   * Generate contextual queries using DeepSeek reasoning
   * Uses deep thinking to analyze paragraph and create optimal search queries
   * for finding relevant context from ingested story data (original + translated)
   */
  async generateContextQueries(
    paragraph: string,
    storyMetadata: StoryMetadata
  ): Promise<string[]> {
    const characterInfo = this.buildCharacterInfo(storyMetadata);

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

**OUTPUT:** JSON array chứa 3-5 truy vấn. Không giải thích.
Format: ["query 1", "query 2", "query 3"]`;

    const userPrompt = `**THÔNG TIN TRUYỆN:**
- Tên: ${storyMetadata.title}
- Tác giả: ${storyMetadata.author || 'Unknown'}
- Thể loại: ${storyMetadata.category || 'N/A'}
- Ngôn ngữ gốc: ${storyMetadata.originalLanguage || 'Unknown'}
- Mô tả: ${storyMetadata.description || 'N/A'}
- Nhân vật:
  - ${characterInfo}

**ĐOẠN VĂN CẦN TÌM NGỮ CẢNH:**
"""
${paragraph}
"""

**PHÂN TÍCH VÀ TẠO TRUY VẤN:**

1. Xác định các THỰC THỂ quan trọng (nhân vật, địa điểm, đồ vật)
2. Xác định HÀNH ĐỘNG/SỰ KIỆN chính đang diễn ra
3. Xác định MỐI QUAN HỆ giữa các thực thể
4. Xác định TÂM TRẠNG/KHÔNG KHÍ của đoạn văn
5. Tạo truy vấn tối ưu cho vector search

Chỉ trả về JSON array, không có text khác.`;

    try {
      const response = await this.llmService.generate(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        { maxTokens: 1000 }
      );

      // Log reasoning for debugging (available when using deepseek-reasoner)
      if (response.reasoningContent) {
        console.log(`    - Reasoning tokens used: ${response.usage?.reasoningTokens || 'N/A'}`);
      }

      // Extract JSON from response - try multiple patterns
      const content = response.content;
      let jsonStr: string | null = null;

      // Pattern 1: Code block
      const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch && codeBlockMatch[1]) {
        jsonStr = codeBlockMatch[1].trim();
      }

      // Pattern 2: Raw array
      if (!jsonStr) {
        const arrayMatch = content.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          jsonStr = arrayMatch[0];
        }
      }

      if (!jsonStr) {
        throw new Error('No JSON array found in response');
      }

      const queries = JSON.parse(jsonStr);
      if (!Array.isArray(queries) || queries.length === 0) {
        throw new Error('Invalid queries array');
      }

      return queries.filter((q): q is string => typeof q === 'string' && q.length > 0).slice(0, 5);
    } catch (error) {
      console.error("  ⚠️  Query generation failed:", error);
      // Minimal fallback - extract key terms from paragraph
      const words = paragraph.split(/\s+/).filter(w => w.length > 3);
      return [paragraph.substring(0, 100), words.slice(0, 10).join(' ')];
    }
  }


  /**
   * Enrich context using RAG with DeepSeek reasoning-generated queries
   */
  async enrichContext(
    paragraph: string,
    storyId: string,
    chapterId: string,
    storyMetadata: StoryMetadata
  ): Promise<EnrichedContext> {
    console.log(`    - Generating contextual queries with DeepSeek reasoning...`);
    
    // Generate intelligent queries using DeepSeek reasoner
    const queries = await this.generateContextQueries(paragraph, storyMetadata);
    console.log(`    - Generated ${queries.length} queries`);

    const allOriginalResults: SearchResult[] = [];
    const allTranslatedResults: SearchResult[] = [];

    // Search with each query using hybridSearchWithRerank only
    for (const query of queries) {
      const queryVector = await this.embeddings.embedText(query);

      // Search original content with reranking
      const originalResults = await this.lancedb.hybridSearchWithRerank(
        query,
        queryVector,
        2, // limit
        {
          content_type: "original",
          story_id: storyId,
        }
      );

      // Search translated content for style reference with reranking
      const translatedResults = await this.lancedb.hybridSearchWithRerank(
        query,
        queryVector,
        2, // limit
        {
          content_type: "translated",
          story_id: storyId,
        }
      );

      allOriginalResults.push(...originalResults);
      allTranslatedResults.push(...translatedResults);
    }

    // Deduplicate by paragraph_text
    const uniqueOriginal = this.deduplicateResults(allOriginalResults);
    const uniqueTranslated = this.deduplicateResults(allTranslatedResults);

    console.log(`    - Found ${uniqueOriginal.length} original + ${uniqueTranslated.length} translated paragraphs`);

    return {
      original_similar_paragraphs: uniqueOriginal.map(r => r.paragraph_text),
      translated_similar_paragraphs: uniqueTranslated.map(r => r.paragraph_text),
      relevance_scores: uniqueOriginal.map(r => r._rerank_score || 0),
      generated_queries: queries,
    };
  }

  private deduplicateResults(results: SearchResult[]): SearchResult[] {
    const seen = new Set<string>();
    const unique: SearchResult[] = [];

    for (const result of results) {
      if (!seen.has(result.paragraph_text)) {
        seen.add(result.paragraph_text);
        unique.push(result);
      }
    }

    // Sort by rerank score (highest first)
    return unique
      .sort((a, b) => (b._rerank_score || 0) - (a._rerank_score || 0))
      .slice(0, 3); // Keep top 3
  }
}