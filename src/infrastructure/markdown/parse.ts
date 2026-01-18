import { readFile } from "node:fs/promises";
import matter from "gray-matter";

export type ParsedMarkdown = {
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
  paragraphs: string[];
};

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/g)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
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

