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
   */
  async generateContextQueries(
    paragraph: string,
    storyMetadata: StoryMetadata
  ): Promise<string[]> {
    const characterInfo = this.buildCharacterInfo(storyMetadata);

    const systemPrompt = `Bạn là chuyên gia phân tích văn bản tiểu thuyết. Nhiệm vụ: tạo các truy vấn tìm kiếm tối ưu để tìm ngữ cảnh liên quan trong cơ sở dữ liệu vector.

Hãy suy nghĩ sâu về:
- Các nhân vật và mối quan hệ của họ
- Bối cảnh, địa điểm quan trọng
- Hành động, sự kiện đang diễn ra
- Các thuật ngữ, tên riêng cần giữ nguyên hoặc dịch chính xác
- Phong cách ngôn ngữ và giọng điệu

**Quy tắc:**
- Mỗi truy vấn ngắn gọn (5-15 từ)
- Tập trung vào từ khóa quan trọng
- Không giải thích, chỉ liệt kê truy vấn

Trả về CHÍNH XÁC một JSON array chứa 3-5 truy vấn tìm kiếm.

Format: ["query 1", "query 2", "query 3", "query 4", "query 5"]`;

    const userPrompt = `**Thông tin truyện:**
- Tên truyện: ${storyMetadata.title}
- Tác giả: ${storyMetadata.author || 'Unknown'}
- Thể loại: ${storyMetadata.category || 'N/A'}
- Mô tả: ${storyMetadata.description || 'N/A'}
- Nhân vật chính:
  - ${characterInfo}

**Đoạn văn cần phân tích:**
${paragraph}

**Nhiệm vụ:**
Tạo 3-5 truy vấn tìm kiếm để tìm các đoạn văn có liên quan. Mỗi truy vấn nên tập trung vào:
1. Nhân vật xuất hiện trong đoạn
2. Hành động chính diễn ra
3. Địa điểm/bối cảnh
4. Cảm xúc/tâm trạng
5. Sự kiện quan trọng

Chỉ trả về JSON array, không có text khác.`;

    try {
      // Use generic LLM service (configured with deepseek-reasoner) for intelligent query generation
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

      // Extract JSON from response
      const jsonMatch = response.content.match(/\[.*\]/s);
      if (!jsonMatch) {
        throw new Error('No JSON array found in response');
      }

      const queries = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(queries) || queries.length === 0) {
        throw new Error('Invalid queries array');
      }

      return queries.slice(0, 5); // Max 5 queries
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