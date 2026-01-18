import { readFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { Document } from "@langchain/core/documents";
import { BaseDocumentLoader } from "@langchain/core/document_loaders/base";
import { normalizeTextForSearch } from "../text/normalize";

export type FileLoaderOptions = {
  /**
   * Override content type. If omitted, inferred from file extension.
   */
  contentType?: "markdown" | "text" | "pdf";
};

/**
 * Loads local files (PDF / markdown / plain text) into LangChain Documents.
 *
 * Notes:
 * - PDF parsing requires optional dependency `pdf-parse`.
 * - Markdown frontmatter is parsed via `gray-matter` and placed into metadata.
 */
export class FileLoader extends BaseDocumentLoader {
  private readonly filePath: string;
  private readonly options: FileLoaderOptions;

  constructor(filePath: string, options: FileLoaderOptions = {}) {
    super();
    this.filePath = filePath;
    this.options = options;
  }

  async load(): Promise<Document[]> {
    const abs = path.isAbsolute(this.filePath)
      ? this.filePath
      : path.join(process.cwd(), this.filePath);

    const ext = path.extname(abs).toLowerCase();
    const contentType =
      this.options.contentType ??
      (ext === ".md" || ext === ".mdx"
        ? "markdown"
        : ext === ".pdf"
          ? "pdf"
          : "text");

    const buf = await readFile(abs);
    if (contentType === "pdf") {
      const parsed = await parsePdf(buf);
      return [
        new Document({
          pageContent: normalizeTextForSearch(parsed.text ?? ""),
          metadata: {
            sourceType: "file",
            sourceUri: abs,
            contentType: "pdf",
            pageCount: parsed.numpages,
          },
        }),
      ];
    }

    const raw = buf.toString("utf8");
    if (contentType === "markdown") {
      const parsed = matter(raw);
      return [
        new Document({
          pageContent: normalizeTextForSearch(parsed.content ?? ""),
          metadata: {
            sourceType: "file",
            sourceUri: abs,
            contentType: "markdown",
            frontmatter: parsed.data ?? {},
          },
        }),
      ];
    }

    return [
      new Document({
        pageContent: normalizeTextForSearch(raw),
        metadata: { sourceType: "file", sourceUri: abs, contentType: "text" },
      }),
    ];
  }
}

async function parsePdf(data: Buffer): Promise<{ text: string; numpages?: number }> {
  try {
    const mod = (await import("pdf-parse")) as unknown as {
      default: (input: Buffer) => Promise<{ text: string; numpages?: number }>;
    };
    return await mod.default(data);
  } catch (error) {
    throw new Error(
      "PDF support requires the optional dependency 'pdf-parse'. Install it and retry.",
    );
  }
}

