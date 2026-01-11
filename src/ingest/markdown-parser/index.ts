// Parse markdown chapter files with frontmatter


import matter from "gray-matter";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, extname, basename } from "path";
import type { ParsedChapter, ChapterMetadata } from "../interface";


export class MarkdownParser {
    /**
   * Parse a single markdown file
   */
  parseFile(filepath: string): ParsedChapter {
    const content = readFileSync(filepath, "utf-8");
    const { data, content: markdownContent } = matter(content);

    return {
      filename: basename(filepath),
      filepath: filepath,
      content: markdownContent.trim(),
      metadata: data as ChapterMetadata,
    };
  }


    /**
   * Get all markdown files from a directory
   */
 getMarkdownFiles(dirPath: string): string[] {
    try {
      const files = readdirSync(dirPath);
      
      return files
        .filter(file => {
          const ext = extname(file).toLowerCase();
          return ext === ".md" || ext === ".markdown";
        })
        .map(file => join(dirPath, file))
        .filter(filepath => {
          const stat = statSync(filepath);
          return stat.isFile();
        })
        .sort(); // Sort alphabetically for consistent order
    } catch (error) {
      console.error(`Error reading directory ${dirPath}:`, error);
      return [];
    }
  }

    /**
   * Parse all markdown files in a directory
   */
  parseDirectory(dirPath: string): ParsedChapter[] {
    const files = this.getMarkdownFiles(dirPath);
    
    return files.map(filepath => {
      try {
        return this.parseFile(filepath);
      } catch (error) {
        console.error(`Error parsing ${filepath}:`, error);
        return null;
      }
    }).filter((chapter): chapter is ParsedChapter => chapter !== null);
  }


    /**
   * Get total word count from content
   */
  getWordCount(content: string): number {
    return content.split(/\s+/).filter(word => word.length > 0).length;
  }

   /**
   * Get total character count
   */
  getCharCount(content: string): number {
    return content.length;
  }

   /**
   * Split content into paragraphs
   * Splits by double newlines and filters empty paragraphs
   */
  splitIntoParagraphs(content: string): string[] {
    return content
      .split(/\n\n+/)
      .map(p => p.trim())
      .filter(p => p.length > 0);
  }

  /**
   * Group consecutive short paragraphs (e.g., dialogue)
   * Returns array of paragraph groups, each group is an array of paragraph indices
   */
    groupShortParagraphs(
    paragraphs: string[],
    shortThreshold: number = 50,
    maxGroupSize: number = 3
  ): number[][] {
    const groups: number[][] = [];
    let currentGroup: number[] = [];

    for (let i = 0; i < paragraphs.length; i++) {
      const para = paragraphs[i];
      
      if (para && para.length < shortThreshold && currentGroup.length < maxGroupSize) {
        currentGroup.push(i);
      } else {
        if (currentGroup.length > 0) {
          groups.push([...currentGroup]);
          currentGroup = [];
        }
        groups.push([i]);
      }
    }

    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    return groups;
  }


  /**
   * Build context window for a paragraph
   * Includes previous and next paragraphs for better semantic embedding
   */
  buildContextWindow(
    paragraphs: string[],
    index: number,
    windowSize: number = 1
  ): {
    fullContext: string;
    mainParagraph: string;
    prevContext: string;
    nextContext: string;
  } {
    const mainParagraph = paragraphs[index] ?? "";
    
    // Get previous paragraphs
    const prevStart = Math.max(0, index - windowSize);
    const prevContext = paragraphs.slice(prevStart, index).join("\n\n");
    
    // Get next paragraphs
    const nextEnd = Math.min(paragraphs.length, index + windowSize + 1);
    const nextContext = paragraphs.slice(index + 1, nextEnd).join("\n\n");
    
    // Combine all for embedding
    const parts = [prevContext, mainParagraph, nextContext].filter(p => p);
    const fullContext = parts.join("\n\n");

    return {
      fullContext,
      mainParagraph,
      prevContext,
      nextContext,
    };
  }

   /**
   * Truncate text to approximate token limit
   * Rough estimate: 1 token ≈ 4 characters
   */
  truncateToTokenLimit(text: string, maxTokens: number = 8000): string {
    const maxChars = maxTokens * 4;
    if (text.length <= maxChars) {
      return text;
    }
    return text.substring(0, maxChars);
  }

  /**
   * Extract chapter number from filename if not in frontmatter
   * Examples: "chapter_001.md", "ch1.md", "001_chapter_title.md"
   */
  extractChapterNumber(filename: string): number | null {
    // Try to find a number in the filename
    const matches = filename.match(/(\d+)/);
    if (matches && matches[1]) {
      return parseInt(matches[1], 10);
    }
    return null;
  }
}

/**
 * Create markdown parser instance
 */
export function createMarkdownParser(): MarkdownParser {
  return new MarkdownParser();
}


