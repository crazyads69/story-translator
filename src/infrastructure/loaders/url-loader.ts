import { Document } from "@langchain/core/documents";
import { BaseDocumentLoader } from "@langchain/core/document_loaders/base";
import { safeFetchBinary, safeFetchText } from "../http/safe-fetch";
import { isSafePublicHttpUrl } from "../http/url-safety";
import { htmlToText } from "../text/html";
import { normalizeTextForSearch } from "../text/normalize";

export type UrlLoaderOptions = {
  timeoutMs: number;
  maxBytes: number;
};

/**
 * Loads a URL into a LangChain Document.
 *
 * - HTML: stripped into text via `htmlToText`
 * - PDF: parsed via pdf-parse
 *
 * Safety limits:
 * - timeout
 * - maxBytes cap
 */
export class UrlLoader extends BaseDocumentLoader {
  private readonly url: string;
  private readonly options: UrlLoaderOptions;

  constructor(url: string, options: UrlLoaderOptions) {
    super();
    this.url = url;
    this.options = options;
  }

  async load(): Promise<Document[]> {
    if (!isSafePublicHttpUrl(this.url)) {
      throw new Error(
        "Refusing to fetch non-public or non-http(s) URL for safety.",
      );
    }
    const head = await safeFetchText({
      url: this.url,
      timeoutMs: this.options.timeoutMs,
      maxBytes: Math.min(8_192, this.options.maxBytes),
      accept: "text/html,application/pdf,text/plain,*/*",
    });
    const contentType = head.contentType ?? "";

    if (
      contentType.includes("application/pdf") ||
      this.url.toLowerCase().endsWith(".pdf")
    ) {
      const bin = await safeFetchBinary({
        url: this.url,
        timeoutMs: this.options.timeoutMs,
        maxBytes: this.options.maxBytes,
        accept: "application/pdf",
      });
      const parsed = await parsePdf(Buffer.from(bin.bytes));
      return [
        new Document({
          pageContent: normalizeTextForSearch(parsed.text ?? ""),
          metadata: {
            sourceType: "url",
            sourceUri: this.url,
            contentType: "pdf",
            pageCount: parsed.numpages,
          },
        }),
      ];
    }

    const page = await safeFetchText({
      url: this.url,
      timeoutMs: this.options.timeoutMs,
      maxBytes: this.options.maxBytes,
      accept: "text/html,text/plain,*/*",
    });
    const text = contentType.includes("text/html")
      ? htmlToText(page.text)
      : page.text;

    return [
      new Document({
        pageContent: normalizeTextForSearch(text),
        metadata: {
          sourceType: "url",
          sourceUri: this.url,
          contentType: contentType.includes("text/html") ? "html" : "text",
        },
      }),
    ];
  }
}

async function parsePdf(
  data: Buffer,
): Promise<{ text: string; numpages?: number }> {
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
