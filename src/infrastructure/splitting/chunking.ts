import { normalizeTextForSearch } from "../text/normalize";
import { groupShortParagraphs } from "../markdown/parse";

export type ChunkingConfig = {
  chunkSize: number;
  chunkOverlap: number;
  strategy: "markdown" | "recursive" | "paragraph";
};

/**
 * Context window configuration for paragraph-based chunking.
 * Inspired by old_code.md buildContextWindow pattern.
 */
export type ContextWindowConfig = {
  /** Number of characters to include from previous paragraphs */
  prevContextChars: number;
  /** Number of characters to include from next paragraphs */
  nextContextChars: number;
  /** Whether to include context in the chunk text (for embedding) */
  includeContext: boolean;
};

/**
 * Configuration for grouping short paragraphs (dialogue, etc.)
 */
export type GroupingConfig = {
  /** Enable grouping of short paragraphs */
  enabled: boolean;
  /** Paragraphs shorter than this are considered "short" */
  shortThreshold: number;
  /** Maximum paragraphs per group */
  maxGroupSize: number;
};

export const DEFAULT_CONTEXT_CONFIG: ContextWindowConfig = {
  prevContextChars: 500,
  nextContextChars: 300,
  includeContext: true,
};

export const DEFAULT_GROUPING_CONFIG: GroupingConfig = {
  enabled: true,
  shortThreshold: 80,
  maxGroupSize: 4,
};

export type Chunk = {
  /** The main paragraph text (for display/retrieval) */
  text: string;
  /** Section path from markdown headings */
  sectionPath: string[];
  /** Index of this paragraph in the document (main index if grouped) */
  paragraphIndex?: number;
  /** Total number of paragraphs in the document */
  totalParagraphs?: number;
  /** Text with context window for embedding (includes prev/next context) */
  textWithContext?: string;
  /** Whether this chunk has previous context */
  hasPrevContext?: boolean;
  /** Whether this chunk has next context */
  hasNextContext?: boolean;
  /** Whether this is a grouped chunk (multiple short paragraphs) */
  isGrouped?: boolean;
  /** Number of paragraphs in this group */
  groupSize?: number;
  /** All paragraph indices included in this chunk */
  groupIndices?: number[];
};

/**
 * Splits a document into semantically-aligned chunks.
 *
 * Strategy:
 * - markdown: split on headings first, then recursively split oversized sections
 * - recursive: split on paragraph/sentence/word boundaries
 * - paragraph: split by blank lines with context window and optional grouping
 *
 * This implementation is deterministic and dependency-free. For token-based
 * chunking, integrate a tokenizer length function.
 */
export function chunkText(
  input: string,
  config: ChunkingConfig,
  contextConfig: ContextWindowConfig = DEFAULT_CONTEXT_CONFIG,
  groupingConfig: GroupingConfig = DEFAULT_GROUPING_CONFIG,
): Chunk[] {
  const text = normalizeTextForSearch(input);
  if (text.length === 0) return [];
  if (config.strategy === "markdown") {
    return chunkMarkdown(text, config);
  }
  if (config.strategy === "paragraph") {
    return chunkParagraphWithContext(text, contextConfig, groupingConfig);
  }
  return chunkRecursive(text, config);
}

/**
 * Paragraph-based chunking with context window and optional short-paragraph grouping.
 * Each paragraph (or group) is a discrete chunk, but includes surrounding context for better embeddings.
 * 
 * Pattern from old_code.md:
 * - Main text: the paragraph itself (for display/retrieval)
 * - Context window: prev paragraphs + current + next paragraphs (for embedding)
 * - Grouping: consecutive short paragraphs (dialogue) are combined
 */
function chunkParagraphWithContext(
  text: string,
  config: ContextWindowConfig,
  groupingConfig: GroupingConfig = DEFAULT_GROUPING_CONFIG,
): Chunk[] {
  const paragraphs = text
    .split(/\n\s*\n/g)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (paragraphs.length === 0) return [];

  // Apply grouping if enabled
  if (groupingConfig.enabled) {
    const groups = groupShortParagraphs(
      paragraphs,
      groupingConfig.shortThreshold,
      groupingConfig.maxGroupSize,
    );

    return groups.map((indices) => {
      const mainIndex = indices[0] ?? 0;
      const groupText = indices
        .map((idx) => paragraphs[idx] ?? "")
        .filter((t) => t.length > 0)
        .join("\n\n");

      // Build context window based on the group boundaries
      const { contextWindow, hasPrev, hasNext } = buildContextWindowForGroup(
        paragraphs,
        indices,
        config.prevContextChars,
        config.nextContextChars,
      );

      return {
        text: groupText,
        sectionPath: [],
        paragraphIndex: mainIndex,
        totalParagraphs: paragraphs.length,
        textWithContext: config.includeContext ? contextWindow : groupText,
        hasPrevContext: hasPrev,
        hasNextContext: hasNext,
        isGrouped: indices.length > 1,
        groupSize: indices.length,
        groupIndices: indices,
      };
    });
  }

  // No grouping - process each paragraph individually
  return paragraphs.map((paragraph, index) => {
    const { contextWindow, hasPrev, hasNext } = buildContextWindow(
      paragraphs,
      index,
      config.prevContextChars,
      config.nextContextChars,
    );

    return {
      text: paragraph,
      sectionPath: [],
      paragraphIndex: index,
      totalParagraphs: paragraphs.length,
      textWithContext: config.includeContext ? contextWindow : paragraph,
      hasPrevContext: hasPrev,
      hasNextContext: hasNext,
      isGrouped: false,
      groupSize: 1,
      groupIndices: [index],
    };
  });
}

/**
 * Build context window for a group of paragraphs.
 * Similar to buildContextWindow but handles multiple indices.
 */
function buildContextWindowForGroup(
  paragraphs: string[],
  indices: number[],
  prevChars: number,
  nextChars: number,
): { contextWindow: string; hasPrev: boolean; hasNext: boolean } {
  if (indices.length === 0) {
    return { contextWindow: "", hasPrev: false, hasNext: false };
  }

  const firstIdx = indices[0]!;
  const lastIdx = indices[indices.length - 1]!;
  
  // Combine the group's paragraphs
  const groupText = indices
    .map((idx) => paragraphs[idx] ?? "")
    .filter((t) => t.length > 0)
    .join("\n\n");

  // Build previous context (before first index)
  let prevContext = "";
  let prevIdx = firstIdx - 1;
  while (prevIdx >= 0 && prevContext.length < prevChars) {
    const para = paragraphs[prevIdx]!;
    const remaining = prevChars - prevContext.length;
    if (para.length <= remaining) {
      prevContext = para + "\n\n" + prevContext;
    } else {
      prevContext = "..." + para.slice(-remaining) + "\n\n" + prevContext;
    }
    prevIdx--;
  }

  // Build next context (after last index)
  let nextContext = "";
  let nextIdx = lastIdx + 1;
  while (nextIdx < paragraphs.length && nextContext.length < nextChars) {
    const para = paragraphs[nextIdx]!;
    const remaining = nextChars - nextContext.length;
    if (para.length <= remaining) {
      nextContext = nextContext + "\n\n" + para;
    } else {
      nextContext = nextContext + "\n\n" + para.slice(0, remaining) + "...";
    }
    nextIdx++;
  }

  const contextWindow = [
    prevContext.trim(),
    groupText,
    nextContext.trim(),
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");

  return {
    contextWindow,
    hasPrev: prevContext.length > 0,
    hasNext: nextContext.length > 0,
  };
}

/**
 * Build context window for a paragraph (like old_code.md).
 * Includes previous and next paragraphs for better semantic embedding.
 * 
 * @param paragraphs - All paragraphs in the document
 * @param index - Current paragraph index
 * @param prevChars - Max characters to include from previous paragraphs
 * @param nextChars - Max characters to include from next paragraphs
 * @returns Context window with prev + current + next, and flags
 */
function buildContextWindow(
  paragraphs: string[],
  index: number,
  prevChars: number,
  nextChars: number,
): { contextWindow: string; hasPrev: boolean; hasNext: boolean } {
  const current = paragraphs[index]!;
  
  // Build previous context
  let prevContext = "";
  let prevIdx = index - 1;
  while (prevIdx >= 0 && prevContext.length < prevChars) {
    const para = paragraphs[prevIdx]!;
    const remaining = prevChars - prevContext.length;
    if (para.length <= remaining) {
      prevContext = para + "\n\n" + prevContext;
    } else {
      // Truncate from the beginning of the paragraph
      prevContext = "..." + para.slice(-remaining) + "\n\n" + prevContext;
    }
    prevIdx--;
  }

  // Build next context
  let nextContext = "";
  let nextIdx = index + 1;
  while (nextIdx < paragraphs.length && nextContext.length < nextChars) {
    const para = paragraphs[nextIdx]!;
    const remaining = nextChars - nextContext.length;
    if (para.length <= remaining) {
      nextContext = nextContext + "\n\n" + para;
    } else {
      // Truncate from the end of the paragraph
      nextContext = nextContext + "\n\n" + para.slice(0, remaining) + "...";
    }
    nextIdx++;
  }

  const contextWindow = [
    prevContext.trim(),
    current,
    nextContext.trim(),
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");

  return {
    contextWindow,
    hasPrev: prevContext.length > 0,
    hasNext: nextContext.length > 0,
  };
}

function chunkParagraph(text: string): Chunk[] {
  // Simple blank-line splitting, preserving paragraphs as discrete chunks
  // No recursion or size limiting - we want semantic paragraph units
  const paragraphs = text
    .split(/\n\s*\n/g)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return paragraphs.map((p, i) => ({
    text: p,
    sectionPath: [],
    paragraphIndex: i,
    totalParagraphs: paragraphs.length,
  }));
}

function chunkMarkdown(text: string, config: ChunkingConfig): Chunk[] {
  const lines = text.split("\n");
  const chunks: Chunk[] = [];

  let currentHeader: string[] = [];
  let buffer: string[] = [];

  const flush = () => {
    const sectionText = normalizeTextForSearch(buffer.join("\n"));
    buffer = [];
    if (!sectionText) return;
    const sectionChunks = chunkRecursive(sectionText, config);
    for (const c of sectionChunks) {
      chunks.push({ text: c.text, sectionPath: currentHeader });
    }
  };

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (headingMatch) {
      flush();
      const level = headingMatch[1]!.length;
      const title = headingMatch[2]!.trim();
      currentHeader = currentHeader.slice(0, level - 1);
      currentHeader[level - 1] = title;
      continue;
    }
    buffer.push(line);
  }
  flush();
  return chunks;
}

function chunkRecursive(text: string, config: ChunkingConfig): Chunk[] {
  const size = config.chunkSize;
  const overlap = Math.min(config.chunkOverlap, Math.max(0, size - 1));

  if (text.length <= size) return [{ text, sectionPath: [] }];

  const separators = ["\n\n", "\n", ". ", " ", ""];
  const out: Chunk[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    const window = text.slice(start, end);
    const splitIdx = findBestSplit(window, separators);
    const chunk = window.slice(0, splitIdx).trim();
    if (chunk.length > 0) out.push({ text: chunk, sectionPath: [] });

    if (end === text.length) break;
    const consumed = Math.max(1, splitIdx);
    start = start + consumed - overlap;
    if (start < 0) start = 0;
  }

  return out;
}

function findBestSplit(window: string, seps: string[]): number {
  for (const sep of seps) {
    if (sep === "") return window.length;
    const idx = window.lastIndexOf(sep);
    if (idx > 0) return idx + sep.length;
  }
  return window.length;
}
