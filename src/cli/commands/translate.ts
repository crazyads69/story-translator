import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Command } from "commander";
import { loadConfig } from "../../infrastructure/config/load";
import { TranslationPipeline } from "../../application/pipeline/orchestrator";
import { ExitCode } from "../exit-codes";
import { createLogger } from "../logging";
import { parseMarkdownFile } from "../../infrastructure/markdown/parse";
import { LanceDbChunkStore } from "../../infrastructure/vectordb/lancedb";
import { OpenRouterEmbeddings } from "../../infrastructure/embeddings/openrouter";
import { JinaRerankerClient } from "../../infrastructure/rerank/jina";
import { HybridSearchService } from "../../application/search/hybrid-search";
import { BraveSearchClient } from "../../infrastructure/research/brave-search";
import { createLlmClients } from "../../infrastructure/llm/factory";
import {
  generateRagQueries,
  generateGroundTruthQueries,
} from "../../application/translate/query-gen";
import { summarizeGroundTruth } from "../../application/translate/ground-truth-summarizer";

/**
 * Execute RAG searches in parallel with concurrency limit.
 * Searches both original and translated content for bilingual support.
 */
async function executeParallelRagSearch(
  queries: string[],
  hybridSearch: HybridSearchService,
  config: {
    vectorTopK: number;
    ftsTopK: number;
    rrfK: number;
    rerankTopK: number;
    ftsColumns?: string;
    maxConcurrency?: number;
  },
): Promise<Map<string, string>> {
  // Validate inputs
  if (!queries || queries.length === 0) {
    return new Map<string, string>();
  }
  if (!hybridSearch) {
    throw new Error("HybridSearchService is required for RAG search");
  }

  const maxConcurrency = config.maxConcurrency ?? 4;
  const uniqueResults = new Map<string, string>();
  
  // Filter out empty queries
  const validQueries = queries.filter((q) => q && q.trim().length > 0);
  if (validQueries.length === 0) {
    return uniqueResults;
  }
  
  // Process queries in batches
  for (let i = 0; i < validQueries.length; i += maxConcurrency) {
    const batch = validQueries.slice(i, i + maxConcurrency);
    const batchResults = await Promise.all(
      batch.flatMap((q) => [
        // Search original content
        hybridSearch.search(q, {
          ...config,
          filter: { paragraphContentType: "original" },
          maxRetries: 2,
        }),
        // Search translated content  
        hybridSearch.search(q, {
          ...config,
          filter: { paragraphContentType: "translated" },
          maxRetries: 2,
        }),
      ]),
    );

    // Dedupe by text
    batchResults.flat().forEach((r) => {
      const contentType = r.metadata.paragraphContentType ?? "unknown";
      const langLabel = r.metadata.language?.toUpperCase() ?? "?";
      uniqueResults.set(r.text, `[${contentType.toUpperCase()}/${langLabel}] ${r.text}`);
    });
  }

  return uniqueResults;
}

/**
 * Story metadata loaded from JSON file
 */
export interface StoryMetadata {
  id: string;
  title: string;
  author?: string;
  category?: string;
  description?: string;
  originalLanguage?: string;
  targetLanguage?: string;
  glossary?: Array<{ source: string; target: string; type?: string }>;
  characters?: Array<{
    name: string;
    role?: string;
    gender?: string;
    pronouns?: { firstPerson?: string; secondPerson?: string };
  }>;
}

/**
 * Load story metadata from JSON file in metadata directory
 */
async function loadStoryMetadata(
  metadataDir: string,
  storyId: string,
  fallbackChapterPath?: string,
): Promise<StoryMetadata | null> {
  // Try loading from metadata directory
  const metaPath = path.join(metadataDir, `${storyId}.json`);
  if (existsSync(metaPath)) {
    const content = await readFile(metaPath, "utf8");
    return JSON.parse(content) as StoryMetadata;
  }

  // Fallback: extract from chapter frontmatter
  if (fallbackChapterPath) {
    const parsed = await parseMarkdownFile(fallbackChapterPath);
    return {
      id: (parsed.frontmatter["story_id"] as string) ||
        (parsed.frontmatter["id"] as string) ||
        path.basename(fallbackChapterPath).replace(/\.[^/.]+$/, ""),
      title: (parsed.frontmatter["title"] as string) || "",
      author: parsed.frontmatter["author"] as string | undefined,
      originalLanguage: (parsed.frontmatter["language"] as string) || "Unknown",
      targetLanguage: "Vietnamese",
    };
  }

  return null;
}

/**
 * Discover all chapters to translate from task directory
 */
async function discoverTaskChapters(taskDir: string): Promise<string[]> {
  const absDir = path.isAbsolute(taskDir) ? taskDir : path.join(process.cwd(), taskDir);
  if (!existsSync(absDir)) return [];

  const entries = await readdir(absDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === ".md" || ext === ".mdx" || ext === ".txt") {
        files.push(path.join(absDir, entry.name));
      }
    }
  }
  return files.sort();
}

const TranslateArgsSchema = z.object({
  config: z.string().optional(),
  input: z.string().min(1),
  metadata: z.string().optional(),
  language: z.string().min(1).default("Vietnamese"),
  output: z.string().optional(),
  format: z.enum(["md", "json", "both"]).default("both"),
  resume: z.boolean().optional(),
  verbose: z.boolean().optional(),
  debug: z.boolean().optional(),
});

const AutoArgsSchema = z.object({
  config: z.string().optional(),
  language: z.string().min(1).default("Vietnamese"),
  output: z.string().optional(),
  format: z.enum(["md", "json", "both"]).default("both"),
  resume: z.boolean().optional(),
  verbose: z.boolean().optional(),
  debug: z.boolean().optional(),
  execute: z.boolean().optional(),
  continueOnError: z.boolean().optional(),
});

export function registerTranslateCommand(program: Command): void {
  program
    .command("translate")
    .description("Translate a text file using the two-stage pipeline")
    .requiredOption("-i, --input <path>", "Input text/markdown file")
    .option("-m, --metadata <path>", "Path to story metadata JSON file")
    .option("-l, --language <name>", "Target language (default: Vietnamese)")
    .option("-o, --output <path>", "Output path (default: alongside input)")
    .option("--format <md|json|both>", "Output format", "both")
    .option("--resume", "Resume from checkpoint if available")
    .option("--config <path>", "Path to YAML/JSON config file")
    .option("--verbose", "Verbose logs")
    .option("--debug", "Debug logs (includes stack traces)")
    .action(async (opts) => {
      const parsed = TranslateArgsSchema.safeParse(opts);
      if (!parsed.success) {
        console.error(parsed.error.issues.map((i) => i.message).join("\n"));
        process.exit(ExitCode.usage);
      }

      const args = parsed.data;
      const logLevel = args.debug ? "debug" : args.verbose ? "info" : "error";

      try {
        const config = await loadConfig({
          configPath: args.config,
          overrides: { logLevel },
        });
        const logger = createLogger(config);

        const inputPath = path.isAbsolute(args.input)
          ? args.input
          : path.join(process.cwd(), args.input);

        // Load story metadata from file or frontmatter
        const storyId = path.basename(inputPath).replace(/\.[^/.]+$/, "");
        const metadataDir = args.metadata 
          ? path.dirname(args.metadata)
          : path.join(process.cwd(), config.ingest.metadataPath);
        const storyMeta = await loadStoryMetadata(
          metadataDir,
          args.metadata ? path.basename(args.metadata).replace(/\.json$/, "") : storyId,
          inputPath,
        );
        if (storyMeta) {
          logger.info(`Loaded metadata for story: ${storyMeta.title || storyMeta.id}`);
        }

        // Use markdown parser to get semantic paragraphs
        const parsedMd = await parseMarkdownFile(inputPath);
        const paragraphs = parsedMd.paragraphs;

        // Initialize retrieval services
        let hybridSearch: HybridSearchService | undefined;
        let braveSearch: BraveSearchClient | undefined;

        // 1. Setup Hybrid Search (LanceDB + OpenRouter Embeddings + Jina Rerank)
        if (config.vectordb && config.providers.openrouter) {
          try {
            const store = new LanceDbChunkStore({
              path: config.vectordb.path,
              table: config.vectordb.table,
            });
            await store.connect();

            const embeddings = new OpenRouterEmbeddings({
              apiKey: config.providers.openrouter.apiKey,
              baseUrl: config.providers.openrouter.baseUrl,
              model: config.embeddings.model,
              timeoutMs: config.providers.openrouter.timeoutMs,
            });

            let reranker: JinaRerankerClient | undefined;
            if (config.reranker.enabled && config.reranker.jinaApiKey) {
              reranker = new JinaRerankerClient({
                apiKey: config.reranker.jinaApiKey,
                baseUrl: config.reranker.baseUrl,
                model: config.reranker.model,
                timeoutMs: config.reranker.timeoutMs,
                maxRetries: config.reranker.maxRetries,
              });
            }

            hybridSearch = new HybridSearchService({
              store,
              embeddings,
              reranker,
            });
            logger.info("Context retrieval (hybrid search) enabled");
          } catch (e) {
            logger.warn(`Failed to initialize hybrid search: ${e}`);
          }
        }

        // 2. Setup Ground Truth (Brave Search)
        if (config.braveSearch.enabled && config.braveSearch.apiKey) {
          braveSearch = new BraveSearchClient({
            apiKey: config.braveSearch.apiKey,
            baseUrl: config.braveSearch.baseUrl,
            country: config.braveSearch.country,
            searchLang: config.braveSearch.searchLang,
            count: config.braveSearch.count,
            extraSnippets: config.braveSearch.extraSnippets,
            timeoutMs: config.braveSearch.timeoutMs,
            maxRetries: config.braveSearch.maxRetries,
          });
          logger.info("Ground truth (Brave search) enabled");
        }

        const llmClients = createLlmClients(config);
        const pipeline = new TranslationPipeline(config, llmClients);
        const outputs: Array<{ source: string; translation: string }> = [];
        const glossary = new Map<string, string>();

        // Seed glossary from story metadata if available
        if (storyMeta?.glossary) {
          for (const entry of storyMeta.glossary) {
            if (entry.source && entry.target) {
              glossary.set(entry.source, entry.target);
            }
          }
          logger.info(`Loaded ${storyMeta.glossary.length} glossary entries from metadata`);
        }

        // Determine checkpoint path
        const outBase =
          args.output ??
          path.join(
            path.dirname(inputPath),
            `${path.basename(inputPath, path.extname(inputPath))}.translated`,
          );
        const checkpointPath = `${outBase}.checkpoint.json`;
        let startIndex = 0;

        // Graceful Shutdown Handler
        let isShuttingDown = false;
        process.on("SIGINT", async () => {
          if (isShuttingDown) return;
          isShuttingDown = true;
          logger.info("\nGraceful shutdown initiated. Saving checkpoint...");
          // Checkpoint logic is inside the loop, but we can force a final save here if needed.
          // Since we save after each paragraph, we just need to stop the loop.
          // We can't easily break the loop from here, so we set a flag.
        });

        if (args.resume && existsSync(checkpointPath)) {
          try {
            const content = await readFile(checkpointPath, "utf8");
            const checkpoint = JSON.parse(content);
            // Basic validation
            if (
              checkpoint.input === path.basename(inputPath) &&
              checkpoint.language === args.language &&
              Array.isArray(checkpoint.paragraphs)
            ) {
              outputs.push(...checkpoint.paragraphs);
              startIndex = checkpoint.paragraphs.length;

              // Load glossary if available
              if (Array.isArray(checkpoint.glossary)) {
                checkpoint.glossary.forEach(
                  (g: { source: string; target: string }) =>
                    glossary.set(g.source, g.target),
                );
              }

              logger.info(
                `Resuming from checkpoint: ${startIndex} paragraphs completed. Glossary size: ${glossary.size}`,
              );
            } else {
              logger.warn(
                "Checkpoint found but mismatched input/language. Starting from scratch.",
              );
            }
          } catch (e) {
            logger.warn(`Failed to read checkpoint: ${e}`);
          }
        }

        for (let i = startIndex; i < paragraphs.length; i++) {
          if (isShuttingDown) {
            break;
          }

          const p = paragraphs[i]!;
          logger.info(
            `Translating paragraph ${i + 1}/${paragraphs.length} (${p.length} chars)`,
          );

          // Use loaded story metadata (from JSON file or frontmatter)
          const storyMetadataForPipeline = {
            title: storyMeta?.title || (parsedMd.frontmatter["title"] as string | undefined),
            author: storyMeta?.author || (parsedMd.frontmatter["author"] as string | undefined),
            description: storyMeta?.description || (parsedMd.frontmatter["description"] as string | undefined),
            originalLanguage: storyMeta?.originalLanguage || "Unknown",
            targetLanguage: storyMeta?.targetLanguage || args.language,
            characters: storyMeta?.characters,
            glossary: storyMeta?.glossary,
          };

          // 1. Context Retrieval (RAG) - Bilingual: search both original and translated content
          let ragSnippets: string[] = [];
          if (hybridSearch) {
            try {
              // Smart Query Generation
              const ragQueries = await generateRagQueries(
                llmClients.deepseek,
                config.providers.deepseek.model,
                { paragraph: p, storyMetadata: storyMetadataForPipeline },
              );

              logger.debug(
                `Generated RAG queries: ${JSON.stringify(ragQueries)}`,
              );

              // Execute parallel bilingual search with concurrency limit
              const uniqueResults = await executeParallelRagSearch(
                ragQueries,
                hybridSearch,
                {
                  vectorTopK: 5,
                  ftsTopK: 5,
                  rrfK: 60,
                  rerankTopK: 2,
                  ftsColumns: config.ingest.indexing.ftsColumn,
                  maxConcurrency: 2, // Limit concurrent searches to avoid rate limits
                },
              );

              ragSnippets = Array.from(uniqueResults.values()).slice(0, 6); // Cap total context
              logger.debug(`Retrieved ${ragSnippets.length} unique RAG snippets`);
            } catch (err) {
              logger.warn(
                `Context retrieval failed for paragraph ${i}: ${err}`,
              );
            }
          }

          // 2. Ground Truth Retrieval (Web)
          let groundTruthSnippets: string[] = [];
          if (braveSearch) {
            try {
              // Smart Query Generation
              const gtQueries = await generateGroundTruthQueries(
                llmClients.deepseek,
                config.providers.deepseek.model,
                { paragraph: p, storyMetadata: storyMetadataForPipeline, maxQueries: 3 },
              );

              logger.debug(
                `Generated GroundTruth queries: ${JSON.stringify(gtQueries)}`,
              );

              // Execute searches sequentially to be nice to rate limits
              for (const q of gtQueries) {
                const results = await braveSearch.webSearch(q.query, {
                  searchLang: q.searchLang,
                  count: 3,
                });
                // Filter for English/Vietnamese snippets or relevant info
                const snippets = results
                  .slice(0, 2)
                  .map(
                    (r) =>
                      `[${q.category.toUpperCase()}] ${r.title}: ${r.description}`,
                  );
                groundTruthSnippets.push(...snippets);
              }
              // Cap snippets for summarization
              const allSnippets = groundTruthSnippets.slice(0, 10);

              if (allSnippets.length > 0) {
                // Summarize into guidance
                const guidance = await summarizeGroundTruth(
                  llmClients.deepseek,
                  config.providers.deepseek.model,
                  {
                    paragraph: p,
                    searchResults: allSnippets,
                    storyMetadata: storyMetadataForPipeline,
                  },
                );

                // Convert guidance back to snippet strings for the pipeline
                // Note: Ideally pipeline accepts structured guidance, but current prompt uses snippets list
                groundTruthSnippets = [
                  ...guidance.keepOriginal.map((t) => `[Keep Original]: ${t}`),
                  ...Object.entries(guidance.suggestedTranslations).map(
                    ([k, v]) => `[Suggest]: ${k} -> ${v}`,
                  ),
                  ...guidance.culturalNotes.map((n) => `[Culture]: ${n}`),
                  ...(guidance.toneGuidance
                    ? [`[Tone]: ${guidance.toneGuidance}`]
                    : []),
                ];
              } else {
                groundTruthSnippets = [];
              }
            } catch (err) {
              logger.warn(
                `Ground truth retrieval failed for paragraph ${i}: ${err}`,
              );
            }
          }

          const result = await pipeline.run({
            language: args.language,
            source: p,
            metadata: {
              input: path.basename(inputPath),
              chapterTitle:
                (parsedMd.frontmatter["title"] as string | undefined) ??
                "Untitled",
              prevParagraph: paragraphs[i - 1] ?? "",
              nextParagraph: paragraphs[i + 1] ?? "",
              // Pass the last 3 translated paragraphs as context
              prevTranslatedParagraphs: outputs
                .slice(-3)
                .map((o) => o.translation),
            },
            ragSnippets: ragSnippets.map((s, idx) => ({
              id: `rag-${idx}`,
              snippet: s,
            })),
            groundTruthSnippets: groundTruthSnippets.map((s, idx) => ({
              id: `gt-${idx}`,
              snippet: s,
            })),
            existingGlossary: Array.from(glossary.entries()).map(([k, v]) => ({
              source: k,
              target: v,
            })),
          });
          outputs.push({ source: p, translation: result.final.translation });

          // Update dynamic glossary
          if (result.final.glossary && Array.isArray(result.final.glossary)) {
            result.final.glossary.forEach((entry) => {
              if (entry.source && entry.target) {
                glossary.set(entry.source, entry.target);
              }
            });
          }

          // Manual Progress Indicator
          const progress = Math.round(((i + 1) / paragraphs.length) * 100);
          const barLength = 20;
          const filled = Math.round((barLength * progress) / 100);
          const bar = "=".repeat(filled) + "-".repeat(barLength - filled);
          process.stdout.write(
            `\rProgress: [${bar}] ${progress}% (${i + 1}/${paragraphs.length})`,
          );
          if (i === paragraphs.length - 1) process.stdout.write("\n");

          // Incremental Save (Checkpointing)
          if (args.output || args.input) {
            // Append to .part.md file
            await writeFile(
              `${outBase}.part.md`,
              result.final.translation + "\n\n",
              { flag: "a" },
            );

            // Also update the full JSON/MD periodically or at end?
            // For production robustness, we should save the full state to a .checkpoint.json
            const checkpoint = {
              input: path.basename(inputPath),
              language: args.language,
              progress: { current: i + 1, total: paragraphs.length },
              paragraphs: outputs,
              glossary: Array.from(glossary.entries()).map(([k, v]) => ({
                source: k,
                target: v,
              })),
            };
            await writeFile(
              `${outBase}.checkpoint.json`,
              JSON.stringify(checkpoint, null, 2),
              "utf8",
            );
          }
        }

        const mdOut = outputs.map((o) => o.translation).join("\n\n");
        const jsonOut = JSON.stringify(
          {
            input: path.basename(inputPath),
            language: args.language,
            paragraphs: outputs,
          },
          null,
          2,
        );

        if (args.format === "md" || args.format === "both") {
          await writeFile(`${outBase}.md`, mdOut, "utf8");
        }
        if (args.format === "json" || args.format === "both") {
          await writeFile(`${outBase}.json`, jsonOut, "utf8");
        }

        logger.info("Done");
        process.exit(ExitCode.success);
      } catch (error) {
        if (args.debug && error instanceof Error) {
          console.error(error.stack ?? error.message);
        } else {
          console.error(error instanceof Error ? error.message : String(error));
        }
        process.exit(ExitCode.failure);
      }
    });

  // AUTO command - processes all chapters in data/task directory
  program
    .command("auto")
    .description("Discover and optionally translate all chapters in data/task directory")
    .option("-l, --language <name>", "Target language (default: Vietnamese)")
    .option("-o, --output <dir>", "Output directory (default: data/translated)")
    .option("--format <md|json|both>", "Output format", "both")
    .option("--resume", "Resume from checkpoint if available")
    .option("--execute", "Actually translate files (without this flag, only shows what would be done)")
    .option("--continue-on-error", "Continue translating other files if one fails")
    .option("--config <path>", "Path to YAML/JSON config file")
    .option("--verbose", "Verbose logs")
    .option("--debug", "Debug logs (includes stack traces)")
    .action(async (opts) => {
      const parsed = AutoArgsSchema.safeParse(opts);
      if (!parsed.success) {
        console.error(parsed.error.issues.map((i) => i.message).join("\n"));
        process.exit(ExitCode.usage);
      }

      const args = parsed.data;
      const logLevel = args.debug ? "debug" : args.verbose ? "info" : "error";

      try {
        const config = await loadConfig({
          configPath: args.config,
          overrides: { logLevel },
        });
        const logger = createLogger(config);

        // Discover chapters to translate from task directory
        const taskDir = path.join(process.cwd(), config.ingest.taskChaptersPath);
        const taskFiles = await discoverTaskChapters(taskDir);

        if (taskFiles.length === 0) {
          logger.warn(`No chapters found in ${config.ingest.taskChaptersPath}`);
          logger.info("Place chapters to translate in the data/task/ directory");
          process.exit(ExitCode.success);
        }

        logger.info(`Found ${taskFiles.length} chapter(s) to translate`);

        const outDir = args.output ?? config.ingest.translatedChaptersPath;

        for (let fileIdx = 0; fileIdx < taskFiles.length; fileIdx++) {
          const inputPath = taskFiles[fileIdx]!;
          const baseName = path.basename(inputPath);
          
          logger.info(`\n[${ fileIdx + 1}/${taskFiles.length}] Processing: ${baseName}`);

          // Extract story ID from frontmatter or filename
          const parsedMd = await parseMarkdownFile(inputPath);
          const storyId = 
            (parsedMd.frontmatter["story_id"] as string) ||
            (parsedMd.frontmatter["id"] as string) ||
            baseName.replace(/\.[^/.]+$/, "");

          // Load metadata from metadata directory
          const metadataDir = path.join(process.cwd(), config.ingest.metadataPath);
          const storyMeta = await loadStoryMetadata(metadataDir, storyId, inputPath);
          
          if (storyMeta) {
            logger.info(`  Loaded metadata: ${storyMeta.title || storyMeta.id}`);
          } else {
            logger.warn(`  No metadata found for ${storyId}, using frontmatter only`);
          }

          // Run translate command for this file
          // Using spawn to run translate command would be cleaner, but for simplicity
          // we'll just call the same logic inline. For a cleaner solution, refactor
          // the translate logic into a shared function.
          
          const outputPath = path.join(
            process.cwd(),
            outDir,
            `translated_${baseName.replace(/\.[^/.]+$/, "")}`,
          );

          // Log summary
          const paragraphCount = parsedMd.paragraphs.length;
          logger.info(`  Paragraphs: ${paragraphCount}`);
          logger.info(`  Output: ${outputPath}`);
          logger.info(`  Target language: ${storyMeta?.targetLanguage || args.language}`);

          if (!args.execute) {
            // Dry run - just show what would be done
            console.log(`\n  Run: bun dist/index.js translate -i "${inputPath}" -m "${path.join(metadataDir, storyId + ".json")}" --resume`);
            continue;
          }

          // Actually execute translation
          try {
            logger.info(`  Starting translation...`);
            
            // Use spawn to run translate command in a subprocess
            // This ensures proper isolation and error handling
            const { spawn } = await import("node:child_process");
            const metaPath = path.join(metadataDir, storyId + ".json");
            
            const translateArgs = [
              "dist/index.js",
              "translate",
              "-i", inputPath,
              ...(existsSync(metaPath) ? ["-m", metaPath] : []),
              "-l", storyMeta?.targetLanguage || args.language,
              "-o", outputPath,
              "--format", args.format,
              ...(args.resume ? ["--resume"] : []),
              ...(args.verbose ? ["--verbose"] : []),
              ...(args.debug ? ["--debug"] : []),
              ...(args.config ? ["--config", args.config] : []),
            ];

            await new Promise<void>((resolve, reject) => {
              const child = spawn("bun", translateArgs, {
                stdio: "inherit",
                cwd: process.cwd(),
              });

              child.on("close", (code) => {
                if (code === 0) {
                  logger.info(`  ✅ Completed: ${baseName}`);
                  resolve();
                } else {
                  reject(new Error(`Translation failed with exit code ${code}`));
                }
              });

              child.on("error", (err) => {
                reject(err);
              });
            });
          } catch (error) {
            logger.error(`  ❌ Failed: ${baseName} - ${error instanceof Error ? error.message : String(error)}`);
            if (!args.continueOnError) {
              throw error;
            }
          }
        }

        if (args.execute) {
          logger.info("\n✅ Auto translation complete");
        } else {
          logger.info("\n✅ Auto discovery complete");
          logger.info("Run with --execute to actually translate the files");
        }
        process.exit(ExitCode.success);
      } catch (error) {
        if (args.debug && error instanceof Error) {
          console.error(error.stack ?? error.message);
        } else {
          console.error(error instanceof Error ? error.message : String(error));
        }
        process.exit(ExitCode.failure);
      }
    });
}
