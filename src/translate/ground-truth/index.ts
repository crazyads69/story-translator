// Ground Truth Service for translation context enrichment
// Uses LLM to generate queries and Brave Search API to get external context
// (trending, knowledge, slang, locations, culture, etc.)

import { createLLMService, type LLMService } from "../llm";
import type { StoryMetadata } from "../interface";

// ============================================================================
// Types
// ============================================================================

/** Search result from Brave Search API */
export interface BraveSearchResult {
  title: string;
  url: string;
  description?: string;
  extra_snippets?: string[];
}

/** Research category for translation */
export type ResearchCategory =
  | 'location'      // Geographic info, landmarks, addresses
  | 'culture'       // Customs, traditions, festivals, etiquette
  | 'slang'         // Informal language, internet slang, colloquialisms
  | 'idiom'         // Proverbs, idioms, fixed expressions
  | 'trending'      // Current events, viral content, memes
  | 'knowledge'     // Technical terms, definitions, facts
  | 'season'        // Weather, climate, seasonal activities
  | 'event'         // Holidays, celebrations, historical events
  | 'food'          // Cuisine, dishes, ingredients, cooking terms
  | 'fashion'       // Clothing, traditional garments, style terms
  | 'name'          // Name meanings, transliteration, honorifics
  | 'history'       // Historical context, period-specific info
  | 'mythology'     // Folklore, legends, religious references
  | 'pop_culture'   // Movies, music, celebrities, games
  | 'dialect'       // Regional language variations
  | 'onomatopoeia'  // Sound words, exclamations
  | 'measurement'   // Units, currency, conversions
  | 'profession';   // Industry jargon, occupational terms

/** Generated query from LLM */
export interface GroundTruthQuery {
  query: string;
  category: ResearchCategory;
  reason: string;
  priority?: number;
  searchLang?: string;
}

/** Search result with context */
export interface CategorySearchResult {
  category: ResearchCategory;
  query: string;
  snippets: string[];
  sources?: string[];
}

/** Translation guidance */
export interface TranslationGuidance {
  keepOriginal: string[];
  suggestedTranslations: Record<string, string>;
  culturalNotes: string[];
  toneGuidance?: string;
}

/** Ground truth context result */
export interface GroundTruthContext {
  queries: GroundTruthQuery[];
  results: CategorySearchResult[];
  summary: string;
  translationGuidance?: TranslationGuidance;
  metadata?: {
    totalQueries: number;
    successfulSearches: number;
    processingTimeMs: number;
  };
}

// ============================================================================
// GroundTruthService
// ============================================================================

export class GroundTruthService {
  private llmService: LLMService;
  private braveApiKey: string;
  private baseUrl = 'https://api.search.brave.com/res/v1/web/search';
  private cache = new Map<string, BraveSearchResult[]>();

  // Rate limiting: Brave API uses 1-second sliding window (1 request/second)
  private lastRequestTime = 0;
  private readonly minInterval = 1050; // 1.05s to be safe
  private readonly maxRetries = 3;

  constructor(options?: {
    llmType?: 'deepseek' | 'openrouter' | 'gemini';
    model?: string;
  }) {
    this.llmService = createLLMService({
      type: options?.llmType ?? 'deepseek',
      model: options?.model ?? 'deepseek-reasoner',
    });

    const apiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) {
      throw new Error(
        'BRAVE_SEARCH_API_KEY environment variable is required.\n' +
        'Get your API key at: https://brave.com/search/api/'
      );
    }
    this.braveApiKey = apiKey;
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Wait for rate limit (1 request per second)
   */
  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minInterval) {
      const waitTime = this.minInterval - elapsed;
      await this.sleep(waitTime);
    }
    this.lastRequestTime = Date.now();
  }

  private buildCharacterInfo(storyMetadata: StoryMetadata): string {
    if (!storyMetadata.characters || storyMetadata.characters.length === 0) {
      return 'N/A';
    }
    return storyMetadata.characters
      .map((c) => {
        let info = c.name;
        if (c.role) info += ` (${c.role})`;
        if (c.description) info += `: ${c.description}`;
        if (c.aliases && c.aliases.length > 0) info += ` [aliases: ${c.aliases.join(', ')}]`;
        return info;
      })
      .join('\n  - ');
  }

  private emptyResult(startTime: number): GroundTruthContext {
    return {
      queries: [],
      results: [],
      summary: '',
      metadata: {
        totalQueries: 0,
        successfulSearches: 0,
        processingTimeMs: Date.now() - startTime,
      },
    };
  }

  clearCache(): void {
    this.cache.clear();
  }

  // ============================================================================
  // Core Methods
  // ============================================================================

  /**
   * Main entry point - get ground truth context for a paragraph
   */
  async getGroundTruthContext(
    paragraph: string,
    storyMetadata: StoryMetadata,
    options?: {
      maxQueries?: number;
      searchLang?: string;
      includeGuidance?: boolean;
    }
  ): Promise<GroundTruthContext> {
    const startTime = Date.now();
    
    // Step 1: Generate queries using LLM
    console.log('    - Generating search queries...');
    const queries = await this.generateQueries(paragraph, storyMetadata, {
      maxQueries: options?.maxQueries ?? 5
    });
    
    if (queries.length === 0) {
      return this.emptyResult(startTime);
    }

    console.log(`    - Generated ${queries.length} queries`);
    queries.forEach((q, i) => console.log(`      ${i + 1}. [${q.category}] "${q.query}"`));

    // Step 2: Execute searches sequentially (rate limited)
    console.log('    - Searching...');
    const results = await this.executeSearches(queries, options?.searchLang);
    const successfulSearches = results.filter(r => r.snippets.length > 0).length;
    console.log(`    - Found results for ${successfulSearches}/${queries.length} queries`);

    // Step 3: Generate summary
    console.log('    - Generating summary...');
    const summary = await this.generateSummary(paragraph, results, storyMetadata);

    // Step 4: Extract translation guidance (optional)
    let translationGuidance: TranslationGuidance | undefined;
    if (options?.includeGuidance !== false && results.length > 0) {
      console.log('    - Extracting translation guidance...');
      translationGuidance = await this.extractGuidance(paragraph, results, storyMetadata);
    }

    return {
      queries,
      results,
      summary,
      translationGuidance,
      metadata: {
        totalQueries: queries.length,
        successfulSearches,
        processingTimeMs: Date.now() - startTime,
      },
    };
  }

  /**
   * Generate search queries using LLM
   */
  async generateQueries(
    paragraph: string,
    storyMetadata: StoryMetadata,
    options?: { maxQueries?: number }
  ): Promise<GroundTruthQuery[]> {
    const maxQueries = options?.maxQueries ?? 5;
    const characterInfo = this.buildCharacterInfo(storyMetadata);

    const systemPrompt = `Bạn là chuyên gia phân tích văn bản và nghiên cứu đa lĩnh vực để hỗ trợ dịch thuật chuyên nghiệp.

**NHIỆM VỤ:** Phân tích đoạn văn và xác định TẤT CẢ các khía cạnh cần tra cứu thêm để dịch chính xác và tự nhiên.

**CÁC DANH MỤC CẦN XEM XÉT:**

1. **location** - Địa điểm: tên địa danh, đặc điểm địa lý, địa chỉ cụ thể, khoảng cách
2. **culture** - Văn hóa: phong tục, tập quán, lễ nghi, đồ ăn, trang phục, cách cư xử
3. **slang** - Tiếng lóng: từ ngữ bình dân, tiếng lóng internet, cách nói đường phố
4. **idiom** - Thành ngữ: tục ngữ, thành ngữ, cách nói cố định, ẩn dụ văn hóa
5. **trending** - Xu hướng: sự kiện thời sự, trào lưu, meme, viral content
6. **knowledge** - Kiến thức: thuật ngữ chuyên môn, định nghĩa, sự kiện
7. **season** - Mùa/thời tiết: đặc điểm khí hậu, hoạt động theo mùa, cảm giác thời tiết
8. **event** - Sự kiện: lễ hội, ngày kỷ niệm, sự kiện lịch sử
9. **food** - Ẩm thực: tên món ăn, nguyên liệu, cách chế biến, văn hóa ẩm thực
10. **fashion** - Thời trang: tên trang phục, phong cách, thương hiệu, trang phục truyền thống
11. **name** - Tên riêng: ý nghĩa tên, cách phiên âm, danh xưng, cách xưng hô
12. **history** - Lịch sử: bối cảnh thời đại, sự kiện lịch sử, nhân vật lịch sử
13. **mythology** - Thần thoại: truyền thuyết, folklore, tham chiếu tôn giáo
14. **pop_culture** - Văn hóa đại chúng: phim, nhạc, người nổi tiếng, game, anime
15. **dialect** - Phương ngữ: cách nói vùng miền, accent, từ địa phương
16. **onomatopoeia** - Từ tượng thanh: từ mô tả âm thanh, tiếng kêu
17. **measurement** - Đơn vị: tiền tệ, đo lường, chuyển đổi đơn vị
18. **profession** - Nghề nghiệp: thuật ngữ ngành nghề, jargon chuyên môn

**QUY TẮC:**
- Mỗi truy vấn phải CỤ THỂ và có thể tìm kiếm được
- Ưu tiên những gì QUAN TRỌNG NHẤT cho việc dịch
- Gán priority: 1 (rất quan trọng) đến 3 (bổ sung)
- Gợi ý searchLang nếu cần tìm bằng ngôn ngữ cụ thể (vi, en, zh, ja, ko...)
- Tối đa ${maxQueries} truy vấn

**FORMAT OUTPUT:**
\`\`\`json
[
  {
    "query": "search query here",
    "category": "category_name",
    "reason": "why this needs research for translation",
    "priority": 1,
    "searchLang": "vi"
  }
]
\`\`\``;

    const userPrompt = `**THÔNG TIN TRUYỆN:**
- Tên: ${storyMetadata.title}
- Tác giả: ${storyMetadata.author || 'Unknown'}
- Thể loại: ${storyMetadata.category || 'N/A'}
- Ngôn ngữ gốc: ${storyMetadata.originalLanguage || 'Unknown'}
- Ngôn ngữ đích: ${storyMetadata.targetLanguage || 'Vietnamese'}
- Bối cảnh: ${storyMetadata.description || 'N/A'}
- Nhân vật:
  - ${characterInfo}

**ĐOẠN VĂN CẦN PHÂN TÍCH:**
"""
${paragraph}
"""

**YÊU CẦU:**
Phân tích đoạn văn và tạo truy vấn tìm kiếm cho:

1. **Địa danh, địa điểm** cần hiểu rõ (nếu có)
2. **Văn hóa, phong tục** được đề cập hoặc ngụ ý
3. **Tiếng lóng, thành ngữ** cần giải nghĩa
4. **Tên riêng, danh xưng** cần biết cách dịch/giữ nguyên
5. **Đồ ăn, trang phục** đặc trưng (nếu có)
6. **Thuật ngữ chuyên môn** cần định nghĩa
7. **Tham chiếu văn hóa đại chúng** (phim, nhạc, game...)
8. **Bối cảnh lịch sử/thời đại** (nếu relevant)
9. **Từ tượng thanh** cần tìm tương đương
10. **Bất kỳ điều gì** khác cần tra cứu để dịch tốt hơn

Chỉ trả về JSON array, không có text khác.`;

    try {
      const response = await this.llmService.generate(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        { maxTokens: 2000 }
      );

      if (response.reasoningContent) {
        console.log(`    - Ground truth reasoning tokens: ${response.usage?.reasoningTokens || 'N/A'}`);
      }

      // Extract JSON - try multiple patterns
      const content = response.content;
      let jsonStr: string | null = null;

      // Pattern 1: Code block with json
      const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch && codeBlockMatch[1]) {
        jsonStr = codeBlockMatch[1].trim();
      }

      // Pattern 2: Raw JSON array
      if (!jsonStr) {
        const arrayMatch = content.match(/\[\s*\{[\s\S]*\}\s*\]/);
        if (arrayMatch) {
          jsonStr = arrayMatch[0];
        }
      }

      // Pattern 3: Any array
      if (!jsonStr) {
        const anyArrayMatch = content.match(/\[[\s\S]*\]/);
        if (anyArrayMatch) {
          jsonStr = anyArrayMatch[0];
        }
      }

      if (!jsonStr) {
        console.log(`    - Response content preview: ${content.substring(0, 200)}...`);
        console.warn('    ⚠️ No JSON array found in ground truth query response');
        return [];
      }

      let queries = JSON.parse(jsonStr) as GroundTruthQuery[];
      
      return queries
        .filter(q => q.query && q.category && q.reason)
        .map(q => ({ ...q, priority: q.priority ?? 2, searchLang: q.searchLang ?? 'vi' }))
        .sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2))
        .slice(0, maxQueries);
    } catch (error) {
      console.error('    ⚠️ Ground truth query generation failed:', error);
      return [];
    }
  }

  /**
   * Execute searches sequentially with rate limiting
   */
  async executeSearches(
    queries: GroundTruthQuery[],
    defaultLang?: string
  ): Promise<CategorySearchResult[]> {
    const results: CategorySearchResult[] = [];
    
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i]!;
      console.log(`      🔍 [${i + 1}/${queries.length}] "${q.query.substring(0, 45)}..."`);
      
      const searchResults = await this.search(q.query, {
        searchLang: q.searchLang ?? defaultLang ?? 'vi',
        count: 3,
        extraSnippets: true
      });
      
      results.push({
        category: q.category,
        query: q.query,
        snippets: searchResults
          .filter(r => r.description)
          .flatMap(r => [r.description!, ...(r.extra_snippets || [])])
          .slice(0, 5),
        sources: searchResults.map(r => r.url).slice(0, 3)
      });
      
      console.log(`      ${searchResults.length > 0 ? '✓' : '✗'} ${searchResults.length} results`);
    }
    
    return results;
  }

  /**
   * Search Brave API with rate limiting and retry
   */
  async search(
    query: string,
    options?: {
      count?: number;
      searchLang?: string;
      freshness?: 'pd' | 'pw' | 'pm' | 'py';
      extraSnippets?: boolean;
    }
  ): Promise<BraveSearchResult[]> {
    // Check cache
    const cacheKey = `${query}-${options?.searchLang ?? 'en'}`;
    if (this.cache.has(cacheKey)) {
      console.log(`      ✓ Cache hit`);
      return this.cache.get(cacheKey)!;
    }

    const params = new URLSearchParams({
      q: query,
      count: String(options?.count ?? 5),
      search_lang: options?.searchLang ?? 'en',
      text_decorations: 'false',
      safesearch: 'off',
    });
    
    if (options?.freshness) params.set('freshness', options.freshness);
    if (options?.extraSnippets) params.set('extra_snippets', 'true');

    // Retry with exponential backoff
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        // Rate limit: wait for 1 second between requests
        await this.waitForRateLimit();

        const response = await fetch(`${this.baseUrl}?${params}`, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'X-Subscription-Token': this.braveApiKey,
          },
        });

        // Handle rate limit (429) - use X-RateLimit-Reset header
        if (response.status === 429) {
          const resetHeader = response.headers.get('X-RateLimit-Reset');
          let waitTime: number;
          if (resetHeader) {
            // Header format: "1, 1419704" - first value is seconds until per-second limit resets
            const firstValue = resetHeader.split(',')[0]?.trim();
            waitTime = firstValue ? (parseInt(firstValue, 10) + 1) * 1000 : 2000;
          } else {
            waitTime = Math.pow(2, attempt + 1) * 1000;
          }
          console.log(`      ⏳ Rate limited (429), waiting ${(waitTime/1000).toFixed(1)}s (attempt ${attempt + 1}/${this.maxRetries})...`);
          await this.sleep(waitTime);
          continue;
        }

        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }

        const data = await response.json() as { web?: { results?: BraveSearchResult[] } };
        const results: BraveSearchResult[] = data.web?.results ?? [];
        
        this.cache.set(cacheKey, results);
        return results;
      } catch (error) {
        if (attempt === this.maxRetries - 1) {
          console.error(`      ⚠️ Search failed: ${error}`);
          return [];
        }
        const backoff = Math.pow(2, attempt + 1) * 1000;
        console.log(`      ⏳ Retry ${attempt + 1}/${this.maxRetries} in ${backoff/1000}s...`);
        await this.sleep(backoff);
      }
    }
    
    return [];
  }

  /**
   * Generate summary from search results
   */
  async generateSummary(
    paragraph: string,
    results: CategorySearchResult[],
    storyMetadata: StoryMetadata
  ): Promise<string> {
    const hasResults = results.some(r => r.snippets.length > 0);
    if (!hasResults) return '';

    const resultsText = results
      .filter(r => r.snippets.length > 0)
      .map(r => `[${r.category.toUpperCase()}] "${r.query}":\n${r.snippets.map(s => `  • ${s}`).join('\n')}`)
      .join('\n\n');

    const systemPrompt = `Bạn là chuyên gia tổng hợp thông tin để hỗ trợ dịch thuật văn học.

**NHIỆM VỤ:** Tóm tắt thông tin tra cứu thành ngữ cảnh HỮU ÍCH cho việc dịch.

**YÊU CẦU:**
- Tập trung vào thông tin TRỰC TIẾP LIÊN QUAN đến đoạn văn
- Giải thích ngắn gọn: địa danh, thuật ngữ, văn hóa, tiếng lóng
- Cung cấp gợi ý dịch cho từ ngữ khó
- Ghi chú về giọng điệu, phong cách phù hợp
- Bỏ qua thông tin không liên quan

**FORMAT:** Bullet points ngắn gọn, chia theo nhóm nếu cần`;

    const userPrompt = `**Đoạn văn cần dịch:**
"${paragraph}"

**Ngôn ngữ gốc:** ${storyMetadata.originalLanguage || 'Unknown'}
**Ngôn ngữ đích:** ${storyMetadata.targetLanguage || 'Vietnamese'}

**Thông tin tra cứu được:**
${resultsText}

**Nhiệm vụ:**
Tóm tắt những thông tin HỮU ÍCH cho việc dịch đoạn văn trên sang ${storyMetadata.targetLanguage || 'tiếng Việt'}.
Tập trung vào: giải nghĩa, gợi ý dịch, ngữ cảnh văn hóa, giọng điệu.`;

    try {
      const summaryLLM = createLLMService({ type: 'deepseek', model: 'deepseek-chat' });
      const response = await summaryLLM.generate(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        { maxTokens: 1200, temperature: 0.3 }
      );
      return response.content.trim();
    } catch (error) {
      console.error('    ⚠️ Summary generation failed:', error);
      return '';
    }
  }

  /**
   * Extract translation guidance
   */
  async extractGuidance(
    paragraph: string,
    results: CategorySearchResult[],
    storyMetadata: StoryMetadata
  ): Promise<TranslationGuidance> {
    const defaultGuidance: TranslationGuidance = {
      keepOriginal: [],
      suggestedTranslations: {},
      culturalNotes: [],
    };

    const hasResults = results.some(r => r.snippets.length > 0);
    if (!hasResults) return defaultGuidance;

    const resultsText = results
      .filter(r => r.snippets.length > 0)
      .map(r => `[${r.category.toUpperCase()}] "${r.query}":\n${r.snippets.map(s => `  • ${s}`).join('\n')}`)
      .join('\n\n');

    const systemPrompt = `Bạn là chuyên gia tư vấn dịch thuật. Dựa trên kết quả tra cứu, hãy đưa ra hướng dẫn dịch thuật cụ thể.

**OUTPUT FORMAT (JSON):**
{
  "keepOriginal": ["term1", "term2"],  // Từ nên giữ nguyên không dịch
  "suggestedTranslations": {           // Gợi ý cách dịch cụ thể
    "original_term": "suggested_translation"
  },
  "culturalNotes": [                   // Ghi chú văn hóa quan trọng
    "note about cultural context"
  ],
  "toneGuidance": "guidance about tone/style"  // Optional
}`;

    const userPrompt = `**Đoạn văn gốc:**
"${paragraph}"

**Ngôn ngữ đích:** ${storyMetadata.targetLanguage || 'Vietnamese'}

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
      const guidanceLLM = createLLMService({ type: 'deepseek', model: 'deepseek-chat' });
      const response = await guidanceLLM.generate(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        { maxTokens: 1000, temperature: 0.2 }
      );

      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return defaultGuidance;
      
      return JSON.parse(jsonMatch[0]) as TranslationGuidance;
    } catch (error) {
      console.error('    ⚠️ Guidance extraction failed:', error);
      return defaultGuidance;
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createGroundTruthService(options?: {
  llmType?: 'deepseek' | 'openrouter' | 'gemini';
  model?: string;
}): GroundTruthService {
  return new GroundTruthService(options);
}