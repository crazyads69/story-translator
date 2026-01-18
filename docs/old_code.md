================================================
FILE: index.ts
================================================
import { TranslateService } from "./src/translate";
import { createMarkdownParser } from "./src/ingest/markdown-parser";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, basename } from "path";

function print(s: string) {
process.stdout.write(s + "\n");
}

function usage() {
print("Usage:");
print(" bun run index.ts ingest");
print(
" bun run index.ts translate --chapter <path> --metadata <path> [--out <dir>]"
);
print(
" bun run index.ts auto [--orig <dir>] [--metaDir <dir>] [--out <dir>]"
);
}

function parseArgs(argv: string[]) {
const args = argv.slice(2);
const cmd = args[0];
const map: Record<string, string> = {};
for (let i = 1; i < args.length; i++) {
const k = args[i];
const n = args[i + 1];
if (k?.startsWith("--")) {
map[k.replace(/^--/, "")] = n || "true";
i++;
}
}
return { cmd, options: map };
}

async function runIngest() {
await import("./src/ingest/index.ts");
}

function loadMetadata(path?: string, fallbackChapterPath?: string) {
if (path && existsSync(path)) {
const s = readFileSync(path, "utf-8");
return JSON.parse(s);
}
if (fallbackChapterPath) {
const parser = createMarkdownParser();
const ch = parser.parseFile(fallbackChapterPath);
return {
id:
ch.metadata.story_id ||
ch.metadata.id ||
basename(fallbackChapterPath).replace(/\.[^/.]+$/, ""),
title: ch.metadata.title || "",
author: ch.metadata.author || "",
category: "",
originalLanguage: ch.metadata.language || "Unknown",
targetLanguage: "Vietnamese",
characters: [],
description: "",
};
}
return null;
}

function writeOutputs(
outDir: string,
chapterPath: string,
data: {
outputs: {
index: number;
original: string;
translated: string;
enhanced: string;
}[];
chapterId: string;
title?: string;
}
) {
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const base = basename(chapterPath).replace(/\.[^/.]+$/, "");
  const jsonPath = join(outDir, `translated_${base}.json`);
  const mdPath = join(outDir, `translated\_${base}.md`);
  writeFileSync(jsonPath, JSON.stringify(data, null, 2), "utf-8");
  const md = data.outputs.map((o) => o.enhanced).join("\n\n");
  writeFileSync(mdPath, md, "utf-8");
  print(`Wrote: ${jsonPath}`);
  print(`Wrote: ${mdPath}`);
}

async function runTranslate(opts: Record<string, string>) {
const chapterPath = opts["chapter"];
const metadataPath = opts["metadata"];
const outDir = opts["out"] || "./data/translated";
if (!chapterPath) {
usage();
process.exit(1);
}
const svc = new TranslateService();
const meta = loadMetadata(metadataPath, chapterPath);
if (!meta) {
print("Missing metadata");
process.exit(1);
}
const res = await svc.translateChapterFromMarkdown(chapterPath, meta);
writeOutputs(outDir, chapterPath, res);
}

async function runAuto(opts: Record<string, string>) {
const origDir =
opts["orig"] || process.env.ORIGINAL_CHAPTERS_PATH || "./data/original";
const metaDir = opts["metaDir"] || "./data/metadata";
const outDir = opts["out"] || "./data/translated";
await runIngest();
const parser = createMarkdownParser();
const files = parser.getMarkdownFiles(origDir);
const svc = new TranslateService();
for (const file of files) {
const ch = parser.parseFile(file);
const storyId =
ch.metadata.story_id ||
ch.metadata.id ||
basename(file).replace(/\.[^/.]+$/, "");
    const metaPath = join(metaDir, `${storyId}.json`);
    const meta = loadMetadata(
      existsSync(metaPath) ? metaPath : undefined,
      file
    );
    if (!meta) {
      print(`Missing metadata for ${file}`);
      continue;
    }
    const res = await svc.translateChapterFromMarkdown(file, meta);
    const s = res.summary;
    print(`Chapter: ${file}`);
    print(`  Paragraphs: ${s.paragraphs}`);
    print(`  RAG original hits: ${s.ragOriginalHits}`);
    print(`  RAG translated hits: ${s.ragTranslatedHits}`);
    print(`  RAG queries: ${s.ragQueries}`);
    print(`  Ground truth queries: ${s.groundTruthQueries}`);
    print(`  Ground truth results: ${s.groundTruthResults}`);
    print(`  Ground truth merged count: ${s.groundTruthMergedCount}`);
    print(`  Linkage changes: ${s.linkageChanges}/${s.paragraphs}`);
    print(` Languages searched: ${s.languagesSearched.join(", ")}`);
writeOutputs(outDir, file, res);
}
}

async function main() {
const { cmd, options } = parseArgs(process.argv);
if (!cmd) {
usage();
process.exit(1);
}
if (cmd === "ingest") {
await runIngest();
return;
}
if (cmd === "translate") {
await runTranslate(options);
return;
}
if (cmd === "auto") {
await runAuto(options);
return;
}
usage();
process.exit(1);
}

main().catch((e) => {
print(String(e));
process.exit(1);
});

================================================
FILE: src/ingest/index.ts
================================================
import { existsSync, mkdirSync } from "fs";
import { createOpenRouterEmbeddings } from "./embedding";
import { createLanceDBService } from "./vectordb";
import { createMarkdownParser } from "./markdown-parser";
import type { ParagraphDocument } from "./interface";

// Load environment variables
const env = {
OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
JINA_API_KEY: process.env.JINA_API_KEY,
EMBEDDING_MODEL:
process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small",
LANCEDB_PATH: process.env.LANCEDB_PATH || "./lancedb",
LANCEDB_TABLE_NAME: process.env.LANCEDB_TABLE_NAME || "story_chapters",
ORIGINAL_CHAPTERS_PATH:
process.env.ORIGINAL_CHAPTERS_PATH || "./data/original",
TRANSLATED_CHAPTERS_PATH:
process.env.TRANSLATED_CHAPTERS_PATH || "./data/translated",
};

async function mapWithConcurrency<T, R>(
items: T[],
concurrency: number,
fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
const results: R[] = new Array(items.length) as R[];
let next = 0;
const workers = Array.from(
{ length: Math.min(concurrency, items.length) },
async () => {
while (true) {
const i = next++;
if (i >= items.length) break;
try {
results[i] = await fn(items[i]!, i);
} catch {
results[i] = undefined as unknown as R;
}
}
}
);
await Promise.all(workers);
return results;
}

async function main() {
console.log("🔄 Story Chapter Embedder - Ingestion Script");
console.log("=".repeat(60));

// Validate environment
if (!env.OPENROUTER_API_KEY) {
console.error("\n❌ Error: OPENROUTER_API_KEY is required");
console.log("Get your API key at: https://openrouter.ai/keys");
console.log("Then set it in .env file or environment variable");
process.exit(1);
}

// Initialize services
console.log("\n📦 Initializing services...");
console.log(`  Embedding Model: ${env.EMBEDDING_MODEL}`);
console.log(`  LanceDB Path: ${env.LANCEDB_PATH}`);
console.log(`  Table Name: ${env.LANCEDB_TABLE_NAME}`);

const embeddings = createOpenRouterEmbeddings();
const lancedb = createLanceDBService({
initReranker: true,
rerankerModel: "jina-reranker-v3",
});
const parser = createMarkdownParser();
const concurrency = parseInt(process.env.EMBEDDING_CONCURRENCY || "4", 10);
const embedWithRetry = async (
text: string,
retries = 3,
baseDelayMs = 500
): Promise<number[]> => {
for (let attempt = 0; attempt <= retries; attempt++) {
try {
return await embeddings.embedText(text);
} catch (e) {
if (attempt === retries) throw e;
const delay = baseDelayMs \* Math.pow(2, attempt);
await sleep(delay);
}
}
return [];
};

// Ensure LanceDB directory exists
if (!existsSync(env.LANCEDB_PATH)) {
mkdirSync(env.LANCEDB_PATH, { recursive: true });
}

// Connect to LanceDB
await lancedb.connect();
await lancedb.ensureTable();

// Process original chapters
console.log("\n📖 Processing ORIGINAL chapters...");
console.log(`  Source: ${env.ORIGINAL_CHAPTERS_PATH}`);

if (!existsSync(env.ORIGINAL_CHAPTERS_PATH)) {
console.log(`  ⚠️  Directory not found: ${env.ORIGINAL_CHAPTERS_PATH}`);
console.log(" Creating directory...");
mkdirSync(env.ORIGINAL_CHAPTERS_PATH, { recursive: true });
}

const originalChapters = parser.parseDirectory(env.ORIGINAL_CHAPTERS_PATH);
console.log(`  Found ${originalChapters.length} original chapter(s)\n`);

let chapterIndex = 0;
for (const chapter of originalChapters) {
chapterIndex++;
console.log(
`  [${chapterIndex}/${originalChapters.length}] Processing: ${chapter.filename}`
);

    try {
      // Split chapter into paragraphs
      const paragraphs = parser.splitIntoParagraphs(chapter.content);
      console.log(`    Total paragraphs: ${paragraphs.length}`);

      // Group short paragraphs (optional, comment out if not needed)
      const groups = parser.groupShortParagraphs(paragraphs, 50, 3);
      const hasGrouping = groups.some((g) => g.length > 1);
      if (hasGrouping) {
        console.log(
          `    Grouped ${
            groups.filter((g) => g.length > 1).length
          } dialogue sections`
        );
      }

      // Detect language from metadata or default to 'en'
      const language = chapter.metadata.language || "en";

      // Extract chapter info
      const chapterId =
        chapter.metadata.id || chapter.filename.replace(/\.[^/.]+$/, "");
      const chapterNumber =
        chapter.metadata.chapter_number ??
        parser.extractChapterNumber(chapter.filename) ??
        undefined;

      const paragraphDocs: ParagraphDocument[] = (
        await mapWithConcurrency(groups, concurrency, async (group) => {
          if (!group || group.length === 0)
            return undefined as unknown as ParagraphDocument;
          const mainIndex = group[0]!;
          const paragraphText = group
            .map((idx) => paragraphs[idx])
            .join("\n\n");
          if (paragraphText.length < 10 && group.length === 1)
            return undefined as unknown as ParagraphDocument;
          const { fullContext, prevContext, nextContext } =
            parser.buildContextWindow(paragraphs, mainIndex, 1);
          const embeddingText = parser.truncateToTokenLimit(fullContext, 8000);
          const vector = await embedWithRetry(embeddingText);
          const doc: ParagraphDocument = {
            id: `${chapterId}_para_${mainIndex}`,
            chapter_id: chapterId,
            filename: chapter.filename,
            paragraph_index: mainIndex,
            paragraph_text: paragraphText,
            content_type: "original",
            language: language,
            vector: vector,
            metadata: {
              story_id: chapter.metadata.story_id,
              chapter_number: chapterNumber,
              chapter_title: chapter.metadata.title,
              author: chapter.metadata.author,
              total_paragraphs: paragraphs.length,
              word_count: parser.getWordCount(paragraphText),
              has_prev_context: prevContext.length > 0,
              has_next_context: nextContext.length > 0,
              is_grouped: group.length > 1,
              group_size: group.length,
            },
            created_at: new Date().toISOString(),
          };
          return doc;
        })
      ).filter((d): d is ParagraphDocument => !!d);

      // Insert all paragraphs for this chapter in batch
      if (paragraphDocs.length > 0) {
        await lancedb.insertBatch(paragraphDocs);
      }

      console.log(`    ✓ Embedded ${paragraphDocs.length} paragraphs\n`);
    } catch (error) {
      console.error(`    ❌ Error processing ${chapter.filename}:`, error);
    }

}

// Process translated chapters
console.log("\n🌐 Processing TRANSLATED chapters...");
console.log(`  Source: ${env.TRANSLATED_CHAPTERS_PATH}`);

if (!existsSync(env.TRANSLATED_CHAPTERS_PATH)) {
console.log(`  ⚠️  Directory not found: ${env.TRANSLATED_CHAPTERS_PATH}`);
console.log(" Creating directory...");
mkdirSync(env.TRANSLATED_CHAPTERS_PATH, { recursive: true });
}

const translatedChapters = parser.parseDirectory(
env.TRANSLATED_CHAPTERS_PATH
);
console.log(`  Found ${translatedChapters.length} translated chapter(s)\n`);

let translatedIndex = 0;
for (const chapter of translatedChapters) {
translatedIndex++;
console.log(
`  [${translatedIndex}/${translatedChapters.length}] Processing: ${chapter.filename}`
);

    try {
      // Split chapter into paragraphs
      const paragraphs = parser.splitIntoParagraphs(chapter.content);
      console.log(`    Total paragraphs: ${paragraphs.length}`);

      // Group short paragraphs (optional)
      const groups = parser.groupShortParagraphs(paragraphs, 50, 3);
      const hasGrouping = groups.some((g) => g.length > 1);
      if (hasGrouping) {
        console.log(
          `    Grouped ${
            groups.filter((g) => g.length > 1).length
          } dialogue sections`
        );
      }

      // Detect language from metadata or default to 'vi'
      const language = chapter.metadata.language || "vi";

      // Extract chapter info
      const chapterId =
        chapter.metadata.id || chapter.filename.replace(/\.[^/.]+$/, "");
      const chapterNumber =
        chapter.metadata.chapter_number ??
        parser.extractChapterNumber(chapter.filename) ??
        undefined;

      const paragraphDocs: ParagraphDocument[] = (
        await mapWithConcurrency(groups, concurrency, async (group) => {
          if (!group || group.length === 0)
            return undefined as unknown as ParagraphDocument;
          const mainIndex = group[0]!;
          const paragraphText = group
            .map((idx) => paragraphs[idx])
            .join("\n\n");
          if (paragraphText.length < 10 && group.length === 1)
            return undefined as unknown as ParagraphDocument;
          const { fullContext, prevContext, nextContext } =
            parser.buildContextWindow(paragraphs, mainIndex, 1);
          const embeddingText = parser.truncateToTokenLimit(fullContext, 8000);
          const vector = await embedWithRetry(embeddingText);
          const doc: ParagraphDocument = {
            id: `${chapterId}_para_${mainIndex}`,
            chapter_id: chapterId,
            filename: chapter.filename,
            paragraph_index: mainIndex,
            paragraph_text: paragraphText,
            content_type: "translated",
            language: language,
            vector: vector,
            metadata: {
              story_id: chapter.metadata.story_id,
              chapter_number: chapterNumber,
              chapter_title: chapter.metadata.title,
              translator: chapter.metadata.translator,
              total_paragraphs: paragraphs.length,
              word_count: parser.getWordCount(paragraphText),
              has_prev_context: prevContext.length > 0,
              has_next_context: nextContext.length > 0,
              is_grouped: group.length > 1,
              group_size: group.length,
            },
            created_at: new Date().toISOString(),
          };
          return doc;
        })
      ).filter((d): d is ParagraphDocument => !!d);

      // Insert all paragraphs for this chapter in batch
      if (paragraphDocs.length > 0) {
        await lancedb.insertBatch(paragraphDocs);
      }

      console.log(`    ✓ Embedded ${paragraphDocs.length} paragraphs\n`);
    } catch (error) {
      console.error(`    ❌ Error processing ${chapter.filename}:`, error);
    }

}

// Create FTS index for hybrid search
console.log("\n🔍 Creating Full-Text Search index...");
try {
await lancedb.createFTSIndex("paragraph_text");
} catch (error) {
console.log(" ⚠️ FTS index creation skipped (may already exist)");
}

// Show final statistics
console.log("\n📊 Getting database statistics...");
const stats = await lancedb.getStats();

console.log("\n" + "=".repeat(60));
console.log("✅ Ingestion Complete!");
console.log("=".repeat(60));
console.log(`Total documents: ${stats.total_documents}`);
console.log("\nBy type:");
Object.entries(stats.by_type).forEach(([type, count]) => {
console.log(`  ${type}: ${count}`);
});
console.log("\nBy language:");
Object.entries(stats.by_language).forEach(([lang, count]) => {
console.log(`  ${lang}: ${count}`);
});
console.log("\n✨ All chapters embedded successfully!");
console.log(`📁 Database location: ${env.LANCEDB_PATH}\n`);
}

function sleep(ms: number): Promise<void> {
return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run the script
main().catch((error) => {
console.error("\n💥 Fatal error:", error);
process.exit(1);
});

================================================
FILE: src/ingest/interface.ts
================================================
// For mapping chapter metadata from markdown files
export interface ChapterMetadata {
id?: string;
story_id?: string;
chapter_number?: number;
title?: string;
author?: string;
language?: string;
[key: string]: any;
}

// For parsing data from markdown files
export interface ParsedChapter {
filename: string;
filepath: string;
content: string; // Full text content
metadata: ChapterMetadata;
}

// Paragraph-specific metadata (extends chapter info)
export interface ParagraphMetadata {
story_id?: string;
chapter_number?: number;
author?: string;
chapter_title?: string; // Maps from ChapterMetadata.title
translator?: string;
total_paragraphs?: number;
word_count?: number;
has_prev_context?: boolean; // Whether previous context was included
has_next_context?: boolean; // Whether next context was included
is_grouped?: boolean; // If this is a group of short paragraphs
group_size?: number; // Number of paragraphs in group
[key: string]: unknown;
}

// Interface for store each embedding with its associated metadata
export interface ParagraphDocument {
id: string;
chapter_id: string;
filename: string;
paragraph_index: number;
paragraph_text: string; // Main paragraph only (for display/retrieval)
content_type: "original" | "translated";
language: string; // 'en', 'vi', 'zh', etc.
vector: number[]; // Embedding vector (includes context window)
metadata?: ParagraphMetadata;
created_at: string;
// Index signature for LanceDB compatibility
[key: string]: unknown;
}

================================================
FILE: src/ingest/test-search.ts
================================================
#!/usr/bin/env bun
/\*\*

- Test Search Script with Hybrid Search + Jina Reranking
-
- Usage: bun run test:search "your search query"
-
- Example: bun run test:search "Haerin ngã"
  \*/

import { createLanceDBService, type SearchResult } from "./vectordb";
import { createOpenRouterEmbeddings } from "./embedding";

// ANSI color codes for terminal output
const colors = {
reset: "\x1b[0m",
bright: "\x1b[1m",
dim: "\x1b[2m",
cyan: "\x1b[36m",
green: "\x1b[32m",
yellow: "\x1b[33m",
blue: "\x1b[34m",
magenta: "\x1b[35m",
red: "\x1b[31m",
bgBlue: "\x1b[44m",
bgGreen: "\x1b[42m",
};

function printHeader(text: string) {
console.log(`\n${colors.bgBlue}${colors.bright} ${text} ${colors.reset}`);
console.log("─".repeat(60));
}

function printSubHeader(text: string) {
console.log(`\n${colors.cyan}${colors.bright}▸ ${text}${colors.reset}`);
}

function printResult(idx: number, result: SearchResult, showFull: boolean = false) {
const typeColor = result.content_type === "original" ? colors.green : colors.magenta;
const typeLabel = result.content_type === "original" ? "ORIGINAL" : "TRANSLATED";

console.log(`\n${colors.bright}${idx + 1}.${colors.reset} ${typeColor}[${typeLabel}]${colors.reset} ${colors.dim}${result.chapter_id}${colors.reset}`);

// Show scores
const scores: string[] = [];
if (result.\_rerank_score !== undefined) {
scores.push(`${colors.yellow}Rerank: ${(result._rerank_score * 100).toFixed(1)}%${colors.reset}`);
}
if (result.\_distance !== undefined) {
scores.push(`${colors.dim}Distance: ${result._distance.toFixed(4)}${colors.reset}`);
}
if (scores.length > 0) {
console.log(`   ${scores.join(" │ ")}`);
}

// Show text content
const text = result.paragraph_text || "";
const displayText = showFull ? text : truncateText(text, 200);
console.log(`   ${colors.dim}───${colors.reset}`);
console.log(`   ${displayText}`);

// Show metadata
if (result.metadata) {
const meta: string[] = [];
if (result.metadata.chapter_number) meta.push(`Ch.${result.metadata.chapter_number}`);
if (result.metadata.word_count) meta.push(`${result.metadata.word_count} words`);
if (result.language) meta.push(`Lang: ${result.language}`);
if (meta.length > 0) {
console.log(`   ${colors.dim}${meta.join(" • ")}${colors.reset}`);
}
}
}

function truncateText(text: string, maxLength: number): string {
if (text.length <= maxLength) return text;
return text.substring(0, maxLength).trim() + "...";
}

async function main() {
// Get search query from command line arguments
const args = process.argv.slice(2);

if (args.length === 0) {
console.log(`${colors.red}❌ Error: Please provide a search query${colors.reset}`);
console.log(`\nUsage: bun run test:search "your search query"`);
console.log(`Example: bun run test:search "Haerin ngã"`);
process.exit(1);
}

const searchQuery = args.join(" ");
const limit = parseInt(process.env.SEARCH_LIMIT || "5", 10);
const showFull = process.env.SHOW_FULL === "true";

console.log(`\n${colors.bgGreen}${colors.bright} 🔍 Story Search Test ${colors.reset}`);
console.log("═".repeat(60));
console.log(`${colors.bright}Query:${colors.reset} "${searchQuery}"`);
console.log(`${colors.bright}Limit:${colors.reset} ${limit} results per category`);

// Check for required environment variables
if (!process.env.OPENROUTER_API_KEY) {
console.error(`\n${colors.red}❌ OPENROUTER_API_KEY environment variable is required${colors.reset}`);
process.exit(1);
}

const hasReranker = !!process.env.JINA_API_KEY;
if (!hasReranker) {
console.log(`${colors.yellow}⚠️  JINA_API_KEY not set - reranking disabled${colors.reset}`);
}

try {
// Initialize services
printSubHeader("Initializing services...");

    const lancedb = createLanceDBService({ initReranker: hasReranker });
    await lancedb.connect();

    const embeddings = createOpenRouterEmbeddings();

    // Get database stats
    const stats = await lancedb.getStats();
    console.log(`${colors.dim}Database: ${stats.total_documents} documents${colors.reset}`);

    // Generate embedding for query
    printSubHeader("Generating query embedding...");
    const startEmbed = Date.now();
    const queryVector = await embeddings.embedText(searchQuery);
    console.log(`${colors.dim}Embedding generated in ${Date.now() - startEmbed}ms${colors.reset}`);

    // ═══════════════════════════════════════════════════════════════
    // Search ORIGINAL content
    // ═══════════════════════════════════════════════════════════════
    printHeader("📖 ORIGINAL Content Results");

    const startOriginal = Date.now();
    const originalResults = await lancedb.hybridSearch(searchQuery, queryVector, {
      limit,
      filter: { content_type: "original" },
      rerank: hasReranker,
      rerankCandidates: limit * 3,
    });
    const originalTime = Date.now() - startOriginal;

    if (originalResults.length === 0) {
      console.log(`${colors.dim}No results found in original content${colors.reset}`);
    } else {
      console.log(`${colors.dim}Found ${originalResults.length} results in ${originalTime}ms${colors.reset}`);
      originalResults.forEach((result, idx) => printResult(idx, result, showFull));
    }

    // ═══════════════════════════════════════════════════════════════
    // Search TRANSLATED content
    // ═══════════════════════════════════════════════════════════════
    printHeader("🌐 TRANSLATED Content Results");

    const startTranslated = Date.now();
    const translatedResults = await lancedb.hybridSearch(searchQuery, queryVector, {
      limit,
      filter: { content_type: "translated" },
      rerank: hasReranker,
      rerankCandidates: limit * 3,
    });
    const translatedTime = Date.now() - startTranslated;

    if (translatedResults.length === 0) {
      console.log(`${colors.dim}No results found in translated content${colors.reset}`);
    } else {
      console.log(`${colors.dim}Found ${translatedResults.length} results in ${translatedTime}ms${colors.reset}`);
      translatedResults.forEach((result, idx) => printResult(idx, result, showFull));
    }

    // ═══════════════════════════════════════════════════════════════
    // Search ALL content (combined)
    // ═══════════════════════════════════════════════════════════════
    printHeader("🔄 ALL Content Results (Combined)");

    const startAll = Date.now();
    const allResults = await lancedb.hybridSearch(searchQuery, queryVector, {
      limit,
      rerank: hasReranker,
      rerankCandidates: limit * 3,
    });
    const allTime = Date.now() - startAll;

    if (allResults.length === 0) {
      console.log(`${colors.dim}No results found${colors.reset}`);
    } else {
      console.log(`${colors.dim}Found ${allResults.length} results in ${allTime}ms${colors.reset}`);
      allResults.forEach((result, idx) => printResult(idx, result, showFull));
    }

    // ═══════════════════════════════════════════════════════════════
    // Summary
    // ═══════════════════════════════════════════════════════════════
    console.log("\n" + "═".repeat(60));
    console.log(`${colors.bright}📊 Summary${colors.reset}`);
    console.log("─".repeat(60));
    console.log(`Query: "${searchQuery}"`);
    console.log(`Original results: ${originalResults.length} (${originalTime}ms)`);
    console.log(`Translated results: ${translatedResults.length} (${translatedTime}ms)`);
    console.log(`All results: ${allResults.length} (${allTime}ms)`);
    console.log(`Reranking: ${hasReranker ? "✅ Enabled" : "❌ Disabled"}`);
    console.log("═".repeat(60) + "\n");

} catch (error) {
console.error(`\n${colors.red}❌ Error:${colors.reset}`, error);
process.exit(1);
}
}

// Run the script
main();

================================================
FILE: src/ingest/embedding/index.ts
================================================
import { OpenRouter } from '@openrouter/sdk';
import type { CreateEmbeddingsResponseBody } from '@openrouter/sdk/models/operations';

export class OpenRouterEmbeddings {
private apiKey: string;
private model: string;
private openRouterClient: OpenRouter;

constructor(apiKey: string, model: string = "openai/text-embedding-3-small") {
if (!apiKey) {
throw new Error("OpenRouter API key is required");
}
this.apiKey = apiKey;
this.model = model;

    // Initialize OpenRouter SDK client
    this.openRouterClient = new OpenRouter({
      apiKey: this.apiKey,
    });

}

/\*\*

- Generate embedding for a single text
- Based on OpenRouter API docs: https://openrouter.ai/docs#embeddings
  \*/
  async embedText(text: string): Promise<number[]> {
  // Truncate text to prevent token limit issues
  const truncatedText = text.slice(0, 8000);


    try {
      const response = await this.openRouterClient.embeddings.generate({
        model: this.model,
        input: truncatedText,
      });

      // Response can be CreateEmbeddingsResponseBody or string
      if (typeof response === 'string') {
        throw new Error("Unexpected string response from OpenRouter API");
      }

      const body = response as CreateEmbeddingsResponseBody;

      // Extract embedding from response
      if (!body.data || !body.data[0] || !body.data[0].embedding) {
        throw new Error("Invalid response from OpenRouter API");
      }

      const embedding = body.data[0].embedding;
      // embedding can be number[] or string (base64)
      if (typeof embedding === 'string') {
        throw new Error("Base64 embedding format not supported");
      }

      return embedding;
    } catch (error) {
      console.error("Error generating embedding:", error);
      throw new Error(`OpenRouter API error: ${error instanceof Error ? error.message : String(error)}`);
    }

}

/\*\*

- Generate embeddings for multiple texts in batch
- More efficient for bulk operations
  \*/
  async embedBatch(texts: string[]): Promise<number[][]> {
  // Truncate all texts
  const truncatedTexts = texts.map(text => text.slice(0, 8000));


    try {
      const response = await this.openRouterClient.embeddings.generate({
        model: this.model,
        input: truncatedTexts,
      });

      // Response can be CreateEmbeddingsResponseBody or string
      if (typeof response === 'string') {
        throw new Error("Unexpected string response from OpenRouter API");
      }

      const body = response as CreateEmbeddingsResponseBody;

      // Extract embeddings from batch response
      if (!body.data || !Array.isArray(body.data)) {
        throw new Error("Invalid batch response from OpenRouter API");
      }

      return body.data.map((item) => {
        if (typeof item.embedding === 'string') {
          throw new Error("Base64 embedding format not supported");
        }
        return item.embedding;
      });
    } catch (error) {
      console.error("Error generating batch embeddings:", error);
      throw new Error(`OpenRouter API batch error: ${error instanceof Error ? error.message : String(error)}`);
    }

}

/\*\*

- Get embedding dimension for the current model
  \*/
  getEmbeddingDimension(): number {
  // Common dimensions for OpenAI models via OpenRouter
  const dimensions: Record<string, number> = {
  "openai/text-embedding-3-small": 1536,
  "openai/text-embedding-3-large": 3072,
  "openai/text-embedding-ada-002": 1536,
  };


    return dimensions[this.model] || 1536;

}
}

/\*\*

- Create OpenRouter embeddings instance from environment variables
  \*/
  export function createOpenRouterEmbeddings(): OpenRouterEmbeddings {
  const apiKey = process.env.OPENROUTER_API_KEY;

if (!apiKey) {
throw new Error(
"OPENROUTER_API_KEY environment variable is required.\n" +
"Get your API key at: https://openrouter.ai/keys"
);
}

const model = process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small";

return new OpenRouterEmbeddings(apiKey, model);
}

================================================
FILE: src/ingest/markdown-parser/index.ts
================================================
// Parse markdown chapter files with frontmatter

import matter from "gray-matter";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, extname, basename } from "path";
import type { ParsedChapter, ChapterMetadata } from "../interface";

export class MarkdownParser {
/\*\*

- Parse a single markdown file
  \*/
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

- Get all markdown files from a directory
  \*/
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

- Parse all markdown files in a directory
  \*/
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

- Get total word count from content
  \*/
  getWordCount(content: string): number {
  return content.split(/\s+/).filter(word => word.length > 0).length;
  }

/\*\*

- Get total character count
  \*/
  getCharCount(content: string): number {
  return content.length;
  }

/\*\*

- Split content into paragraphs
- Splits by double newlines and filters empty paragraphs
  \*/
  splitIntoParagraphs(content: string): string[] {
  return content
  .split(/\n\n+/)
  .map(p => p.trim())
  .filter(p => p.length > 0);
  }

/\*\*

- Group consecutive short paragraphs (e.g., dialogue)
- Returns array of paragraph groups, each group is an array of paragraph indices
  \*/
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

/\*\*

- Build context window for a paragraph
- Includes previous and next paragraphs for better semantic embedding
  \*/
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

/\*\*

- Truncate text to approximate token limit
- Rough estimate: 1 token ≈ 4 characters
  _/
  truncateToTokenLimit(text: string, maxTokens: number = 8000): string {
  const maxChars = maxTokens _ 4;
  if (text.length <= maxChars) {
  return text;
  }
  return text.substring(0, maxChars);
  }

/\*\*

- Extract chapter number from filename if not in frontmatter
- Examples: "chapter_001.md", "ch1.md", "001_chapter_title.md"
  \*/
  extractChapterNumber(filename: string): number | null {
  // Try to find a number in the filename
  const matches = filename.match(/(\d+)/);
  if (matches && matches[1]) {
  return parseInt(matches[1], 10);
  }
  return null;
  }
  }

/\*\*

- Create markdown parser instance
  \*/
  export function createMarkdownParser(): MarkdownParser {
  return new MarkdownParser();
  }

================================================
FILE: src/ingest/reranker/index.ts
================================================
/\*\*

- Jina AI Reranker Service
- Enhances hybrid search results by reranking documents based on query relevance
-
- API Documentation: https://jina.ai/reranker/
- Endpoint: https://api.jina.ai/v1/rerank
  \*/

export interface JinaRerankerConfig {
apiKey: string;
model?: JinaRerankerModel;
baseUrl?: string;
}

/\*\*

- Available Jina Reranker models
- - jina-reranker-v2-base-multilingual: Best for multilingual retrieval (100+ languages)
- - jina-reranker-v1-base-en: English only, legacy
- - jina-reranker-v1-turbo-en: Fast English reranking
- - jina-reranker-v1-tiny-en: Smallest, fastest English model
    \*/
    export type JinaRerankerModel =
    | "jina-reranker-v2-base-multilingual"
    | "jina-reranker-v1-base-en"
    | "jina-reranker-v1-turbo-en"
    | "jina-reranker-v1-tiny-en"
    | "jina-reranker-v3";

/\*\*

- Request payload for Jina Reranker API
  _/
  export interface JinaRerankerRequest {
  /\*\* The search query to rank documents against _/
  query: string;
  /** Array of documents to rerank (strings or objects with text field) \*/
  documents: string[] | { text: string }[];
  /** Model to use for reranking _/
  model?: JinaRerankerModel;
  /\*\* Maximum number of top-ranked documents to return _/
  top_n?: number;
  /\*_ Whether to return document content in response _/
  return_documents?: boolean;
  }

/\*\*

- Single result from reranking
  _/
  export interface JinaRerankerResult {
  /\*\* Original index of the document in input array _/
  index: number;
  /** Relevance score (0-1, higher is more relevant) \*/
  relevance_score: number;
  /** Document content (if return_documents=true) \*/
  document?: {
  text: string;
  };
  }

/\*\*

- Response from Jina Reranker API
  \*/
  export interface JinaRerankerResponse {
  model: string;
  usage: {
  total_tokens: number;
  prompt_tokens?: number;
  };
  results: JinaRerankerResult[];
  }

/\*\*

- Error response from Jina API
  \*/
  export interface JinaAPIError {
  detail?: string;
  message?: string;
  }

/\*\*

- Jina AI Reranker Service
-
- Reranks search results to improve relevance using Jina AI's neural reranker.
- Best used after initial retrieval from vector search or hybrid search.
-
- @example
- ```typescript

  ```
- const reranker = new JinaReranker({ apiKey: 'your-api-key' });
-
- const documents = [
- "Document about cats and dogs",
- "Document about machine learning",
- "Document about pets and animals"
- ];
-
- const results = await reranker.rerank("What pets are popular?", documents, 2);
- // Returns top 2 most relevant documents
- ```
   */
  export class JinaReranker {
    private apiKey: string;
    private model: JinaRerankerModel;
    private baseUrl: string;
  ```

constructor(config: JinaRerankerConfig) {
if (!config.apiKey) {
throw new Error("Jina API key is required");
}

    this.apiKey = config.apiKey;
    this.model = config.model || "jina-reranker-v2-base-multilingual";
    this.baseUrl = config.baseUrl || "https://api.jina.ai/v1/rerank";

}

/\*\*

- Rerank documents based on query relevance
-
- @param query - The search query
- @param documents - Array of document strings or objects
- @param topN - Number of top results to return (default: all)
- @param returnDocuments - Whether to include document content in response
- @returns Reranked results with scores
  \*/
  async rerank(
  query: string,
  documents: string[] | { text: string }[],
  topN?: number,
  returnDocuments: boolean = true
  ): Promise<JinaRerankerResult[]> {
  if (!documents || documents.length === 0) {
  return [];
  }


    // Validate inputs
    if (!query || query.trim() === "") {
      throw new Error("Query cannot be empty");
    }

    const requestBody: JinaRerankerRequest = {
      query,
      documents,
      model: this.model,
      return_documents: returnDocuments,
    };

    if (topN !== undefined && topN > 0) {
      requestBody.top_n = topN;
    }

    try {
      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as JinaAPIError;
        const errorMessage = errorData.detail || errorData.message || `HTTP ${response.status}`;
        throw new Error(`Jina Reranker API error: ${errorMessage}`);
      }

      const data = await response.json() as JinaRerankerResponse;
      return data.results;
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Failed to rerank documents: ${String(error)}`);
    }

}

/\*\*

- Rerank with full response including usage stats
  \*/
  async rerankWithUsage(
  query: string,
  documents: string[] | { text: string }[],
  topN?: number
  ): Promise<JinaRerankerResponse> {
  if (!documents || documents.length === 0) {
  return {
  model: this.model,
  usage: { total_tokens: 0 },
  results: [],
  };
  }


    const requestBody: JinaRerankerRequest = {
      query,
      documents,
      model: this.model,
      top_n: topN,
      return_documents: true,
    };

    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as JinaAPIError;
      throw new Error(`Jina Reranker API error: ${errorData.detail || response.statusText}`);
    }

    return response.json() as Promise<JinaRerankerResponse>;

}

/\*\*

- Change the reranker model
  \*/
  setModel(model: JinaRerankerModel): void {
  this.model = model;
  }

/\*\*

- Get current model being used
  \*/
  getModel(): JinaRerankerModel {
  return this.model;
  }
  }

/\*\*

- Create Jina Reranker from environment variable
  \*/
  export function createJinaReranker(
  model?: JinaRerankerModel
  ): JinaReranker {
  const apiKey = process.env.JINA_API_KEY;

if (!apiKey) {
throw new Error(
"JINA_API_KEY environment variable is required. " +
"Get your API key from https://jina.ai/reranker/"
);
}

return new JinaReranker({
apiKey,
model,
});
}

================================================
FILE: src/ingest/vectordb/index.ts
================================================
import \* as lancedb from "@lancedb/lancedb";
import type { Table, Connection } from "@lancedb/lancedb";
import type { ParagraphDocument } from "../interface";
import { JinaReranker, type JinaRerankerResult } from "../reranker";

/\*\*

- Search result with relevance score
  \*/
  export interface SearchResult extends ParagraphDocument {
  \_distance?: number; // Vector distance (lower is more similar)
  \_relevance_score?: number; // Combined score for hybrid search
  \_rerank_score?: number; // Jina reranker score (0-1, higher is better)
  }

/\*\*

- Hybrid search options
  \*/
  export interface HybridSearchOptions {
  limit?: number;
  filter?: Record<string, any>;
  // Full-text search column (defaults to paragraph_text)
  ftsColumn?: string;
  // Vector column name (defaults to vector)
  vectorColumn?: string;
  // Enable Jina reranking for improved relevance
  rerank?: boolean;
  // Number of candidates to fetch before reranking (should be > limit)
  rerankCandidates?: number;
  }

/\*\*

- Reranker configuration options
  \*/
  export interface RerankerOptions {
  apiKey?: string;
  model?: "jina-reranker-v2-base-multilingual" | "jina-reranker-v1-base-en" | "jina-reranker-v1-turbo-en" | "jina-reranker-v1-tiny-en" | "jina-reranker-v3";
  }

export class LanceDBVectorStore {
private db: Connection | null = null;
private tableName: string;
private dbPath: string;
private ftsIndexCreated: boolean = false;
private reranker: JinaReranker | null = null;

constructor(dbPath: string, tableName: string = "story_chapters") {
this.dbPath = dbPath;
this.tableName = tableName;
}

/\*\*

- Initialize Jina Reranker for enhanced search
- Call this method to enable reranking in hybrid search
  \*/
  initReranker(options?: RerankerOptions): void {
  const apiKey = options?.apiKey || process.env.JINA_API_KEY;


    if (!apiKey) {
      throw new Error(
        "Jina API key is required. Set JINA_API_KEY env variable or pass apiKey in options."
      );
    }

    this.reranker = new JinaReranker({
      apiKey,
      model: options?.model || "jina-reranker-v2-base-multilingual",
    });
    console.log("✓ Jina Reranker initialized");

}

/\*\*

- Check if reranker is available
  \*/
  hasReranker(): boolean {
  return this.reranker !== null;
  }

/\*\*

- Connect to LanceDB
- Creates database directory if it doesn't exist
  \*/
  async connect(): Promise<void> {
  console.log(`Connecting to LanceDB at: ${this.dbPath}`);
  this.db = await lancedb.connect(this.dbPath);
  console.log("✓ Connected to LanceDB");
  }

/\*\*

- Ensure database is connected
  \*/
  private ensureConnected(): Connection {
  if (!this.db) {
  throw new Error("Database not connected. Call connect() first.");
  }
  return this.db;
  }

/\*\*

- Create table if it doesn't exist
- Based on LanceDB docs schema definition
  \*/
  async ensureTable(): Promise<Table | null> {
  const db = this.ensureConnected();
  try {
  const table = await db.openTable(this.tableName);
  console.log(`✓ Using existing table: ${this.tableName}`);
  return table;
  } catch (error) {
  console.log(`Table '${this.tableName}' will be created on first insert`);
  return null;
  }
  }

/\*\*

- Create Full-Text Search index on paragraph_text column
- Required for hybrid search functionality
  \*/
  async createFTSIndex(column: string = "paragraph_text"): Promise<void> {
  const db = this.ensureConnected();
  try {
  const table = await db.openTable(this.tableName);
  await table.createIndex(column, {
  config: lancedb.Index.fts(),
  });
  this.ftsIndexCreated = true;
  console.log(`✓ Created FTS index on column: ${column}`);
  } catch (error: any) {
  // Index might already exist
  if (error.message?.includes("already exists")) {
  this.ftsIndexCreated = true;
  console.log(`FTS index already exists on column: ${column}`);
  } else {
  console.error("Error creating FTS index:", error);
  throw error;
  }
  }
  }

/\*\*

- Create vector index for faster similarity search
- Recommended for large datasets (> 10k rows)
  \*/
  async createVectorIndex(
  column: string = "vector",
  options?: {
  numPartitions?: number;
  numSubVectors?: number;
  distanceType?: "l2" | "cosine" | "dot";
  }
  ): Promise<void> {
  const db = this.ensureConnected();
  try {
  const table = await db.openTable(this.tableName);
  await table.createIndex(column, {
  config: lancedb.Index.ivfPq({
  numPartitions: options?.numPartitions ?? 256,
  numSubVectors: options?.numSubVectors ?? 16,
  distanceType: options?.distanceType ?? "cosine",
  }),
  });
  console.log(`✓ Created vector index on column: ${column}`);
  } catch (error: any) {
  if (error.message?.includes("already exists")) {
  console.log(`Vector index already exists on column: ${column}`);
  } else {
  console.error("Error creating vector index:", error);
  throw error;
  }
  }
  }

/\*\*

- Insert a single paragraph document
  \*/
  async insertParagraph(doc: ParagraphDocument): Promise<void> {
  const db = this.ensureConnected();
  try {
  const table = await db.openTable(this.tableName);
  await table.add([doc]);
  } catch (error: any) {
  if (error.message?.includes("not found") || error.message?.includes("does not exist")) {
  await db.createTable(this.tableName, [doc]);
  } else {
  throw error;
  }
  }
  }

/\*\*

- Insert multiple paragraph documents in batch
- More efficient for bulk inserts
  \*/
  async insertBatch(docs: ParagraphDocument[]): Promise<void> {
  if (docs.length === 0) {
  return;
  }


    const db = this.ensureConnected();
    try {
      const table = await db.openTable(this.tableName);
      await table.add(docs);
      console.log(`    ✓ Inserted ${docs.length} paragraphs in batch`);
    } catch (error: any) {
      if (error.message?.includes("not found") || error.message?.includes("does not exist")) {
        await db.createTable(this.tableName, docs);
        console.log(`    ✓ Created table and inserted ${docs.length} paragraphs`);
      } else {
        throw error;
      }
    }

}

/\*\*

- Build WHERE clause from filter object
  \*/
  private buildWhereClause(filter: Record<string, any>): string {
  return Object.entries(filter)
  .map(([key, value]) => {
  if (typeof value === "string") {
  return `${key} = '${value}'`;
  } else if (typeof value === "number") {
  return `${key} = ${value}`;
  } else if (typeof value === "boolean") {
  return `${key} = ${value}`;
  } else {
  return `${key} = '${String(value)}'`;
  }
  })
  .join(" AND ");
  }

/\*\*

- Vector similarity search
- Returns top K most similar documents by vector distance
  \*/
  async searchByVector(
  queryVector: number[],
  limit: number = 5,
  filter?: Record<string, any>
  ): Promise<SearchResult[]> {
  const db = this.ensureConnected();
  const table = await db.openTable(this.tableName);


    let query = table.search(queryVector).limit(limit);

    if (filter) {
      const whereClause = this.buildWhereClause(filter);
      if (whereClause) {
        query = query.where(whereClause);
      }
    }

    const results = await query.toArray();
    return results as SearchResult[];

}

/\*\*

- Full-text search on paragraph_text
- Returns documents matching the text query
  \*/
  async searchByText(
  queryText: string,
  limit: number = 5,
  filter?: Record<string, any>,
  column: string = "paragraph_text"
  ): Promise<SearchResult[]> {
  const db = this.ensureConnected();
  const table = await db.openTable(this.tableName);


    let query = table
      .query()
      .nearestToText(queryText, [column])
      .limit(limit);

    if (filter) {
      const whereClause = this.buildWhereClause(filter);
      if (whereClause) {
        query = query.where(whereClause);
      }
    }

    const results = await query.toArray();
    return results as SearchResult[];

}

/\*\*

- Hybrid search combining vector similarity + full-text search
- Best for finding contextually relevant paragraphs for translation enrichment
-
- This method combines:
- 1.  Vector similarity (semantic meaning)
- 2.  Full-text search (keyword matching)
- 3.  Optional: Jina AI reranking for improved relevance
-
- @param queryText - Text to search for (used for both FTS and embedding)
- @param queryVector - Pre-computed embedding vector for the query
- @param options - Search options including limit and filters
  \*/
  async hybridSearch(
  queryText: string,
  queryVector: number[],
  options: HybridSearchOptions = {}
  ): Promise<SearchResult[]> {
  const db = this.ensureConnected();
  const table = await db.openTable(this.tableName);


    const {
      limit = 10,
      filter,
      ftsColumn = "paragraph_text",
      rerank = false,
      rerankCandidates = Math.max(limit * 3, 20), // Fetch more candidates for reranking
    } = options;

    // Determine how many results to fetch
    const fetchLimit = rerank && this.reranker ? rerankCandidates : limit;

    // Perform hybrid search combining text and vector
    let query = table
      .query()
      .nearestToText(queryText, [ftsColumn])
      .nearestTo(queryVector)
      .limit(fetchLimit);

    if (filter) {
      const whereClause = this.buildWhereClause(filter);
      if (whereClause) {
        query = query.where(whereClause);
      }
    }

    const results = (await query.toArray()) as SearchResult[];

    // Apply Jina reranking if enabled
    if (rerank && this.reranker && results.length > 0) {
      return this.applyReranking(queryText, results, limit);
    }

    return results;

}

/\*\*

- Apply Jina AI reranking to search results
- Reorders results based on neural relevance scoring
  \*/
  private async applyReranking(
  query: string,
  results: SearchResult[],
  limit: number
  ): Promise<SearchResult[]> {
  if (!this.reranker) {
  return results.slice(0, limit);
  }


    try {
      // Extract text content for reranking
      const documents = results.map((r) => r.paragraph_text || "");

      // Get reranked results from Jina
      const rerankedResults = await this.reranker.rerank(query, documents, limit);

      // Map reranked results back to original documents with scores
      const rerankedDocs = rerankedResults.map((r: JinaRerankerResult) => {
        const originalDoc = results[r.index]!;
        return {
          ...originalDoc,
          _rerank_score: r.relevance_score,
        } as SearchResult;
      });

      console.log(`    ✓ Reranked ${results.length} → ${rerankedDocs.length} results`);
      return rerankedDocs;
    } catch (error) {
      console.error("Reranking failed, returning original results:", error);
      return results.slice(0, limit);
    }

}

/\*\*

- Enhanced hybrid search with Jina reranking (convenience method)
- Automatically enables reranking if reranker is initialized
-
- @param queryText - Search query text
- @param queryVector - Query embedding vector
- @param limit - Number of results to return
- @param filter - Optional filter criteria
  \*/
  async hybridSearchWithRerank(
  queryText: string,
  queryVector: number[],
  limit: number = 10,
  filter?: Record<string, any>
  ): Promise<SearchResult[]> {
  if (!this.reranker) {
  console.warn("Reranker not initialized. Call initReranker() first. Falling back to standard hybrid search.");
  return this.hybridSearch(queryText, queryVector, { limit, filter });
  }


    return this.hybridSearch(queryText, queryVector, {
      limit,
      filter,
      rerank: true,
      rerankCandidates: Math.max(limit * 3, 30),
    });

}

/\*\*

- Standalone rerank method for custom use cases
- Rerank any array of documents against a query
  \*/
  async rerankDocuments(
  query: string,
  documents: string[],
  topN?: number
  ): Promise<JinaRerankerResult[]> {
  if (!this.reranker) {
  throw new Error("Reranker not initialized. Call initReranker() first.");
  }


    return this.reranker.rerank(query, documents, topN);

}

/\*\*

- Search for similar paragraphs - alias for searchByVector for backward compatibility
  \*/
  async searchSimilar(
  queryVector: number[],
  limit: number = 5,
  filter?: Record<string, any>
  ): Promise<ParagraphDocument[]> {
  return this.searchByVector(queryVector, limit, filter);
  }

/\*\*

- Get all documents with optional filtering
  \*/
  async getAllDocuments(filter?: Record<string, any>): Promise<ParagraphDocument[]> {
  const db = this.ensureConnected();
  const table = await db.openTable(this.tableName);


    let query = table.query();

    if (filter) {
      const whereClause = this.buildWhereClause(filter);
      if (whereClause) {
        query = query.where(whereClause);
      }
    }

    const results = await query.toArray();
    return results as ParagraphDocument[];

}

/\*\*

- Get document by ID
  \*/
  async getDocumentById(id: string): Promise<ParagraphDocument | null> {
  const db = this.ensureConnected();
  try {
  const table = await db.openTable(this.tableName);
  const results = await table
  .query()
  .where(`id = '${id}'`)
  .limit(1)
  .toArray();

      if (results.length > 0) {
        return results[0] as ParagraphDocument;
      }
      return null;

  } catch (error) {
  console.error(`Error getting document ${id}:`, error);
  return null;
  }
  }

/\*\*

- Delete documents by filter
  \*/
  async deleteDocuments(filter: Record<string, any>): Promise<void> {
  const db = this.ensureConnected();
  const table = await db.openTable(this.tableName);


    const whereClause = this.buildWhereClause(filter);

    if (!whereClause) {
      throw new Error("Filter is required for deletion");
    }

    await table.delete(whereClause);
    console.log(`✓ Deleted documents matching: ${whereClause}`);

}

/\*\*

- Count rows in the table
  \*/
  async countRows(filter?: string): Promise<number> {
  const db = this.ensureConnected();
  const table = await db.openTable(this.tableName);
  return table.countRows(filter);
  }

/\*\*

- Get table statistics
  \*/
  async getStats(): Promise<{
  total_documents: number;
  by_type: Record<string, number>;
  by_language: Record<string, number>;
  }> {
  try {
  const db = this.ensureConnected();
  const table = await db.openTable(this.tableName);
  const allDocs = await table.query().toArray();

      const stats = {
        total_documents: allDocs.length,
        by_type: {} as Record<string, number>,
        by_language: {} as Record<string, number>,
      };

      allDocs.forEach((doc: any) => {
        const type = doc.content_type || "unknown";
        stats.by_type[type] = (stats.by_type[type] || 0) + 1;

        const lang = doc.language || "unknown";
        stats.by_language[lang] = (stats.by_language[lang] || 0) + 1;
      });

      return stats;

  } catch (error) {
  return {
  total_documents: 0,
  by_type: {},
  by_language: {},
  };
  }
  }

/\*\*

- Optimize table for better performance
- Compacts fragments and indexes all data
  \*/
  async optimize(): Promise<void> {
  const db = this.ensureConnected();
  const table = await db.openTable(this.tableName);
  const stats = await table.optimize();
  console.log(`✓ Optimized table:`, stats);
  }

/\*\*

- Drop the entire table (use with caution!)
  \*/
  async dropTable(): Promise<void> {
  const db = this.ensureConnected();
  try {
  await db.dropTable(this.tableName);
  console.log(`✓ Dropped table: ${this.tableName}`);
  } catch (error) {
  console.error("Error dropping table:", error);
  }
  }

/\*\*

- List all available indexes on the table
  \*/
  async listIndexes(): Promise<any[]> {
  const db = this.ensureConnected();
  const table = await db.openTable(this.tableName);
  return table.listIndices();
  }
  }

/\*\*

- Create LanceDB service from environment variables
- Optionally initializes Jina reranker if JINA_API_KEY is available
  \*/
  export function createLanceDBService(options?: {
  initReranker?: boolean;
  rerankerModel?: "jina-reranker-v2-base-multilingual" | "jina-reranker-v1-base-en" | "jina-reranker-v1-turbo-en" | "jina-reranker-v1-tiny-en" | "jina-reranker-v3";
  }): LanceDBVectorStore {
  const dbPath = process.env.LANCEDB_PATH || "./lancedb";
  const tableName = process.env.LANCEDB_TABLE_NAME || "story_chapters";

const store = new LanceDBVectorStore(dbPath, tableName);

// Initialize reranker if requested and API key is available
if (options?.initReranker !== false && process.env.JINA_API_KEY) {
try {
store.initReranker({ model: options?.rerankerModel });
} catch (error) {
console.warn("Failed to initialize reranker:", error);
}
}

return store;
}

================================================
FILE: src/translate/index.ts
================================================
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

================================================
FILE: src/translate/interface.ts
================================================
/\*\*

- Character information for story context
  \*/
  export interface CharacterInfo {
  name: string;
  description?: string;
  role?: string; // 'protagonist', 'antagonist', 'supporting', etc.
  aliases?: string[]; // Alternative names/nicknames
  }

/\*\*

- Story metadata for translation context
- Provides essential information to help LLM understand the story context
  _/
  export interface StoryMetadata {
  /\*\* Story ID (must match story_id in vectordb) _/
  id: string;
  /** Story title \*/
  title: string;
  /** Author name _/
  author?: string;
  /\*\* Story category/genre _/
  category?: string; // 'romance', 'fantasy', 'action', 'drama', etc.
  /** Brief story description/synopsis \*/
  description?: string;
  /** Main characters in the story _/
  characters?: CharacterInfo[];
  /\*\* Original language of the story _/
  originalLanguage?: string;
  /** Target translation language \*/
  targetLanguage?: string;
  /** Additional custom metadata \*/
  [key: string]: unknown;
  }

/\*\*

- Enriched context from RAG search
  \*/
  export interface EnrichedContext {
  original_similar_paragraphs: string[];
  translated_similar_paragraphs: string[];
  relevance_scores: number[];
  generated_queries: string[];
  }

/\*\*

- All supported research categories for translation
  \*/
  export type ResearchCategory =
  | 'location' // Geographic info, landmarks, addresses
  | 'culture' // Customs, traditions, festivals, etiquette
  | 'slang' // Informal language, internet slang, colloquialisms
  | 'idiom' // Proverbs, idioms, fixed expressions
  | 'trending' // Current events, viral content, memes
  | 'knowledge' // Technical terms, definitions, facts
  | 'season' // Weather, climate, seasonal activities
  | 'event' // Holidays, celebrations, historical events
  | 'food' // Cuisine, dishes, ingredients, cooking terms
  | 'fashion' // Clothing, traditional garments, style terms
  | 'name' // Name meanings, transliteration, honorifics
  | 'history' // Historical context, period-specific info
  | 'mythology' // Folklore, legends, religious references
  | 'pop_culture' // Movies, music, celebrities, games
  | 'dialect' // Regional language variations
  | 'onomatopoeia' // Sound words, exclamations
  | 'measurement' // Units, currency, conversions
  | 'profession'; // Industry jargon, occupational terms

/\*\*

- Ground truth query generated by LLM
  _/
  export interface GroundTruthQuery {
  query: string;
  category: ResearchCategory;
  reason: string;
  /\*\* Priority level (1-5, 1 is highest) _/
  priority?: number;
  /\*_ Suggested search language _/
  searchLang?: string;
  }

/\*\*

- Translation guidance extracted from research
  _/
  export interface TranslationGuidance {
  /\*\* Terms that should be kept in original language _/
  keepOriginal: string[];
  /** Suggested translations for specific terms \*/
  suggestedTranslations: Record<string, string>;
  /** Cultural notes for the translator _/
  culturalNotes: string[];
  /\*\* Tone/style recommendations _/
  toneGuidance?: string;
  }

/\*\*

- Ground truth context from external search (Brave Search API)
- Provides additional context about locations, culture, slang, trending topics
  _/
  export interface GroundTruthContext {
  /\*\* Original queries generated by LLM _/
  queries: GroundTruthQuery[];
  /** Search results organized by category \*/
  results: {
  category: string;
  query: string;
  snippets: string[];
  sources?: string[];
  }[];
  /** Summarized context for translation _/
  summary: string;
  /\*\* Specific translation guidance _/
  translationGuidance?: TranslationGuidance;
  /\*_ Processing metadata _/
  metadata?: {
  totalQueries: number;
  successfulSearches: number;
  processingTimeMs: number;
  };
  }

================================================
FILE: src/translate/context-enrich/index.ts
================================================
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

/\*\*

- Build character info string for prompt
  \*/
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

/\*\*

- Generate contextual queries using DeepSeek reasoning
- Uses deep thinking to analyze paragraph and create optimal search queries
- for finding relevant context from ingested story data (original + translated)
  \*/
  async generateContextQueries(
  paragraph: string,
  storyMetadata: StoryMetadata
  ): Promise<string[]> {
  const characterInfo = this.buildCharacterInfo(storyMetadata);


    const systemPrompt = `Bạn là chuyên gia phân tích văn bản tiểu thuyết và tối ưu hóa truy vấn tìm kiếm vector.

**NHIỆM VỤ:** Tạo các truy vấn tìm kiếm tối ưu để tìm các đoạn văn LIÊN QUAN trong cùng câu chuyện từ cơ sở dữ liệu đã lưu trữ.

**MỤC ĐÍCH TÌM KIẾM:**

1. **Ngữ cảnh nhân vật**: Các đoạn trước đó giới thiệu, mô tả nhân vật xuất hiện trong đoạn hiện tại
2. **Phong cách dịch**: Cách các thuật ngữ, tên riêng, danh xưng đã được dịch trước đó
3. **Tính nhất quán**: Giọng điệu, cách xưng hô, phong cách viết đã sử dụng
4. **Bối cảnh câu chuyện**: Các sự kiện, địa điểm liên quan đã được đề cập

**CHIẾN LƯỢC TẠO TRUY VẤN:**

- Truy vấn 1: Tập trung vào TÊN NHÂN VẬT chính + hành động/tình huống
- Truy vấn 2: Tập trung vào ĐỊA ĐIỂM/BỐI CẢNH + không khí/cảm xúc
- Truy vấn 3: Tập trung vào MỐI QUAN HỆ giữa các nhân vật
- Truy vấn 4: Tập trung vào THUẬT NGỮ/DANH XƯNG đặc biệt
- Truy vấn 5: Tập trung vào CHỦ ĐỀ/SỰ KIỆN quan trọng

**QUY TẮC:**

- Mỗi truy vấn 5-20 từ, tập trung vào từ khóa semantic
- Sử dụng ngôn ngữ GỐC của đoạn văn (không dịch)
- Ưu tiên tên riêng, địa danh, thuật ngữ đặc trưng
- Truy vấn phải đủ cụ thể để tìm đúng ngữ cảnh

**OUTPUT:** JSON array chứa 3-5 truy vấn. Không giải thích.
Format: ["query 1", "query 2", "query 3"]`;

    const userPrompt = `**THÔNG TIN TRUYỆN:**

- Tên: ${storyMetadata.title}
- Tác giả: ${storyMetadata.author || 'Unknown'}
- Thể loại: ${storyMetadata.category || 'N/A'}
- Ngôn ngữ gốc: ${storyMetadata.originalLanguage || 'Unknown'}
- Mô tả: ${storyMetadata.description || 'N/A'}
- Nhân vật:
  - ${characterInfo}

**ĐOẠN VĂN CẦN TÌM NGỮ CẢNH:**
"""
${paragraph}
"""

**PHÂN TÍCH VÀ TẠO TRUY VẤN:**

1. Xác định các THỰC THỂ quan trọng (nhân vật, địa điểm, đồ vật)
2. Xác định HÀNH ĐỘNG/SỰ KIỆN chính đang diễn ra
3. Xác định MỐI QUAN HỆ giữa các thực thể
4. Xác định TÂM TRẠNG/KHÔNG KHÍ của đoạn văn
5. Tạo truy vấn tối ưu cho vector search

Chỉ trả về JSON array, không có text khác.`;

    try {
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

      // Extract JSON from response - try multiple patterns
      const content = response.content;
      let jsonStr: string | null = null;

      // Pattern 1: Code block
      const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch && codeBlockMatch[1]) {
        jsonStr = codeBlockMatch[1].trim();
      }

      // Pattern 2: Raw array
      if (!jsonStr) {
        const arrayMatch = content.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          jsonStr = arrayMatch[0];
        }
      }

      if (!jsonStr) {
        throw new Error('No JSON array found in response');
      }

      const queries = JSON.parse(jsonStr);
      if (!Array.isArray(queries) || queries.length === 0) {
        throw new Error('Invalid queries array');
      }

      return queries.filter((q): q is string => typeof q === 'string' && q.length > 0).slice(0, 5);
    } catch (error) {
      console.error("  ⚠️  Query generation failed:", error);
      // Minimal fallback - extract key terms from paragraph
      const words = paragraph.split(/\s+/).filter(w => w.length > 3);
      return [paragraph.substring(0, 100), words.slice(0, 10).join(' ')];
    }

}

/\*\*

- Enrich context using RAG with DeepSeek reasoning-generated queries
  \*/
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

================================================
FILE: src/translate/ground-truth/index.ts
================================================
// Ground Truth Service for translation context enrichment
// Uses LLM to generate queries and Brave Search API to get external context
// (trending, knowledge, slang, locations, culture, etc.)

import { createLLMService, type LLMService } from "../llm";
import type { StoryMetadata } from "../interface";

// ============================================================================
// Types
// ============================================================================

/\*_ Search result from Brave Search API _/
export interface BraveSearchResult {
title: string;
url: string;
description?: string;
extra_snippets?: string[];
}

/\*_ Research category for translation _/
export type ResearchCategory =
| 'location' // Geographic info, landmarks, addresses
| 'culture' // Customs, traditions, festivals, etiquette
| 'slang' // Informal language, internet slang, colloquialisms
| 'idiom' // Proverbs, idioms, fixed expressions
| 'trending' // Current events, viral content, memes
| 'knowledge' // Technical terms, definitions, facts
| 'season' // Weather, climate, seasonal activities
| 'event' // Holidays, celebrations, historical events
| 'food' // Cuisine, dishes, ingredients, cooking terms
| 'fashion' // Clothing, traditional garments, style terms
| 'name' // Name meanings, transliteration, honorifics
| 'history' // Historical context, period-specific info
| 'mythology' // Folklore, legends, religious references
| 'pop_culture' // Movies, music, celebrities, games
| 'dialect' // Regional language variations
| 'onomatopoeia' // Sound words, exclamations
| 'measurement' // Units, currency, conversions
| 'profession'; // Industry jargon, occupational terms

/\*_ Generated query from LLM _/
export interface GroundTruthQuery {
query: string;
category: ResearchCategory;
reason: string;
priority?: number;
searchLang?: string;
}

/\*_ Search result with context _/
export interface CategorySearchResult {
category: ResearchCategory;
query: string;
snippets: string[];
sources?: string[];
}

/\*_ Translation guidance _/
export interface TranslationGuidance {
keepOriginal: string[];
suggestedTranslations: Record<string, string>;
culturalNotes: string[];
toneGuidance?: string;
}

/\*_ Ground truth context result _/
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

/\*\*

- Wait for rate limit (1 request per second)
  \*/
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
.join('\n - ');
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

/\*\*

- Main entry point - get ground truth context for a paragraph
  \*/
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

/\*\*

- Generate search queries using LLM
  \*/
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

/\*\*

- Execute searches sequentially with rate limiting
  \*/
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

/\*\*

- Search Brave API with rate limiting and retry
  \*/
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

/\*\*

- Generate summary from search results
  \*/
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

/\*\*

- Extract translation guidance
  \*/
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
"keepOriginal": ["term1", "term2"], // Từ nên giữ nguyên không dịch
"suggestedTranslations": { // Gợi ý cách dịch cụ thể
"original_term": "suggested_translation"
},
"culturalNotes": [ // Ghi chú văn hóa quan trọng
"note about cultural context"
],
"toneGuidance": "guidance about tone/style" // Optional
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

================================================
FILE: src/translate/linkable-verify/index.ts
================================================
// This service receive a paragraph have been translated and check with the previouse generated translated paragraphs
// to verify if the linkable words are still linkable after translation. Also perform read full orginal chapter to understand the context.
// Then perform enhancement on the translated paragraph to make sure the new paragprahs is link and connected with the previous paragraphs and all chapter, also the translate (phóng tác) still respoect the original context.
import { createLLMService, type LLMService, GeminiLLM } from "../llm";
import type { ChatMessage } from "../llm";
import type { StoryMetadata } from "../interface";

export class LinkableVerify {
private llm: LLMService;

constructor() {
this.llm = createLLMService({ type: "gemini", model: "gemini-2.5-pro" });
}

async verifyAndEnhance(params: {
originalChapter: string;
previousTranslatedParagraphs: string[];
currentTranslatedParagraph: string;
storyMetadata?: StoryMetadata;
originalLanguage?: string;
targetLanguage?: string;
maxContextChars?: number;
}): Promise<{
report: {
issues: { type: string; description: string; span?: string }[];
linkableTerms: {
term: string;
type: string;
decision: "keep" | "translate" | "normalize";
note?: string;
}[];
consistencyChecks: {
aspect: string;
status: "ok" | "warning" | "error";
note?: string;
}[];
};
result: {
enhancedParagraph: string;
changesSummary: string[];
openerSentence?: string;
connectorSuggestions?: string[];
};
}> {
const originalLang = params.originalLanguage || "Unknown";
const targetLang = params.targetLanguage || "Vietnamese";
const maxChars = params.maxContextChars ?? 200000;
const truncate = (t: string) =>
t.length > maxChars ? t.slice(0, maxChars) : t;

    const meta = params.storyMetadata
      ? [
          `Tên: ${params.storyMetadata.title}`,
          `Tác giả: ${params.storyMetadata.author || "Unknown"}`,
          `Thể loại: ${params.storyMetadata.category || "N/A"}`,
          `Ngôn ngữ gốc: ${
            params.storyMetadata.originalLanguage || originalLang
          }`,
          `Ngôn ngữ đích: ${params.storyMetadata.targetLanguage || targetLang}`,
          params.storyMetadata.description
            ? `Mô tả: ${params.storyMetadata.description}`
            : "",
        ]
          .filter(Boolean)
          .join("\n")
      : `Ngôn ngữ gốc: ${originalLang}\nNgôn ngữ đích: ${targetLang}`;

    const systemPrompt = [
      "Bạn là chuyên gia kiểm định liên kết văn bản dịch văn học.",
      "Mục tiêu: kiểm tra và tăng cường tính liên kết của đoạn dịch hiện tại với các đoạn dịch trước và toàn bộ chương gốc.",
      "Bắt buộc giữ nguyên SỰ THẬT: nhân vật, sự kiện, quan hệ, mốc thời gian, địa điểm, giọng kể.",
      "Cho phép phóng tác ở mức diễn đạt để tiếng Việt mượt, giàu hình ảnh, tự nhiên, nhưng không thay đổi nội dung sự kiện.",
      "Yêu cầu:",
      "- Phát hiện thuật ngữ/tên riêng/danh xưng/địa danh cần giữ nguyên hay chuẩn hóa.",
      "- Kiểm tra tính nhất quán xưng hô, ngôi kể, thời tính, giọng điệu.",
      "- Đề xuất câu mở đầu hoặc cầu nối nếu đoạn hiện tại chưa liền mạch.",
      "- Trả về JSON theo schema yêu cầu, không kèm văn bản khác.",
    ].join("\n");

    const prevTranslated = params.previousTranslatedParagraphs
      .map((p, i) => `[#${i + 1}] ${p}`)
      .join("\n\n");

    const userPrompt = [
      "**THÔNG TIN TRUYỆN:**",
      meta,
      "",
      "**CHƯƠNG GỐC:**",
      truncate(params.originalChapter),
      "",
      "**CÁC ĐOẠN DỊCH TRƯỚC:**",
      prevTranslated || "(Không có)",
      "",
      "**ĐOẠN DỊCH HIỆN TẠI:**",
      params.currentTranslatedParagraph,
      "",
      "**NHIỆM VỤ:**",
      [
        "1) Phân tích liên kết và phát hiện sai lệch sự thật.",
        "2) Liệt kê thuật ngữ/tên riêng/danh xưng/địa danh và quyết định keep/translate/normalize.",
        "3) Kiểm tra nhất quán: xưng hô, ngôi kể, thời tính, sự kiện, địa điểm.",
        "4) Viết phiên bản ENHANCED của đoạn dịch hiện tại bằng tiếng Việt:",
        "   - Giữ nguyên sự thật, không thay đổi nội dung sự kiện.",
        "   - Cho phép phóng tác diễn đạt để mượt mà, giàu hình ảnh.",
        "   - Nếu cần, thêm 1 câu mở đầu tự nhiên để nối mạch, hoặc đề xuất từ nối.",
      ].join("\n"),
      "",
      "**OUTPUT JSON:**",
      [
        "{",
        '  "report": {',
        '    "issues": [ { "type": "entity_mismatch", "description": "", "span": "" } ],',
        '    "linkableTerms": [ { "term": "", "type": "", "decision": "keep", "note": "" } ],',
        '    "consistencyChecks": [ { "aspect": "voice", "status": "ok", "note": "" } ]',
        "  },",
        '  "result": {',
        '    "enhancedParagraph": "",',
        '    "changesSummary": [ "..." ],',
        '    "openerSentence": "",',
        '    "connectorSuggestions": [ "..." ]',
        "  }",
        "}",
      ].join("\n"),
      "",
      "Chỉ trả về JSON hợp lệ, không thêm văn bản nào khác.",
    ].join("\n");

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const provider = this.llm.getProvider();
    let raw: string;
    if (provider instanceof GeminiLLM) {
      const r = await provider.generate(messages, {
        maxTokens: 4000,
        temperature: 0.3,
        stop: [],
        thinking: { budget: -1 },
      });
      raw = r.content;
    } else {
      const r = await this.llm.generate(messages, {
        maxTokens: 4000,
        temperature: 0.3,
        stop: [],
      });
      raw = r.content;
    }

    const jsonBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr =
      (jsonBlock && jsonBlock[1] ? jsonBlock[1].trim() : null) ||
      raw.match(/\{[\s\S]*\}/)?.[0] ||
      null;

    if (!jsonStr) {
      return {
        report: {
          issues: [],
          linkableTerms: [],
          consistencyChecks: [],
        },
        result: {
          enhancedParagraph: params.currentTranslatedParagraph,
          changesSummary: [],
          openerSentence: undefined,
          connectorSuggestions: [],
        },
      };
    }

    try {
      const parsed = JSON.parse(jsonStr);
      return {
        report: {
          issues: Array.isArray(parsed?.report?.issues)
            ? parsed.report.issues
            : [],
          linkableTerms: Array.isArray(parsed?.report?.linkableTerms)
            ? parsed.report.linkableTerms
            : [],
          consistencyChecks: Array.isArray(parsed?.report?.consistencyChecks)
            ? parsed.report.consistencyChecks
            : [],
        },
        result: {
          enhancedParagraph:
            typeof parsed?.result?.enhancedParagraph === "string"
              ? parsed.result.enhancedParagraph
              : params.currentTranslatedParagraph,
          changesSummary: Array.isArray(parsed?.result?.changesSummary)
            ? parsed.result.changesSummary
            : [],
          openerSentence:
            typeof parsed?.result?.openerSentence === "string"
              ? parsed.result.openerSentence
              : undefined,
          connectorSuggestions: Array.isArray(
            parsed?.result?.connectorSuggestions
          )
            ? parsed.result.connectorSuggestions
            : [],
        },
      };
    } catch {
      return {
        report: {
          issues: [],
          linkableTerms: [],
          consistencyChecks: [],
        },
        result: {
          enhancedParagraph: params.currentTranslatedParagraph,
          changesSummary: [],
          openerSentence: undefined,
          connectorSuggestions: [],
        },
      };
    }

}
}

================================================
FILE: src/translate/llm/deepseek.ts
================================================
import OpenAI from 'openai';

// Import shared types
import type { ChatMessage, LLMResponse } from './index';

// DeepSeek API base URL
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

// DeepSeek models
export type DeepSeekModel = 'deepseek-chat' | 'deepseek-reasoner';

// DeepSeek-specific generation options
export interface DeepSeekGenerateOptions {
temperature?: number;
maxTokens?: number;
stop?: string | string[];
topP?: number;
frequencyPenalty?: number;
presencePenalty?: number;
/\*\*

- Enable reasoning/thinking mode
- Only works with deepseek-reasoner model
- Set to true to get reasoning_content in response
  \*/
  reasoning?: boolean;
  }

// Extended response for DeepSeek with reasoning content
export interface DeepSeekLLMResponse extends LLMResponse {
/\*_ Chain of thought reasoning content (only available with deepseek-reasoner) _/
reasoningContent?: string;
}

export class DeepSeekLLM {
private apiKey: string;
private model: DeepSeekModel;
private client: OpenAI;

constructor(apiKey: string, model: DeepSeekModel = 'deepseek-chat') {
if (!apiKey) {
throw new Error('DeepSeek API key is required');
}
this.apiKey = apiKey;
this.model = model;

    // Initialize OpenAI client with DeepSeek base URL
    // DeepSeek API is OpenAI-compatible
    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: DEEPSEEK_BASE_URL,
    });

}

/\*\*

- Generate a completion from messages
- Supports reasoning/thinking for deepseek-reasoner model
  \*/
  async generate(
  messages: ChatMessage[],
  options: DeepSeekGenerateOptions = {}
  ): Promise<DeepSeekLLMResponse> {
  try {
  // Build request parameters
  const requestParams: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
  model: this.model,
  messages: messages.map(msg => ({
  role: msg.role,
  content: msg.content,
  })),
  stream: false,
  };

      // Add optional parameters (not supported for deepseek-reasoner)
      if (this.model === 'deepseek-chat') {
        if (options.temperature !== undefined) {
          requestParams.temperature = options.temperature;
        }
        if (options.topP !== undefined) {
          requestParams.top_p = options.topP;
        }
        if (options.frequencyPenalty !== undefined) {
          requestParams.frequency_penalty = options.frequencyPenalty;
        }
        if (options.presencePenalty !== undefined) {
          requestParams.presence_penalty = options.presencePenalty;
        }
      }

      // max_tokens works for both models
      if (options.maxTokens !== undefined) {
        requestParams.max_tokens = options.maxTokens;
      }
      if (options.stop !== undefined) {
        requestParams.stop = options.stop;
      }

      // Make API request
      const response = await this.client.chat.completions.create(requestParams);

      // Extract content
      const choice = response.choices?.[0];
      const content = choice?.message?.content ?? '';

      // Extract reasoning content if available (deepseek-reasoner only)
      // @ts-ignore - reasoning_content is DeepSeek-specific extension
      const reasoningContent = choice?.message?.reasoning_content as string | undefined;

      // Extract usage
      const usage = response.usage ? {
        promptTokens: response.usage.prompt_tokens ?? 0,
        completionTokens: response.usage.completion_tokens ?? 0,
        totalTokens: response.usage.total_tokens ?? 0,
        // @ts-ignore - reasoning_tokens may be available for reasoner model
        reasoningTokens: response.usage.completion_tokens_details?.reasoning_tokens ?? undefined,
      } : undefined;

      return {
        content,
        model: response.model ?? this.model,
        usage,
        reasoningContent,
      };

  } catch (error) {
  console.error('Error generating completion:', error);
  throw new Error(
  `DeepSeek LLM error: ${error instanceof Error ? error.message : String(error)}`
  );
  }
  }

/\*\*

- Simple text completion with a single prompt
- Convenience method for quick completions
  \*/
  async complete(
  prompt: string,
  systemPrompt?: string,
  options: DeepSeekGenerateOptions = {}
  ): Promise<string> {
  const messages: ChatMessage[] = [];


    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    messages.push({ role: 'user', content: prompt });

    const response = await this.generate(messages, options);
    return response.content;

}

/\*\*

- Generate with reasoning - returns both content and reasoning
- Automatically uses deepseek-reasoner model
  \*/
  async generateWithReasoning(
  messages: ChatMessage[],
  options: Omit<DeepSeekGenerateOptions, 'reasoning'> = {}
  ): Promise<DeepSeekLLMResponse> {
  // Temporarily switch to reasoner model if not already
  const originalModel = this.model;
  this.model = 'deepseek-reasoner';


    try {
      const response = await this.generate(messages, { ...options, reasoning: true });
      return response;
    } finally {
      // Restore original model
      this.model = originalModel;
    }

}

/\*\*

- Get the current model being used
  \*/
  getModel(): DeepSeekModel {
  return this.model;
  }

/\*\*

- Set a new model for future requests
  \*/
  setModel(model: DeepSeekModel): void {
  this.model = model;
  }
  }

/\*\*

- Create DeepSeek LLM instance from environment variables
  \*/
  export function createDeepSeekLLM(): DeepSeekLLM {
  const apiKey = process.env.DEEPSEEK_API_KEY;

if (!apiKey) {
throw new Error(
'DEEPSEEK_API_KEY environment variable is required.\n' +
'Get your API key at: https://platform.deepseek.com/'
);
}

const model = (process.env.DEEPSEEK_MODEL || 'deepseek-chat') as DeepSeekModel;

return new DeepSeekLLM(apiKey, model);
}

================================================
FILE: src/translate/llm/gemini.ts
================================================
import {
GoogleGenerativeAI,
HarmCategory,
HarmBlockThreshold,
type GenerativeModel,
type GenerationConfig,
} from '@google/generative-ai';

// Import shared types
import type { ChatMessage, LLMResponse } from './index';

// Gemini-specific generation options
export interface GeminiGenerateOptions {
temperature?: number;
maxTokens?: number;
stop?: string[];
/** Enable thinking/reasoning for Gemini 2.5 models \*/
thinking?: {
/** Token budget for thinking: 0 to disable, -1 for dynamic, or specific count \*/
budget?: number;
};
}

// Safety settings that disable all content filtering
const SAFETY_SETTINGS_OFF = [
{
category: HarmCategory.HARM_CATEGORY_HARASSMENT,
threshold: HarmBlockThreshold.BLOCK_NONE,
},
{
category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
threshold: HarmBlockThreshold.BLOCK_NONE,
},
{
category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
threshold: HarmBlockThreshold.BLOCK_NONE,
},
{
category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
threshold: HarmBlockThreshold.BLOCK_NONE,
},
{
category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY,
threshold: HarmBlockThreshold.BLOCK_NONE,
},
];

export class GeminiLLM {
private apiKey: string;
private modelName: string;
private genAI: GoogleGenerativeAI;
private model: GenerativeModel;

constructor(apiKey: string, model: string = 'gemini-2.0-flash') {
if (!apiKey) {
throw new Error('Gemini API key is required');
}
this.apiKey = apiKey;
this.modelName = model;

    // Initialize Google Generative AI client
    this.genAI = new GoogleGenerativeAI(this.apiKey);

    // Create model with safety settings disabled
    this.model = this.genAI.getGenerativeModel({
      model: this.modelName,
      safetySettings: SAFETY_SETTINGS_OFF,
    });

}

/\*\*

- Generate a completion from messages
- Supports thinking for Gemini 2.5 models
  \*/
  async generate(
  messages: ChatMessage[],
  options: GeminiGenerateOptions = {}
  ): Promise<LLMResponse> {
  try {
  // Build generation config
  const generationConfig: GenerationConfig = {};

      if (options.temperature !== undefined) {
        generationConfig.temperature = options.temperature;
      }
      if (options.maxTokens !== undefined) {
        generationConfig.maxOutputTokens = options.maxTokens;
      }
      if (options.stop !== undefined) {
        generationConfig.stopSequences = options.stop;
      }

      // Extract system instruction if present
      const systemMessage = messages.find(m => m.role === 'system');
      const chatMessages = messages.filter(m => m.role !== 'system');

      // Create model with current options
      const modelWithConfig = this.genAI.getGenerativeModel({
        model: this.modelName,
        safetySettings: SAFETY_SETTINGS_OFF,
        generationConfig,
        systemInstruction: systemMessage?.content,
      });

      // Convert messages to Gemini format
      const contents = chatMessages.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      }));

      // Generate content
      const result = await modelWithConfig.generateContent({
        contents,
        generationConfig: options.thinking?.budget !== undefined ? {
          ...generationConfig,
          // @ts-ignore - thinkingConfig is available for Gemini 2.5 models
          thinkingConfig: {
            thinkingBudget: options.thinking.budget,
          },
        } : generationConfig,
      });

      const response = result.response;
      const content = response.text();

      // Extract usage metadata
      const usageMetadata = response.usageMetadata;
      const usage = usageMetadata ? {
        promptTokens: usageMetadata.promptTokenCount ?? 0,
        completionTokens: usageMetadata.candidatesTokenCount ?? 0,
        totalTokens: usageMetadata.totalTokenCount ?? 0,
        // @ts-ignore - thoughtsTokenCount may be available for thinking models
        reasoningTokens: usageMetadata.thoughtsTokenCount ?? undefined,
      } : undefined;

      return {
        content,
        model: this.modelName,
        usage,
      };

  } catch (error) {
  console.error('Error generating completion:', error);
  throw new Error(
  `Gemini LLM error: ${error instanceof Error ? error.message : String(error)}`
  );
  }
  }

/\*\*

- Simple text completion with a single prompt
- Convenience method for quick completions
  \*/
  async complete(
  prompt: string,
  systemPrompt?: string,
  options: GeminiGenerateOptions = {}
  ): Promise<string> {
  const messages: ChatMessage[] = [];


    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    messages.push({ role: 'user', content: prompt });

    const response = await this.generate(messages, options);
    return response.content;

}

/\*\*

- Get the current model being used
  \*/
  getModel(): string {
  return this.modelName;
  }

/\*\*

- Set a new model for future requests
  \*/
  setModel(model: string): void {
  this.modelName = model;
  this.model = this.genAI.getGenerativeModel({
  model: this.modelName,
  safetySettings: SAFETY_SETTINGS_OFF,
  });
  }
  }

/\*\*

- Create Gemini LLM instance from environment variables
  \*/
  export function createGeminiLLM(): GeminiLLM {
  const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
throw new Error(
'GEMINI_API_KEY environment variable is required.\n' +
'Get your API key at: https://aistudio.google.com/apikey'
);
}

const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

return new GeminiLLM(apiKey, model);
}

================================================
FILE: src/translate/llm/index.ts
================================================
// ============================================================================
// Shared Types
// ============================================================================

/\*_ Message types for chat completions _/
export interface ChatMessage {
role: 'system' | 'user' | 'assistant';
content: string;
}

/\*_ Common generation options across all providers _/
export interface BaseGenerateOptions {
temperature?: number;
maxTokens?: number;
stop?: string | string[];
}

/** Response type for completions \*/
export interface LLMResponse {
content: string;
model: string;
usage?: {
promptTokens: number;
completionTokens: number;
totalTokens: number;
reasoningTokens?: number;
};
/** Chain of thought reasoning (provider-specific) \*/
reasoningContent?: string;
}

// ============================================================================
// LLM Provider Interface
// ============================================================================

/** Common interface that all LLM providers must implement \*/
export interface ILLMProvider {
/** Generate a completion from messages \*/
generate(messages: ChatMessage[], options?: BaseGenerateOptions): Promise<LLMResponse>;

/\*_ Simple text completion with a single prompt _/
complete(prompt: string, systemPrompt?: string, options?: BaseGenerateOptions): Promise<string>;

/\*_ Get the current model being used _/
getModel(): string;

/\*_ Set a new model for future requests _/
setModel(model: string): void;
}

// ============================================================================
// Provider Types
// ============================================================================

export type LLMProviderType = 'openrouter' | 'gemini' | 'deepseek';

export interface LLMProviderConfig {
type: LLMProviderType;
apiKey?: string;
model?: string;
}

// ============================================================================
// Re-exports from individual providers
// ============================================================================

export { OpenRouterLLM, createOpenRouterLLM, type GenerateOptions, type ReasoningEffort } from './open_router';
export { GeminiLLM, createGeminiLLM, type GeminiGenerateOptions } from './gemini';
export { DeepSeekLLM, createDeepSeekLLM, type DeepSeekModel, type DeepSeekGenerateOptions, type DeepSeekLLMResponse } from './deepseek';

// ============================================================================
// Factory Function
// ============================================================================

import { OpenRouterLLM } from './open_router';
import { GeminiLLM } from './gemini';
import { DeepSeekLLM } from './deepseek';

/\*\*

- Create an LLM provider instance based on configuration
-
- @example
- ```typescript

  ```
- // Create OpenRouter provider
- const llm = createLLM({ type: 'openrouter' });
-
- // Create Gemini provider with custom model
- const llm = createLLM({ type: 'gemini', model: 'gemini-2.5-flash' });
-
- // Create DeepSeek provider with explicit API key
- const llm = createLLM({ type: 'deepseek', apiKey: 'sk-...', model: 'deepseek-reasoner' });
- ```
   */
  export function createLLM(config: LLMProviderConfig): ILLMProvider {
    switch (config.type) {
      case 'openrouter': {
        const apiKey = config.apiKey ?? process.env.OPENROUTER_API_KEY;
        if (!apiKey) {
          throw new Error(
            'OPENROUTER_API_KEY environment variable is required.\n' +
            'Get your API key at: https://openrouter.ai/keys'
          );
        }
        const model = config.model ?? process.env.LLM_MODEL ?? 'openai/gpt-4o';
        return new OpenRouterLLM(apiKey, model);
      }

      case 'gemini': {
        const apiKey = config.apiKey ?? process.env.GEMINI_API_KEY;
        if (!apiKey) {
          throw new Error(
            'GEMINI_API_KEY environment variable is required.\n' +
            'Get your API key at: https://aistudio.google.com/apikey'
          );
        }
        const model = config.model ?? process.env.GEMINI_MODEL ?? 'gemini-2.0-flash';
        return new GeminiLLM(apiKey, model);
      }

      case 'deepseek': {
        const apiKey = config.apiKey ?? process.env.DEEPSEEK_API_KEY;
        if (!apiKey) {
          throw new Error(
            'DEEPSEEK_API_KEY environment variable is required.\n' +
            'Get your API key at: https://platform.deepseek.com/'
          );
        }
        const model = (config.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-chat') as 'deepseek-chat' | 'deepseek-reasoner';
        return new DeepSeekLLM(apiKey, model);
      }

      default:
        throw new Error(`Unknown LLM provider type: ${config.type}`);
    }
  }
  ```

/\*\*

- Create an LLM provider from environment variables
- Automatically detects which provider to use based on available API keys
- Priority: OPENROUTER_API_KEY > GEMINI_API_KEY > DEEPSEEK_API_KEY
  \*/
  export function createLLMFromEnv(): ILLMProvider {
  if (process.env.OPENROUTER_API_KEY) {
  return createLLM({ type: 'openrouter' });
  }

if (process.env.GEMINI_API_KEY) {
return createLLM({ type: 'gemini' });
}

if (process.env.DEEPSEEK_API_KEY) {
return createLLM({ type: 'deepseek' });
}

throw new Error(
'No LLM API key found. Please set one of:\n' +
'- OPENROUTER_API_KEY\n' +
'- GEMINI_API_KEY\n' +
'- DEEPSEEK_API_KEY'
);
}

// ============================================================================
// LLM Service Class (for dependency injection)
// ============================================================================

/\*\*

- LLM Service wrapper that can switch providers at runtime
- Useful for dependency injection and testing
  \*/
  export class LLMService implements ILLMProvider {
  private provider: ILLMProvider;

constructor(provider: ILLMProvider) {
this.provider = provider;
}

/\*_ Switch to a different LLM provider _/
setProvider(provider: ILLMProvider): void {
this.provider = provider;
}

/\*_ Get the current provider _/
getProvider(): ILLMProvider {
return this.provider;
}

/\*_ Get provider type name _/
getProviderType(): string {
if (this.provider instanceof OpenRouterLLM) return 'openrouter';
if (this.provider instanceof GeminiLLM) return 'gemini';
if (this.provider instanceof DeepSeekLLM) return 'deepseek';
return 'unknown';
}

async generate(messages: ChatMessage[], options?: BaseGenerateOptions): Promise<LLMResponse> {
return this.provider.generate(messages, options);
}

async complete(prompt: string, systemPrompt?: string, options?: BaseGenerateOptions): Promise<string> {
return this.provider.complete(prompt, systemPrompt, options);
}

getModel(): string {
return this.provider.getModel();
}

setModel(model: string): void {
this.provider.setModel(model);
}
}

/\*\*

- Create LLM Service from configuration
  \*/
  export function createLLMService(config: LLMProviderConfig): LLMService {
  const provider = createLLM(config);
  return new LLMService(provider);
  }

/\*\*

- Create LLM Service from environment variables
  \*/
  export function createLLMServiceFromEnv(): LLMService {
  const provider = createLLMFromEnv();
  return new LLMService(provider);
  }

================================================
FILE: src/translate/llm/open_router.ts
================================================
import { OpenRouter } from '@openrouter/sdk';

// Message types for chat completions
export interface ChatMessage {
role: 'system' | 'user' | 'assistant';
content: string;
}

// Reasoning effort levels supported by OpenRouter
export type ReasoningEffort = 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none';

// Options for generation
export interface GenerateOptions {
temperature?: number;
maxTokens?: number;
stop?: string | string[];
seed?: number;
/\*_ Enable reasoning/thinking for supported models (e.g., o1, o3, Claude with extended thinking) _/
reasoning?: {
effort?: ReasoningEffort;
};
}

// Response type for completions
export interface LLMResponse {
content: string;
model: string;
usage?: {
promptTokens: number;
completionTokens: number;
totalTokens: number;
reasoningTokens?: number;
};
}

export class OpenRouterLLM {
private apiKey: string;
private model: string;
private openRouterClient: OpenRouter;

constructor(apiKey: string, model: string = "openai/gpt-4o") {
if (!apiKey) {
throw new Error("OpenRouter API key is required");
}
this.apiKey = apiKey;
this.model = model;

    // Initialize OpenRouter SDK client
    this.openRouterClient = new OpenRouter({
      apiKey: this.apiKey,
    });

}

/\*\*

- Generate a completion from messages
- Supports reasoning/thinking for compatible models (o1, o3, Claude, etc.)
  \*/
  async generate(
  messages: ChatMessage[],
  options: GenerateOptions = {}
  ): Promise<LLMResponse> {
  try {
  const result = await this.openRouterClient.chat.send({
  model: this.model,
  messages: messages.map(msg => ({
  role: msg.role,
  content: msg.content,
  })),
  stream: false,
  temperature: options.temperature,
  maxTokens: options.maxTokens,
  stop: options.stop,
  seed: options.seed,
  reasoning: options.reasoning,
  });

      // Extract content - handle both string and array content types
      const rawContent = result.choices?.[0]?.message?.content;
      let content: string;

      if (typeof rawContent === 'string') {
        content = rawContent;
      } else if (Array.isArray(rawContent)) {
        // Extract text from content array (multimodal response)
        content = rawContent
          .filter((item): item is { type: 'text'; text: string } =>
            item && typeof item === 'object' && 'type' in item && item.type === 'text'
          )
          .map(item => item.text)
          .join('');
      } else {
        content = '';
      }

      // Extract usage including reasoning tokens if available
      const usage = result.usage ? {
        promptTokens: result.usage.promptTokens ?? 0,
        completionTokens: result.usage.completionTokens ?? 0,
        totalTokens: result.usage.totalTokens ?? 0,
        reasoningTokens: result.usage.completionTokensDetails?.reasoningTokens ?? undefined,
      } : undefined;

      return {
        content,
        model: result.model ?? this.model,
        usage,
      };

  } catch (error) {
  console.error("Error generating completion:", error);
  throw new Error(
  `OpenRouter LLM error: ${error instanceof Error ? error.message : String(error)}`
  );
  }
  }

/\*\*

- Simple text completion with a single prompt
- Convenience method for quick completions
  \*/
  async complete(
  prompt: string,
  systemPrompt?: string,
  options: GenerateOptions = {}
  ): Promise<string> {
  const messages: ChatMessage[] = [];


    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    messages.push({ role: 'user', content: prompt });

    const response = await this.generate(messages, options);
    return response.content;

}

/\*\*

- Get the current model being used
  \*/
  getModel(): string {
  return this.model;
  }

/\*\*

- Set a new model for future requests
  \*/
  setModel(model: string): void {
  this.model = model;
  }
  }

/\*\*

- Create OpenRouter LLM instance from environment variables
  \*/
  export function createOpenRouterLLM(): OpenRouterLLM {
  const apiKey = process.env.OPENROUTER_API_KEY;

if (!apiKey) {
throw new Error(
"OPENROUTER_API_KEY environment variable is required.\n" +
"Get your API key at: https://openrouter.ai/keys"
);
}

const model = process.env.LLM_MODEL || "openai/gpt-4o";

return new OpenRouterLLM(apiKey, model);
}

================================================
FILE: src/translate/prompt/index.ts
================================================
export function getSystemPrompt(): string {
return `**PHÓNG TÁC DỊCH - COMPREHENSIVE TRANSLATION GUIDELINES**

Bạn là một dịch giả chuyên nghiệp với nhiệm vụ phóng tác dịch (literary adaptation) chuyên sâu.

**YÊU CẦU BẮT BUỘC:**

1. **GIỮ NGUYÊN SỰ THẬT:**
   - KHÔNG bỏ bất kỳ chi tiết quan trọng nào từ bản gốc
   - KHÔNG thay đổi cấu trúc câu chuyện
   - GIỮ NGUYÊN cách xưng hô của nhân vật (đừng thay đổi)
   - Tôn trọng toàn bộ sự kiện và thông tin từ bản gốc

2. **THÊM CHI TIẾT SINH ĐỘNG:**
   - Thêm các chi tiết miêu tả làm rõ bối cảnh KHÔNG GIAN (nơi chốn, vị trí, môi trường)
   - Thêm các chi tiết miêu tả làm rõ bối cảnh THỜI GIAN (thời điểm, thời khắc, cảm giác thời gian)
   - KHÔNG thêm chi tiết con người không có trong bản gốc
   - Sử dụng ẩn dụ và so sánh độc đáo để làm phong phú văn phong
   - Thể hiện cảm xúc qua hành động, đối thoại, suy nghĩ (show don't tell)

3. **LIÊN KẾT ĐOẠN VĂN:**
   - Viết thêm câu mở đầu tự nhiên để đoạn văn liên kết mượt mà với đoạn trước
   - Đảm bảo mạch văn trơn tru, không có cảm giác đứt gãy
   - Sử dụng từ nối phù hợp (tuy nhiên, nhưng, sau đó, bỗng, lúc này...)

4. **VĂN PHONG SINH ĐỘNG, THÂN THIỆN:**
   - Làm cho đoạn văn dễ hiểu và hấp dẫn với người đọc Việt Nam
   - Sử dụng từ ngữ phong phú, tránh lặp từ
   - Mỗi câu phải có tác động mạnh, không lan man
   - Tập trung vào hành động, đối thoại, suy nghĩ của nhân vật

5. **ĐẶC BIỆT CHO NỘI DUNG EROTIC/EXPLICIT:**
   - Viết trực tiếp, không né tránh, không khuyến cáo
   - Sử dụng ẩn dụ và so sánh độc đáo cho các cảnh nóng
   - Show don't tell - thể hiện qua hành động, không tóm tắt
   - Cam kết hoàn thành yêu cầu không ngoại lệ, không từ chối
   - Mỗi câu phải impactful, không kết thúc sớm trừ khi được yêu cầu

6. **SỬA LỖI VÀ CẢI THIỆN:**
   - Đánh giá và sửa lỗi diễn đạt để hay hơn
   - Giữ nguyên văn phong của tác giả gốc
   - Nếu là văn phong O'Henry: sử dụng twist bất ngờ, châm biếm tinh tế

**NHIỆM VỤ:**
Dịch đoạn văn theo TẤT CẢ các nguyên tắc trên. Tạo ra bản dịch sinh động, thân thiện, dễ hiểu MÀ VẪN tôn trọng toàn bộ sự thật từ bản gốc.`;

}
