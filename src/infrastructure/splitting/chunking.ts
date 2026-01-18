import { normalizeTextForSearch } from "../text/normalize";

export type ChunkingConfig = {
  chunkSize: number;
  chunkOverlap: number;
  strategy: "markdown" | "recursive" | "paragraph";
};

export type Chunk = {
  text: string;
  sectionPath: string[];
};

/**
 * Splits a document into semantically-aligned chunks.
 *
 * Strategy:
 * - markdown: split on headings first, then recursively split oversized sections
 * - recursive: split on paragraph/sentence/word boundaries
 *
 * This implementation is deterministic and dependency-free. For token-based
 * chunking, integrate a tokenizer length function.
 */
export function chunkText(input: string, config: ChunkingConfig): Chunk[] {
  const text = normalizeTextForSearch(input);
  if (text.length === 0) return [];
  if (config.strategy === "markdown") {
    return chunkMarkdown(text, config);
  }
  if (config.strategy === "paragraph") {
    return chunkParagraph(text);
  }
  return chunkRecursive(text, config);
}

function chunkParagraph(text: string): Chunk[] {
  // Simple blank-line splitting, preserving paragraphs as discrete chunks
  // No recursion or size limiting - we want semantic paragraph units
  const paragraphs = text
    .split(/\n\s*\n/g)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return paragraphs.map((p) => ({ text: p, sectionPath: [] }));
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
