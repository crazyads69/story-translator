import { createMarkdownParser } from "../ingest/markdown-parser";
import { ContextEnricher } from "./context-enrich";
import { createGroundTruthService } from "./ground-truth";
import { LinkableVerify } from "./linkable-verify";
import { getSystemPrompt } from "./prompt";
import {
  createLLMService,
  createLLMServiceFromEnv,
  type LLMService,
} from "./llm";
import type {
  StoryMetadata,
  EnrichedContext,
  GroundTruthContext,
} from "./interface";
import { basename } from "path";

export interface TranslatedParagraphOutput {
  index: number;
  original: string;
  translated: string;
  enhanced: string;
}

function buildUserPrompt(
  paragraph: string,
  fullChapterText: string,
  enriched: EnrichedContext,
  truth: GroundTruthContext | undefined,
  index: number,
  meta: StoryMetadata
): string {
  const chapterSnippet = fullChapterText.substring(0, 6000);
  const originalRefs = enriched.original_similar_paragraphs
    .slice(0, 3)
    .map((p, i) => `${i + 1}. ${p}`)
    .join("\n");
  const translatedRefs = enriched.translated_similar_paragraphs
    .slice(0, 2)
    .map((p, i) => `${i + 1}. ${p}`)
    .join("\n");
  const queries = enriched.generated_queries.join(", ");
  const truthSummary = truth?.summary ? truth.summary : "";
  const guidance = truth?.translationGuidance
    ? JSON.stringify(truth.translationGuidance)
    : "";
  const metaText = [
    `Tên: ${meta.title}`,
    `Tác giả: ${meta.author || "Unknown"}`,
    `Thể loại: ${meta.category || "N/A"}`,
    `Ngôn ngữ gốc: ${meta.originalLanguage || "Unknown"}`,
    `Ngôn ngữ đích: ${meta.targetLanguage || "Vietnamese"}`,
  ].join("\n");
  const blocks = [
    `**THÔNG TIN TRUYỆN:**\n${metaText}`,
    `**NGỮ CẢNH CHƯƠNG:**\n${chapterSnippet}`,
    originalRefs ? `**THAM CHIẾU BẢN GỐC:**\n${originalRefs}` : "",
    translatedRefs ? `**THAM CHIẾU ĐÃ DỊCH:**\n${translatedRefs}` : "",
    queries ? `**TRUY VẤN NGỮ CẢNH:** ${queries}` : "",
    truthSummary ? `**TÓM TẮT GROUND TRUTH:**\n${truthSummary}` : "",
    guidance ? `**HƯỚNG DẪN DỊCH:**\n${guidance}` : "",
    `**ĐOẠN VĂN CẦN DỊCH (Đoạn ${index + 1}):**\n${paragraph}`,
    `Chỉ trả về bản dịch tiếng Việt theo tất cả nguyên tắc, không giải thích.`,
  ].filter(Boolean);
  return blocks.join("\n\n");
}

export interface TranslateChapterResult {
  chapterId: string;
  title?: string;
  outputs: TranslatedParagraphOutput[];
  summary: {
    paragraphs: number;
    ragOriginalHits: number;
    ragTranslatedHits: number;
    ragQueries: number;
    groundTruthQueries: number;
    groundTruthResults: number;
    groundTruthMergedCount: number;
    linkageChanges: number;
    languagesSearched: string[];
  };
}

export class TranslateService {
  private parser = createMarkdownParser();
  private enricher = new ContextEnricher();
  private groundTruth = createGroundTruthService({
    llmType: "deepseek",
    model: "deepseek-reasoner",
  });
  private verify = new LinkableVerify();
  private translator: LLMService = createLLMService({
    type: "deepseek",
    model: "deepseek-chat",
  });

  async translateChapterFromMarkdown(
    filePath: string,
    storyMetadata: StoryMetadata
  ): Promise<TranslateChapterResult> {
    const chapter = this.parser.parseFile(filePath);
    await this.enricher.initialize();
    const fullChapterText = chapter.content;
    const chapterId =
      chapter.metadata.id || basename(filePath).replace(/\.[^/.]+$/, "");
    const paragraphs = this.parser.splitIntoParagraphs(chapter.content);
    const outputs: TranslatedParagraphOutput[] = [];
    const prevTranslated: string[] = [];
    let ragOriginalHits = 0;
    let ragTranslatedHits = 0;
    let ragQueries = 0;
    let groundTruthQueries = 0;
    let groundTruthResults = 0;
    let groundTruthMergedCount = 0;
    let linkageChanges = 0;
    const languagesSearched = new Set<string>();
    for (let i = 0; i < paragraphs.length; i++) {
      const para = paragraphs[i]!;
      const enriched = await this.safeEnrich(
        para,
        storyMetadata.id || chapterId,
        chapterId,
        storyMetadata
      );
      ragOriginalHits += enriched.original_similar_paragraphs.length;
      ragTranslatedHits += enriched.translated_similar_paragraphs.length;
      ragQueries += enriched.generated_queries.length;
      const truthInfo = await this.safeGroundTruth(para, storyMetadata);
      const truth = truthInfo.context;
      if (truth) {
        groundTruthQueries += truth.queries.length;
        groundTruthResults += truth.results.length;
      }
      if (truthInfo.merged) {
        groundTruthMergedCount++;
      }
      truthInfo.langs.forEach((l) => languagesSearched.add(l));
      const system = getSystemPrompt();
      const user = buildUserPrompt(
        para,
        fullChapterText,
        enriched,
        truth,
        i,
        storyMetadata
      );
      const translated = await this.safeTranslate(system, user, 1.5, 4000);
      const enhancedResult = await this.verify.verifyAndEnhance({
        originalChapter: fullChapterText,
        previousTranslatedParagraphs: prevTranslated,
        currentTranslatedParagraph: translated,
        storyMetadata,
        originalLanguage: storyMetadata.originalLanguage,
        targetLanguage: storyMetadata.targetLanguage,
        maxContextChars: 200000,
      });
      const enhanced = enhancedResult.result.enhancedParagraph || translated;
      outputs.push({ index: i, original: para, translated, enhanced });
      if (enhanced !== translated) {
        linkageChanges++;
      }
      prevTranslated.push(enhanced);
    }
    return {
      chapterId,
      title: chapter.metadata.title,
      outputs,
      summary: {
        paragraphs: paragraphs.length,
        ragOriginalHits,
        ragTranslatedHits,
        ragQueries,
        groundTruthQueries,
        groundTruthResults,
        groundTruthMergedCount,
        linkageChanges,
        languagesSearched: Array.from(languagesSearched),
      },
    };
  }

  private async safeEnrich(
    paragraph: string,
    storyId: string,
    chapterId: string,
    meta: StoryMetadata
  ): Promise<EnrichedContext> {
    try {
      return await this.enricher.enrichContext(
        paragraph,
        storyId,
        chapterId,
        meta
      );
    } catch {
      return {
        original_similar_paragraphs: [],
        translated_similar_paragraphs: [],
        relevance_scores: [],
        generated_queries: [],
      };
    }
  }

  private async safeGroundTruth(
    paragraph: string,
    meta: StoryMetadata
  ): Promise<{
    context?: GroundTruthContext;
    merged: boolean;
    langs: string[];
  }> {
    try {
      const origCode = this.mapLanguageToCode(meta.originalLanguage || "vi");
      const truthOrig = await this.groundTruth.getGroundTruthContext(
        paragraph,
        meta,
        {
          maxQueries: 5,
          includeGuidance: true,
          searchLang: origCode,
        }
      );
      const truthVi =
        origCode === "vi"
          ? undefined
          : await this.groundTruth.getGroundTruthContext(paragraph, meta, {
              maxQueries: 5,
              includeGuidance: true,
              searchLang: "vi",
            });
      const merged = this.mergeGroundTruth(truthOrig, truthVi);
      const langs = origCode === "vi" ? ["vi"] : ["vi", origCode];
      const usedMerged = !!truthOrig && !!truthVi;
      return { context: merged, merged: usedMerged, langs };
    } catch {
      const cod = this.mapLanguageToCode(meta.originalLanguage || "vi");
      const langs = cod === "vi" ? ["vi"] : ["vi", cod];
      return { context: undefined, merged: false, langs };
    }
  }

  private async safeTranslate(
    system: string,
    user: string,
    temperature: number,
    maxTokens: number
  ): Promise<string> {
    try {
      const r = await this.translator.generate(
        [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        { temperature, maxTokens }
      );
      return r.content.trim();
    } catch {
      try {
        const fallback = createLLMServiceFromEnv();
        const r = await fallback.generate(
          [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          { temperature, maxTokens }
        );
        return r.content.trim();
      } catch {
        return user;
      }
    }
  }

  private mapLanguageToCode(lang: string): string {
    const s = (lang || "").toLowerCase();
    if (s.startsWith("vi")) return "vi";
    if (s.startsWith("en")) return "en";
    if (s.startsWith("ko") || s.includes("korean")) return "ko";
    if (s.startsWith("ja") || s.includes("japanese")) return "ja";
    if (s.startsWith("zh") || s.includes("chinese")) return "zh";
    return "vi";
  }

  private mergeGroundTruth(
    a?: GroundTruthContext,
    b?: GroundTruthContext
  ): GroundTruthContext | undefined {
    if (!a && !b) return undefined;
    if (a && !b) return a;
    if (!a && b) return b;
    const aa = a!;
    const bb = b!;
    const seenQ = new Set<string>();
    const queries = [...aa.queries, ...bb.queries].filter((q) => {
      const key = q.query + "|" + q.category;
      if (seenQ.has(key)) return false;
      seenQ.add(key);
      return true;
    });
    const seenR = new Set<string>();
    const results = [...aa.results, ...bb.results].filter((r) => {
      const key = r.category + "|" + r.query;
      if (seenR.has(key)) return false;
      seenR.add(key);
      return true;
    });
    const summaryParts = [aa.summary || "", bb.summary || ""].filter(Boolean);
    const summary = summaryParts.join("\n\n");
    const ag = aa.translationGuidance;
    const bg = bb.translationGuidance;
    const guidance =
      ag || bg
        ? {
            keepOriginal: Array.from(
              new Set([
                ...(ag?.keepOriginal || []),
                ...(bg?.keepOriginal || []),
              ])
            ),
            suggestedTranslations: {
              ...(ag?.suggestedTranslations || {}),
              ...(bg?.suggestedTranslations || {}),
            },
            culturalNotes: Array.from(
              new Set([
                ...(ag?.culturalNotes || []),
                ...(bg?.culturalNotes || []),
              ])
            ),
            toneGuidance: bg?.toneGuidance || ag?.toneGuidance,
          }
        : undefined;
    const metadata = {
      totalQueries:
        (aa.metadata?.totalQueries || 0) + (bb.metadata?.totalQueries || 0),
      successfulSearches:
        (aa.metadata?.successfulSearches || 0) +
        (bb.metadata?.successfulSearches || 0),
      processingTimeMs:
        (aa.metadata?.processingTimeMs || 0) +
        (bb.metadata?.processingTimeMs || 0),
    };
    return {
      queries,
      results,
      summary,
      translationGuidance: guidance,
      metadata,
    };
  }
}
