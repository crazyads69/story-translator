import { readFile } from "node:fs/promises";
import matter from "gray-matter";

export type ParsedMarkdown = {
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
  paragraphs: string[];
};

/**
 * Split markdown content into paragraphs while preserving code blocks,
 * tables, and other multi-line constructs.
 * 
 * Rules:
 * - Code blocks (```) are kept as single paragraphs
 * - Tables (lines starting with |) are kept together
 * - Regular paragraphs are split by blank lines
 * - Headers are treated as paragraph boundaries
 */
function splitParagraphs(text: string): string[] {
  const lines = text.split("\n");
  const paragraphs: string[] = [];
  let current: string[] = [];
  let inCodeBlock = false;
  let inTable = false;

  const flushCurrent = () => {
    if (current.length > 0) {
      const paragraph = current.join("\n").trim();
      if (paragraph.length > 0) {
        paragraphs.push(paragraph);
      }
      current = [];
    }
  };

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Track code block state (``` or ~~~)
    if (trimmedLine.startsWith("```") || trimmedLine.startsWith("~~~")) {
      if (inCodeBlock) {
        // End of code block
        current.push(line);
        flushCurrent();
        inCodeBlock = false;
      } else {
        // Start of code block - flush previous content first
        flushCurrent();
        current.push(line);
        inCodeBlock = true;
      }
      continue;
    }

    // Inside code block - add everything
    if (inCodeBlock) {
      current.push(line);
      continue;
    }

    // Track table state (lines starting with |)
    const isTableLine = trimmedLine.startsWith("|") || /^\|?[-:]+\|/.test(trimmedLine);
    if (isTableLine) {
      if (!inTable) {
        // Starting a table - flush previous content
        flushCurrent();
        inTable = true;
      }
      current.push(line);
      continue;
    } else if (inTable) {
      // End of table
      flushCurrent();
      inTable = false;
    }

    // Blank line - paragraph boundary (outside code blocks and tables)
    if (/^\s*$/.test(line)) {
      flushCurrent();
      continue;
    }

    // Headers can start new paragraphs
    if (/^#{1,6}\s/.test(trimmedLine)) {
      flushCurrent();
      current.push(line);
      flushCurrent();
      continue;
    }

    // Regular content
    current.push(line);
  }

  // Flush remaining content
  flushCurrent();

  return paragraphs;
}

/**
 * Group consecutive short paragraphs together (e.g., dialogue lines).
 * 
 * This is important for:
 * - Dialogue/conversation parts where each line is very short
 * - Short action descriptions that make more sense together
 * - Better embedding context for short texts
 * 
 * @param paragraphs - Array of paragraph texts
 * @param shortThreshold - Paragraphs shorter than this are considered "short" (default: 80 chars)
 * @param maxGroupSize - Maximum paragraphs per group (default: 4)
 * @returns Array of paragraph groups, each group is an array of paragraph indices
 */
export function groupShortParagraphs(
  paragraphs: string[],
  shortThreshold: number = 80,
  maxGroupSize: number = 4,
): number[][] {
  const groups: number[][] = [];
  let currentGroup: number[] = [];

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    if (!para) continue;

    const isShort = para.length < shortThreshold;
    const isDialogue = /^["「『"""'']/.test(para.trim()) || /^[-—–]/.test(para.trim());
    const shouldGroup = isShort || isDialogue;

    if (shouldGroup && currentGroup.length < maxGroupSize) {
      currentGroup.push(i);
    } else {
      // Flush current group
      if (currentGroup.length > 0) {
        groups.push([...currentGroup]);
        currentGroup = [];
      }
      
      // Start new group or add as single
      if (shouldGroup) {
        currentGroup.push(i);
      } else {
        groups.push([i]);
      }
    }
  }

  // Flush remaining group
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}

/**
 * Grouped paragraph result with metadata
 */
export type GroupedParagraph = {
  /** Combined text of all paragraphs in the group */
  text: string;
  /** Main paragraph index (first in group) */
  mainIndex: number;
  /** All paragraph indices in this group */
  indices: number[];
  /** Whether this is a grouped paragraph (more than 1) */
  isGrouped: boolean;
  /** Number of paragraphs in this group */
  groupSize: number;
};

/**
 * Get paragraphs with short-paragraph grouping applied.
 * 
 * @param paragraphs - Array of paragraph texts
 * @param shortThreshold - Paragraphs shorter than this are considered "short"
 * @param maxGroupSize - Maximum paragraphs per group
 * @returns Array of grouped paragraphs with metadata
 */
export function getGroupedParagraphs(
  paragraphs: string[],
  shortThreshold: number = 80,
  maxGroupSize: number = 4,
): GroupedParagraph[] {
  const groups = groupShortParagraphs(paragraphs, shortThreshold, maxGroupSize);
  
  return groups.map((indices) => {
    const texts = indices.map((idx) => paragraphs[idx] ?? "").filter((t) => t.length > 0);
    return {
      text: texts.join("\n\n"),
      mainIndex: indices[0] ?? 0,
      indices,
      isGrouped: indices.length > 1,
      groupSize: indices.length,
    };
  });
}

export async function parseMarkdownFile(filePath: string): Promise<ParsedMarkdown> {
  const raw = await readFile(filePath, "utf8");
  const parsed = matter(raw);
  return {
    path: filePath,
    frontmatter: (parsed.data ?? {}) as Record<string, unknown>,
    content: parsed.content,
    paragraphs: splitParagraphs(parsed.content),
  };
}

export { splitParagraphs };

